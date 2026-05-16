//! `/api/reports/*` — CRUD + live preview for the Reports page.
//!
//! Endpoints:
//!   GET    /api/reports              list current user's reports
//!   POST   /api/reports              create
//!   GET    /api/reports/:rid         fetch one
//!   PUT    /api/reports/:rid         update
//!   PATCH  /api/reports/:rid         sparse metadata update — description /
//!                                    is_public / is_favorite / title /
//!                                    folder. Inline-edit endpoint for the
//!                                    Objects-page Reports tab.
//!   DELETE /api/reports/:rid         delete
//!   POST   /api/reports/preview      run a spec without saving
//!                                    (used by the builder for live preview)
//!   POST   /api/reports/:rid/run     run a saved spec (handy for the
//!                                    viewer; same shape as /preview)
//!
//! Preview / run responses share the redtable's `Page<Row>` shape so
//! the frontend can reuse its rendering code.

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use polars::prelude::DataFrame;
use serde::{Deserialize, Serialize};
use shared::{
    file::Row,
    report::{Report, ReportRequest, ReportSpec},
};
use std::sync::Arc;
use std::time::Instant;

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct ReportsList { items: Vec<Report> }

/// Response from `/preview` and `/:rid/run`. Each section is optional
/// — populated based on the spec's `show_*` toggles. Frontend renders
/// them sequentially (details on top, then grouped subtotals, then a
/// grand-total footer).
#[derive(Serialize)]
struct ReportPage {
    details:   Option<Section>,
    /// Per-leaf-group aggregated rows. The "subtotals" name comes
    /// from the cleaner-app vocabulary the user uses for these.
    subtotals: Option<Section>,
    /// Single grand-total row aligned to `subtotals.columns` shape
    /// (leading nulls for the group-by columns).
    total:     Option<Row>,
    ms:        u32,
}

#[derive(Serialize)]
struct Section {
    columns: Vec<String>,
    rows:    Vec<Row>,
    /// Row count in this section. Equals `rows.len()` (no pagination).
    total:   u64,
}

const DETAIL_ROW_LIMIT: usize = 1000;

/// Preview can pull rows from either a raw source file *or* a saved
/// report's subtotals output. The report path lets dashboard widgets
/// chart already-aggregated data without re-implementing the report's
/// group/filter logic. Exactly one of the two ids must be set.
#[derive(Deserialize)]
struct PreviewBody {
    #[serde(default)]
    source_file_id:   Option<String>,
    #[serde(default)]
    source_report_id: Option<String>,
    spec:             ReportSpec,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",              get(list).post(create))
        .route("/preview",       post(preview))
        .route("/:rid",          get(get_one).put(update).patch(patch_one).delete(delete_one))
        .route("/:rid/run",      post(run_saved))
        .route("/:rid/favorite", post(set_favorite))
}

#[derive(Deserialize)]
struct PatchReportBody {
    #[serde(default)] title:       Option<String>,
    #[serde(default)] description: Option<String>,
    #[serde(default)] folder:      Option<String>,
    #[serde(default)] is_favorite: Option<bool>,
    #[serde(default)] is_public:   Option<bool>,
}

// Sparse PATCH for inline-editable Reports-tab cells. Each field is
// optional; unsent fields are kept via COALESCE in db::patch_report_meta.
// Empty title is dropped (it's required); empty description/folder are
// dropped too (use a dedicated null-clear endpoint if/when that lands).
async fn patch_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchReportBody>,
) -> Result<Json<Report>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::report_owner(&state.db, &rid).await, &user, "report", &rid)?;
    let report = db::patch_report_meta(
        &state.db, &rid,
        body.title.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.description.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.folder.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.is_favorite,
        body.is_public,
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", format!("report {rid}")))?;
    Ok(Json(report))
}

#[derive(Deserialize)]
struct FavoriteBody { value: bool }

async fn set_favorite(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<FavoriteBody>,
) -> Result<Json<Report>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::report_owner(&state.db, &rid).await, &user, "report", &rid)?;
    let report = db::set_report_favorite(&state.db, &rid, body.value).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("report {rid}")))?;
    Ok(Json(report))
}

async fn list(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
) -> Result<Json<ReportsList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_reports(&state.db, &user)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(ReportsList { items }))
}

async fn create(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Json(req):    Json<ReportRequest>,
) -> Result<Json<Report>, AppError> {
    // Resolve the project from the source file so we don't trust the
    // client. Phase 4c also gates on the source file's owner so a user
    // can't author a report against someone else's file.
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(
        db::file_owner(&state.db, &req.source_file_id).await,
        &user, "file", &req.source_file_id,
    )?;
    let file = db::find_file(&state.db, &req.source_file_id).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", "source file"))?;

    let rid = id::new("RPT");
    let report = db::insert_report(
        &state.db, &rid, &file.summary.project_redpash_id,
        &req.source_file_id, &req.title, &req.spec,
        req.folder.as_deref().filter(|s| !s.is_empty()),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(report))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Report>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::report_owner(&state.db, &rid).await, &user, "report", &rid)?;
    let report = db::find_report(&state.db, &rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("report {rid}")))?;
    Ok(Json(report))
}

async fn update(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<ReportRequest>,
) -> Result<Json<Report>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::report_owner(&state.db, &rid).await, &user, "report", &rid)?;
    // The source file may have changed — re-check ownership on the
    // new file too, or a user could re-point their report at someone
    // else's data.
    super::ensure_owner(
        db::file_owner(&state.db, &req.source_file_id).await,
        &user, "file", &req.source_file_id,
    )?;
    let report = db::update_report(
        &state.db, &rid, &req.title, &req.spec, &req.source_file_id,
        req.folder.as_deref().filter(|s| !s.is_empty()),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", format!("report {rid}")))?;
    Ok(Json(report))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<axum::http::StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::report_owner(&state.db, &rid).await, &user, "report", &rid)?;
    let removed = db::delete_report(&state.db, &rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(if removed { axum::http::StatusCode::NO_CONTENT } else { axum::http::StatusCode::NOT_FOUND })
}

async fn preview(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Json(body):   Json<PreviewBody>,
) -> Result<Json<ReportPage>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // Gate on whichever id is supplied. resolve_source_frame returns
    // a 400 if neither is set; we just guard the ones that are.
    if let Some(fid) = body.source_file_id.as_deref().filter(|s| !s.is_empty()) {
        super::ensure_owner(db::file_owner(&state.db, fid).await, &user, "file", fid)?;
    }
    if let Some(rid) = body.source_report_id.as_deref().filter(|s| !s.is_empty()) {
        super::ensure_owner(db::report_owner(&state.db, rid).await, &user, "report", rid)?;
    }
    let frame = resolve_source_frame(&state, &body.source_file_id, &body.source_report_id).await?;
    run_spec_on_frame(frame, &body.spec).await
}

async fn run_saved(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<ReportPage>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::report_owner(&state.db, &rid).await, &user, "report", &rid)?;
    let report = db::find_report(&state.db, &rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("report {rid}")))?;
    let entry = super::files::hydrate(&state, &report.source_file_id).await?;
    run_spec_on_frame(Arc::clone(&entry.frame), &report.spec).await
}

/// Resolve a widget/preview source descriptor down to a DataFrame.
///
/// * `source_file_id` → hydrate the raw CSV (with any applied cleaner
///   steps replayed).
/// * `source_report_id` → hydrate the report's underlying file, run the
///   report's saved spec, and return its subtotals frame. The caller's
///   spec then runs *on top of* that aggregated shape — letting a chart
///   re-slice or a KPI roll up over the report's output.
async fn resolve_source_frame(
    state:            &AppState,
    source_file_id:   &Option<String>,
    source_report_id: &Option<String>,
) -> Result<Arc<DataFrame>, AppError> {
    if let Some(fid) = source_file_id.as_ref().filter(|s| !s.is_empty()) {
        let entry = super::files::hydrate(state, fid).await?;
        return Ok(Arc::clone(&entry.frame));
    }
    if let Some(rid) = source_report_id.as_ref().filter(|s| !s.is_empty()) {
        let report = db::find_report(&state.db, rid).await
            .map_err(|e| AppError::internal("db", e.to_string()))?
            .ok_or_else(|| AppError::not_found("not_found", format!("report {rid}")))?;
        let entry = super::files::hydrate(state, &report.source_file_id).await?;
        let base  = Arc::clone(&entry.frame);
        let spec  = report.spec.clone();
        let sub = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
            data::group_by::execute(&base, &spec)
        })
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
        return Ok(Arc::new(sub));
    }
    Err(AppError::bad_request("missing_source", "source_file_id or source_report_id required"))
}

/// Shared driver: take an already-resolved DataFrame and run up to
/// three Polars queries (details, subtotals, grand total) based on the
/// spec's `show_*` flags. Each section is returned independently so the
/// frontend can render or skip them.
async fn run_spec_on_frame(
    frame: Arc<DataFrame>,
    spec:  &ReportSpec,
) -> Result<Json<ReportPage>, AppError> {
    let spec_owned = spec.clone();
    let group_by_n      = spec_owned.group_by.len();
    let group_by_cols_n = spec_owned.group_by_cols.len();
    // Subtotals table has `group_by + group_by_cols` leading columns
    // before the agg cells — the grand total row needs that many nulls
    // up front to line up.
    let total_lead      = group_by_n + group_by_cols_n;
    // Details are heavy (raw rows up to DETAIL_ROW_LIMIT) so we still
    // honour `show_details` to skip the work when nothing wants them.
    let want_details = spec_owned.show_details;
    // Subtotals + total are always materialized when grouping is
    // defined — the same work the spec already implies. Client surfaces
    // (report viewer, dashboards, html export) then decide independently
    // which sections to render; `show_subtotals` / `show_total` become
    // display-only flags on the viewer side.
    let want_subtotals = !spec_owned.group_by.is_empty()
        || !spec_owned.group_by_cols.is_empty()
        || !spec_owned.aggregations.is_empty();
    let want_total     = total_lead > 0;

    let start = Instant::now();
    let (details, subtotals, total) =
        tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
            // Subtotals = the existing group_by execution.
            let subtotals = if want_subtotals {
                Some(data::group_by::execute(&frame, &spec_owned)?)
            } else { None };

            // Details = filtered source rows, sorted by group_by cols
            // when present. Capped at DETAIL_ROW_LIMIT to keep the wire
            // payload sane; the user drills down for the full picture.
            let details = if want_details {
                let filter_json = spec_owned.filter
                    .as_ref()
                    .map(|v| serde_json::to_string(v).unwrap_or_default())
                    .unwrap_or_default();
                let mut df = data::parse::apply_filter((*frame).clone(), &filter_json)?;
                if !spec_owned.group_by.is_empty() {
                    // Eager sort — see group_by::execute for why we
                    // avoid the lazy sort path.
                    let by: Vec<String> = spec_owned.group_by.clone();
                    df = df.sort(by, polars::prelude::SortMultipleOptions::default())?;
                    // Promote the group_by columns to the front so the
                    // frontend can render rowspan'd group cells in the
                    // leading columns.
                    let all_names: Vec<String> = df.get_columns().iter()
                        .map(|c| c.name().to_string()).collect();
                    let mut ordered: Vec<String> = spec_owned.group_by.clone();
                    for n in all_names {
                        if !ordered.contains(&n) { ordered.push(n); }
                    }
                    let refs: Vec<&str> = ordered.iter().map(|s| s.as_str()).collect();
                    df = df.select(refs)?;
                }
                if df.height() > DETAIL_ROW_LIMIT {
                    df = df.slice(0, DETAIL_ROW_LIMIT);
                }
                Some(df)
            } else { None };

            let total = if want_total {
                let mut grand = spec_owned.clone();
                grand.group_by.clear();
                grand.group_by_cols.clear();
                // The grand-total frame has only aggregation columns —
                // no group-by columns to sort by — so any user sort
                // (which references the original column names) would
                // fail with "column not found". Strip it.
                grand.sort.clear();
                Some(data::group_by::execute(&frame, &grand)?)
            } else { None };

            Ok((details, subtotals, total))
        })
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
    let ms = start.elapsed().as_millis() as u32;

    let details_section   = details.as_ref().map(|d| make_section(d)).transpose()?;
    let subtotals_section = subtotals.as_ref().map(|s| make_section(s)).transpose()?;
    let total_row         = total.map(|t| total_row_aligned(&t, total_lead)).transpose()?;

    Ok(Json(ReportPage {
        details:   details_section,
        subtotals: subtotals_section,
        total:     total_row,
        ms,
    }))
}

fn make_section(df: &DataFrame) -> Result<Section, AppError> {
    let (rows, columns) = stringify(df)?;
    Ok(Section { columns, total: rows.len() as u64, rows })
}

/// Stretch a single-row DataFrame across `group_by_n` leading nulls so
/// the grand-total row aligns with the main result's column order
/// (group-by columns first, then aggregations).
fn total_row_aligned(df: &DataFrame, group_by_n: usize) -> Result<Row, AppError> {
    let mut row: Row = vec![None; group_by_n];
    for c in df.get_columns() {
        let v = c.get(0).map_err(|e| AppError::internal("polars", e.to_string()))?;
        row.push(av_to_owned(v));
    }
    Ok(row)
}

fn av_to_owned(v: polars::prelude::AnyValue) -> Option<String> {
    use polars::prelude::AnyValue;
    match v {
        AnyValue::Null           => None,
        AnyValue::String(s)      => Some((*s).to_string()),
        AnyValue::StringOwned(s) => Some(s.to_string()),
        other                    => Some(other.to_string()),
    }
}

fn stringify(df: &DataFrame) -> Result<(Vec<Row>, Vec<String>), AppError> {
    let names: Vec<String> = df.get_columns().iter().map(|c| c.name().to_string()).collect();
    let mut rows: Vec<Row> = Vec::with_capacity(df.height());
    for r in 0..df.height() {
        let mut row: Row = Vec::with_capacity(df.width());
        for c in df.get_columns() {
            let v = c.get(r).map_err(|e| AppError::internal("polars", e.to_string()))?;
            row.push(av_to_owned(v));
        }
        rows.push(row);
    }
    Ok((rows, names))
}
