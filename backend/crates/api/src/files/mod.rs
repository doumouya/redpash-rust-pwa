//! Purpose: /api/files/* — the upload → page → clean → export flow, plus the
//! data-work endpoints (sql, joins) as submodules sharing the frame cache.
//! Every handler gates with rbac::require_action (View reads, Edit mutations);
//! upload + materialize gate Create-reach on the project inside the sealed
//! pipeline. Reads never write back to the DB (the predecessor's read-path
//! stat write-back race is designed out — stats refresh only on mutation).

mod joins;
mod sql;

use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use shared::query::QuerySpec;

use crate::{
    db,
    error::AppError,
    pipeline,
    rbac::{self, Action, Caller},
    state::{AppState, FileEntry},
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(upload))
        .route("/:rid", get(summary).patch(rename))
        // GET = whole-file window (back-compat); POST = server-side filtered
        // window over the SAME canonical FilterNode the client engine uses.
        .route("/:rid/page", get(page).post(page_post))
        .route("/:rid/steps", get(list_steps).post(add_step))
        .route("/:rid/steps/preview", post(steps_preview))
        .route("/:rid/steps/batch", post(add_steps_batch))
        .route("/:rid/undo", post(undo))
        .route("/:rid/redo", post(redo))
        .route("/:rid/export", get(export))
        // data-work endpoints (submodules; share hydrate + the cache)
        .route("/:rid/sql", post(sql::run))
        .route("/:rid/sql/materialize", post(sql::materialize))
        .route("/:rid/joins", get(joins::detect))
        .route("/:rid/joins", post(joins::execute))
}

// ─── list (View; reach-scoped) ──────────────────────────────────────────

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default = "default_list_limit")]
    limit: usize,
}
fn default_list_limit() -> usize {
    50
}

/// GET /api/files — the caller's reachable CSV files, newest first. Reach =
/// membership (via the principal closure) on the file, its project, or the
/// project's company. Admin → all. Powers Home recents + the Workspace rail.
async fn list(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };
    let limit = q.limit.clamp(1, 200) as i64;
    let rows: Vec<(String, String, String, String, Option<i64>, Option<i32>, Option<f32>, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            "SELECT pf.redpash_id, pf.filename, pf.project_id, p.name, pf.row_count, pf.col_count,
                    pf.cleanness_pct, pf.created_at
             FROM project_files pf
             JOIN projects p ON p.redpash_id = pf.project_id
             WHERE pf.file_type = 'csv'
               AND ($1::text[] IS NULL OR EXISTS (
                   SELECT 1 FROM memberships m
                   WHERE m.member_redpash_id = ANY($1)
                     AND m.object_redpash_id IN (pf.redpash_id, pf.project_id, p.company_id)))
             ORDER BY pf.created_at DESC LIMIT $2",
        )
        .bind(viewer.as_deref())
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(rid, filename, project_id, project_name, rows, cols, cleanness, created_at)| {
            serde_json::json!({
                "rid": rid, "filename": filename,
                "project_id": project_id, "project_name": project_name,
                "rows": rows, "cols": cols, "cleanness": cleanness,
                "created_at": created_at.to_rfc3339(),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

// ─── upload ──────────────────────────────────────────────────────────────

async fn upload(
    State(state): State<AppState>,
    caller: Caller,
    mut mp: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut bytes: Option<Vec<u8>> = None;
    let mut filename = "upload.csv".to_string();
    let mut project: Option<String> = None;
    let mut tld: Option<String> = None;

    while let Some(field) = mp.next_field().await.map_err(|e| AppError::bad_request("multipart", e.to_string()))? {
        match field.name().unwrap_or("") {
            "file" => {
                if let Some(fname) = field.file_name() {
                    filename = fname.to_string();
                }
                bytes = Some(
                    field.bytes().await.map_err(|e| AppError::bad_request("multipart", e.to_string()))?.to_vec(),
                );
            }
            "project" => project = Some(field.text().await.unwrap_or_default()),
            "tld" => tld = Some(field.text().await.unwrap_or_default()),
            _ => {}
        }
    }

    let bytes = bytes.ok_or_else(|| AppError::bad_request("no_file", "multipart field `file` is required"))?;
    let project = match project.filter(|p| !p.is_empty()) {
        Some(p) => p,
        None => db::ensure_default_project(&state.db, &caller.rid).await?,
    };

    let outcome = pipeline::upload_csv(
        &state.db,
        &state.type_cache,
        &state.data_dir,
        &caller.rid,
        caller.is_platform_admin,
        &project,
        &filename,
        bytes,
        tld,
    )
    .await?;

    state.files.insert(
        outcome.rid.clone(),
        FileEntry {
            columns: outcome.columns.clone(),
            cleanness: outcome.cleanness,
            frame: Arc::new(outcome.frame),
        },
    );

    Ok(Json(serde_json::json!({
        "rid": outcome.rid,
        "filename": outcome.filename,
        "encoding": outcome.encoding,
        "cleanness": outcome.cleanness,
        "columns": outcome.columns,
        "fully_null_rows": outcome.fully_null_rows,
        "size_bytes": outcome.size_bytes,
    })))
}

// ─── summary / page (View) ──────────────────────────────────────────────

async fn summary(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let entry = hydrate(&state, &rid).await?;
    Ok(Json(serde_json::json!({
        "rid": rid,
        "rows": entry.frame.height(),
        "cols": entry.frame.width(),
        "cleanness": entry.cleanness,
        "columns": entry.columns,
    })))
}

// rename (Edit) — the rail's inline file rename. Edit-gated like the other
// mutating handlers; metadata-only, so it never touches the frame cache.
async fn rename(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    let filename = body
        .get("filename")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::bad_request("filename_required", "filename must be a non-empty string"))?;
    sqlx::query("UPDATE project_files SET filename = $1 WHERE redpash_id = $2")
        .bind(filename)
        .bind(&rid)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "rid": rid, "filename": filename })))
}

#[derive(Deserialize)]
struct PageQuery {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}
fn default_limit() -> usize {
    100
}

async fn page(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Query(q): Query<PageQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let entry = hydrate(&state, &rid).await?;
    let limit = q.limit.min(data::ROW_CAP);
    let p = data::view::page(&entry.frame, q.offset, limit);
    Ok(Json(serde_json::json!({
        "columns": p.columns,
        "rows": p.rows,
        "total": p.total,
        "offset": q.offset,
    })))
}

/// POST /:rid/page — a server-side FILTERED + SEARCHED + SORTED window. Body =
/// the canonical `shared::QuerySpec` (`filter?` tree, `search?` free-text,
/// `sort?` keys) flattened with `offset`/`limit`. The query is the SAME shape
/// the wasm `Workbook.view` consumes, applied in the SAME order — (filter AND
/// search) → sort → page — so a server window is byte-identical to a client one.
/// `total` is the post-(filter+search) row count (sort never changes it), so the
/// over-cap fallback paginates the reduced set. An empty query returns the whole
/// file — identical to the GET page. Compiles + collects in spawn_blocking
/// (native polars must not run on the async runtime thread).
#[derive(Deserialize)]
struct PageBody {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(flatten)]
    query: QuerySpec,
}

async fn page_post(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<PageBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let entry = hydrate(&state, &rid).await?;
    let limit = body.limit.min(data::ROW_CAP);
    let offset = body.offset;
    let frame = entry.frame.clone();
    let query = body.query;

    let p = tokio::task::spawn_blocking(move || -> Result<data::view::Page, data::DataError> {
        // (filter AND search) → sort → page, reading by reference so a window
        // with no row-shaping clones nothing (`frame` is an `Arc<DataFrame>`).
        // Each applied stage materialises one owned frame; the skip arms fall
        // through to the prior `&`. The order matches the wasm `Workbook.view`
        // so a server window is byte-identical to a client one.
        let base = &*frame;
        let filtered =
            match data::search::effective_filter(base, query.filter.as_ref(), query.search.as_deref()) {
                Some(f) => Some(data::filter::apply_filter(base, &f)?),
                None => None,
            };
        let after_filter = filtered.as_ref().unwrap_or(base);
        let sorted = if query.sort.is_empty() {
            None
        } else {
            Some(data::sort::apply_sort(after_filter, &query.sort)?)
        };
        let out = sorted.as_ref().unwrap_or(after_filter);
        Ok(data::view::page(out, offset, limit))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    Ok(Json(serde_json::json!({
        "columns": p.columns,
        "rows": p.rows,
        "total": p.total,
        "offset": offset,
    })))
}

// ─── steps (Edit; list is View) ────────────────────────────────────────────

/// GET /:rid/steps — the full step history (applied + undone) so the cleaning
/// timeline renders the replay model truthfully; canUndo/canRedo derive from
/// the applied flags.
async fn list_steps(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let rows: Vec<(String, serde_json::Value, bool, i32, Option<f32>)> = sqlx::query_as(
        "SELECT kind, params, applied, ordinal, cleanness FROM project_steps
         WHERE file_id = $1 ORDER BY ordinal",
    )
    .bind(&rid)
    .fetch_all(&state.db)
    .await?;
    // The genesis ("original") is a baseline marker, not a cleaning step: pinned
    // (always applied), excluded everywhere a "real cleaning step" is meant — else
    // can_undo is wrong and the steps panel shows a phantom row on untouched files.
    // Keyed by kind (not ordinal) so it's also correct for pre-migration files.
    // Its score rides out separately as baseline_cleanness (the upload score).
    let baseline_cleanness = rows
        .iter()
        .find(|(kind, _, _, _, _)| kind == "original")
        .and_then(|(_, _, _, _, c)| *c);
    let can_undo = rows.iter().any(|(kind, _, applied, _, _)| *applied && kind != "original");
    let can_redo = rows.iter().any(|(_, _, applied, _, _)| !*applied);
    let steps: Vec<serde_json::Value> = rows
        .into_iter()
        .filter(|(kind, _, _, _, _)| kind != "original")
        .map(|(kind, params, applied, ordinal, cleanness)| {
            serde_json::json!({ "kind": kind, "params": params, "applied": applied, "ordinal": ordinal, "cleanness": cleanness })
        })
        .collect();
    Ok(Json(serde_json::json!({ "steps": steps, "can_undo": can_undo, "can_redo": can_redo, "baseline_cleanness": baseline_cleanness })))
}

#[derive(Deserialize)]
struct StepBody {
    kind: String,
    #[serde(default)]
    params: serde_json::Value,
}

async fn add_step(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<StepBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    // Pre-flight: apply to the current frame BEFORE persisting so a poisoned
    // step can never make the file un-hydratable. The same pass scores the
    // result, so the step record stores the cleanness AS OF this step.
    let entry = hydrate(&state, &rid).await?;
    let base = (*entry.frame).clone();
    let kind = body.kind.clone();
    let params = body.params.clone();
    let cleanness = tokio::task::spawn_blocking(move || -> Result<Option<f32>, data::DataError> {
        let result = data::steps::apply(base, &kind, &params)?;
        let cols = data::dtype::summarize(&result)?;
        Ok(data::stats::cleanness(&result, &cols, &[]))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    db::add_step(&state.db, &rid, &body.kind, &body.params, cleanness).await?;
    refresh(&state, &rid).await
}

/// POST /:rid/steps/preview — apply the posted (not-yet-saved) steps on top of the
/// committed frame and return the resulting page, WITHOUT persisting. The workspace's
/// staging preview: apply = preview here, Save = `add_step` (commit). Same engine + order
/// as a real apply (`data::steps::apply` over the replayed base), so the preview is
/// byte-identical to what Save will produce. View-gated — read-only; the commit path
/// (`add_step`) is the one that gates Edit.
/// Bound the staged chain a single preview or batch-commit may carry. Each posted
/// step runs `apply` over the hydrated frame on the shared blocking pool, so an
/// unbounded chain is a CPU-amplification surface (preview is View-gated, the
/// lowest tier). The real staging UI pushes one op at a time; 256 is comfortably
/// above any human session and well below abuse.
const STAGED_STEP_CAP: usize = 256;

#[derive(Deserialize)]
struct PreviewBody {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    steps: Vec<StepBody>,
}

async fn steps_preview(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<PreviewBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    // Bound the work a read-tier caller can drive on the shared blocking pool.
    if body.steps.len() > STAGED_STEP_CAP {
        return Err(AppError::bad_request(
            "too_many_steps",
            format!("preview accepts at most {STAGED_STEP_CAP} pending steps"),
        ));
    }
    let entry = hydrate(&state, &rid).await?;
    let base = (*entry.frame).clone();
    let (offset, limit) = (body.offset, body.limit.min(data::ROW_CAP));
    let steps = body.steps;
    let p = tokio::task::spawn_blocking(move || -> Result<data::view::Page, data::DataError> {
        let mut frame = base;
        for s in &steps {
            frame = data::steps::apply(frame, &s.kind, &s.params)?;
        }
        Ok(data::view::page(&frame, offset, limit))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;
    Ok(Json(serde_json::json!({
        "columns": p.columns,
        "rows": p.rows,
        "total": p.total,
        "offset": offset,
    })))
}

#[derive(Deserialize)]
struct BatchBody {
    #[serde(default)]
    steps: Vec<StepBody>,
}

/// POST /:rid/steps/batch — commit the staged buffer as ONE atomic gesture (the
/// cleaner's Save). Pre-flights the WHOLE chain over the hydrated frame, so an
/// invalid step rejects the entire Save before anything persists — vs N separate
/// /steps calls that can leave a partial commit on a mid-chain failure. Scores
/// each step's cleanness AS OF that step, then commits all N in one tx
/// (`db::add_steps`). Edit-gated like `add_step`. Empty buffer = no-op.
async fn add_steps_batch(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<BatchBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    if body.steps.is_empty() {
        return refresh(&state, &rid).await; // nothing staged → current state, no commit
    }
    if body.steps.len() > STAGED_STEP_CAP {
        return Err(AppError::bad_request(
            "too_many_steps",
            format!("a batch commits at most {STAGED_STEP_CAP} steps"),
        ));
    }
    let entry = hydrate(&state, &rid).await?;
    let base = (*entry.frame).clone();
    let steps = body.steps;
    // Pre-flight the whole chain: apply each step in order, scoring the result AS
    // OF that step. ANY failure aborts the Save with nothing persisted (atomic);
    // success yields the (kind, params, cleanness) rows to commit in one tx.
    let scored = tokio::task::spawn_blocking(
        move || -> Result<Vec<(String, serde_json::Value, Option<f32>)>, data::DataError> {
            let mut frame = base;
            let mut out = Vec::with_capacity(steps.len());
            for s in &steps {
                frame = data::steps::apply(frame, &s.kind, &s.params)?;
                let cols = data::dtype::summarize(&frame)?;
                let cleanness = data::stats::cleanness(&frame, &cols, &[]);
                out.push((s.kind.clone(), s.params.clone(), cleanness));
            }
            Ok(out)
        },
    )
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    db::add_steps(&state.db, &rid, &scored).await?;
    refresh(&state, &rid).await
}

async fn undo(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    db::undo_step(&state.db, &rid).await?;
    refresh(&state, &rid).await
}

async fn redo(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    db::redo_step(&state.db, &rid).await?;
    refresh(&state, &rid).await
}

// ─── export (View) ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ExportQuery {
    #[serde(default = "default_format")]
    format: String,
}
fn default_format() -> String {
    "csv".into()
}

async fn export(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Query(q): Query<ExportQuery>,
) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let entry = hydrate(&state, &rid).await?;
    let frame = (*entry.frame).clone();
    let fmt = q.format.clone();
    let (bytes, content_type, ext) = tokio::task::spawn_blocking(move || match fmt.as_str() {
        "xlsx" => data::export::to_xlsx(&frame)
            .map(|b| (b, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx")),
        "json" => data::export::to_json(&frame).map(|b| (b, "application/json", "json")),
        _ => data::export::to_csv(&frame).map(|b| (b, "text/csv", "csv")),
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    let headers = [
        (axum::http::header::CONTENT_TYPE, content_type.to_string()),
        (axum::http::header::CONTENT_DISPOSITION, format!("attachment; filename=\"{rid}.{ext}\"")),
    ];
    Ok((headers, bytes).into_response())
}

// ─── cache + single-flight hydration (pub(crate) — sql/joins/group reuse) ───

/// Get the file's parsed frame from cache, hydrating on miss. Single-flight per
/// rid; read-only (never writes the DB).
pub(crate) async fn hydrate(state: &AppState, rid: &str) -> Result<FileEntry, AppError> {
    if let Some(e) = state.files.get(rid) {
        return Ok(e.clone());
    }
    let lock = state
        .hydrating
        .entry(rid.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let _guard = lock.lock().await;
    if let Some(e) = state.files.get(rid) {
        return Ok(e.clone());
    }

    let meta = db::find_file(&state.db, rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?;
    if meta.file_type != "csv" {
        return Err(AppError::bad_request("not_a_data_file", "file is not a CSV data file"));
    }
    let path = state.file_path(rid);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::internal("io", format!("read {}: {e}", path.display())))?;
    let steps = db::applied_steps(&state.db, rid).await?;
    let (frame, columns, cleanness) =
        tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
            let (base, _diag, _enc) = data::parse::from_csv_bytes(&bytes, None)?;
            let frame = data::steps::replay(base, &steps)?;
            let columns = data::dtype::summarize(&frame)?;
            let cleanness = data::stats::cleanness(&frame, &columns, &[]);
            Ok((frame, columns, cleanness))
        })
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;

    let entry = FileEntry { columns, cleanness, frame: Arc::new(frame) };
    state.files.insert(rid.to_string(), entry.clone());
    Ok(entry)
}

/// After a mutation: evict + re-hydrate, refresh DB stats, return the summary.
async fn refresh(state: &AppState, rid: &str) -> Result<Json<serde_json::Value>, AppError> {
    state.files.remove(rid);
    let entry = hydrate(state, rid).await?;
    let columns_json = serde_json::to_value(&entry.columns)
        .map_err(|e| AppError::internal("serialize", e.to_string()))?;
    db::update_file_stats(
        &state.db,
        rid,
        entry.frame.height() as i64,
        entry.frame.width() as i32,
        entry.cleanness,
        &columns_json,
    )
    .await?;
    Ok(Json(serde_json::json!({
        "rid": rid,
        "rows": entry.frame.height(),
        "cols": entry.frame.width(),
        "cleanness": entry.cleanness,
        "columns": entry.columns,
    })))
}
