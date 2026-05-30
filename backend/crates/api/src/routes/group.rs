//! Doc: docs/internal/code/backend/api/routes/group.md
//! `/api/group/preview` — the stateless grouping engine.
//!
//! Takes a source file id + a grouping spec, runs up to three Polars
//! queries (details, subtotals, grand total), and returns each section
//! independently. Stateless — nothing is stored; the Designer and
//! dashboard widgets call it for live preview.
//!
//! Was `/api/reports/*`. The object-model hard-refresh removed the
//! stored-Report CRUD — "Report" is a derived view over a project's
//! chart files, not an entity — leaving only this grouping engine,
//! renamed honest.
//!
//! The response shares the redtable's `Row` shape so the frontend can
//! reuse its rendering code.

use axum::{extract::State, routing::post, Json, Router};
use polars::prelude::DataFrame;
use serde::{Deserialize, Serialize};
use shared::{file::Row, report::ReportSpec};
use std::sync::Arc;
use std::time::Instant;

use crate::{db, error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/preview", post(preview))
}

/// Response from `/preview`. Each section is optional — populated based
/// on the spec's `show_*` toggles. Frontend renders them sequentially
/// (details on top, then grouped subtotals, then a grand-total footer).
#[derive(Serialize)]
struct GroupPage {
    details:   Option<Section>,
    /// Per-leaf-group aggregated rows. The "subtotals" name comes from
    /// the cleaner-app vocabulary the user uses for these.
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

/// Preview body — a source file plus the grouping spec to run on it.
#[derive(Deserialize)]
struct PreviewBody {
    source_file_id: String,
    spec:           ReportSpec,
}

async fn preview(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Json(body):   Json<PreviewBody>,
) -> Result<Json<GroupPage>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(
        db::file_owner(&state.db, &body.source_file_id).await,
        &user, "file", &body.source_file_id,
    )?;
    let entry = super::files::hydrate(&state, &body.source_file_id).await?;
    run_spec_on_frame(Arc::clone(&entry.frame), &body.spec).await
}

/// Take an already-resolved DataFrame and run up to three Polars
/// queries (details, subtotals, grand total) based on the spec's
/// `show_*` flags. Each section is returned independently so the
/// frontend can render or skip them.
async fn run_spec_on_frame(
    frame: Arc<DataFrame>,
    spec:  &ReportSpec,
) -> Result<Json<GroupPage>, AppError> {
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
    // then decide independently which sections to render.
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

    Ok(Json(GroupPage {
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
