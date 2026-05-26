//! `/api/files/*` — upload, summary, paged rows, steps.
//!
//! Persistence model:
//!   • Bytes      → `<data_dir>/files/<rid>.bin` (immutable).
//!   • Metadata   → `project_files` row.
//!   • History    → `project_steps` rows (append-only, `applied` toggled
//!                  by undo/redo, redo stack cleared on new step).
//!   • Hot frame  → in-memory cache; cache miss replays all applied
//!                  steps on top of the freshly-parsed base.
//!
//! Endpoints:
//!   POST   /api/files/upload          multipart: `file` (+ opt `tld`)
//!   GET    /api/files/:rid            summary + columns + steps
//!   GET    /api/files/:rid/page?…     paged rows (sort/filter/search)
//!   POST   /api/files/:rid/steps      { kind, params } → apply
//!   POST   /api/files/:rid/undo       no-op if no applied steps
//!   POST   /api/files/:rid/redo       no-op if no undone steps

use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::Serialize;
use shared::{
    file::{ColumnMeta, FileSummary, PageQuery},
    step::{ProjectStep, StepRequest},
    Page,
};
use std::{sync::Arc, time::Instant};

use crate::{db, error::AppError, id, state::{AppState, FileEntry}};

const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

#[derive(Serialize)]
struct FileEnvelope {
    summary: FileSummary,
    columns: Vec<ColumnMeta>,
    steps:   Vec<ProjectStep>,
}

/// Returned by `POST /steps` — the regular FileEnvelope fields, plus
/// per-step metrics the frontend uses to surface "filled 47 nulls" or
/// "replaced 12 cells" in the success toast.
#[derive(Serialize)]
struct StepResult {
    rows_before:   u64,
    rows_after:    u64,
    /// Populated for cell-level ops (fill_nulls, replace_text,
    /// change_case, fix_invalid). `None` when the step changes row
    /// count (cell diff isn't meaningful) or is structural.
    cells_changed: Option<u64>,
}

#[derive(Serialize)]
struct AddStepResponse {
    summary: FileSummary,
    columns: Vec<ColumnMeta>,
    steps:   Vec<ProjectStep>,
    last_op: StepResult,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",          get(list_all))
        .route("/upload",    post(upload))
        .route("/:rid",      get(get_summary).patch(patch_file).delete(delete_file))
        .route("/:rid/page", get(get_page))
        .route("/:rid/steps",    post(add_step))
        .route("/:rid/cast-preview", post(cast_preview))
        .route("/:rid/undo",     post(undo))
        .route("/:rid/redo",     post(redo))
        .route("/:rid/clear-filters", post(clear_filters))
        .route("/:rid/encoding", post(set_encoding))
        .route("/:rid/dedup",    get(dedup))
        .route("/:rid/joins",    get(joins).post(create_join))
        .route("/:rid/snapshot",  post(snapshot))
        .route("/:rid/uniques",   get(uniques))
        .route("/:rid/sentinels", get(sentinels))
        .route("/:rid/export",    get(export))
        .route("/:rid/cleanness", post(compute_cleanness).delete(clear_cleanness))
}

#[derive(Serialize)]
struct FilesList { items: Vec<FileSummary> }

/// `GET /api/files` — every file the session user owns, across all
/// their projects. Powers the home page's "My Files" step.
#[tracing::instrument(skip_all)]
async fn list_all(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
) -> Result<Json<FilesList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_user_files(&state.db, &user)
        .await?;
    Ok(Json(FilesList { items }))
}

#[tracing::instrument(skip_all)]
async fn upload(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<FileEnvelope>), AppError> {
    // Resolve the uploading user *first* so the file lands in their
    // own default project — not the bootstrap dev_user's workspace.
    let user = super::resolve_user_rid(&state, &headers).await?;

    let mut bytes: Option<Vec<u8>> = None;
    // `original_filename` keeps the full upload name (with extension)
    // so `is_excel_filename` below can route Excel-family uploads
    // through xlsx_to_csv. The DB-bound `filename` (set just before
    // insert) is the stripped stem — mig 011 made `project_files.filename`
    // hold the user-facing name without the extension; `file_type`
    // owns the extension half.
    let mut original_filename = "upload.csv".to_string();
    let mut tld_hint:     Option<String> = None;
    let mut project_name: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request("multipart", e.to_string()))?
    {
        match field.name() {
            Some("file") => {
                if let Some(fname) = field.file_name() { original_filename = fname.to_string(); }
                let data = field.bytes().await
                    .map_err(|e| AppError::bad_request("multipart", e.to_string()))?;
                if data.len() > MAX_UPLOAD_BYTES {
                    return Err(AppError::bad_request("too_large", "file exceeds 256 MiB"));
                }
                bytes = Some(data.to_vec());
            }
            Some("tld") => {
                tld_hint = field.text().await.ok()
                    .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            }
            // The workspace rail sends `project_name` so uploads route
            // into the focused project (find-or-create) instead of
            // pooling every file into the user's default "Workspace".
            // Empty / whitespace strings fall through to the default.
            Some("project_name") => {
                project_name = field.text().await.ok()
                    .map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            }
            _ => {}
        }
    }

    // Pick destination project AFTER all fields are read so we don't care
    // about field order (multipart is single-pass and the JS form appends
    // file + project_name in arbitrary order).
    let project = match &project_name {
        Some(name) => db::ensure_named_project(&state.db, &user, name).await,
        None       => db::ensure_default_project(&state.db, &user).await,
    }?;

    let bytes = bytes.ok_or_else(|| AppError::bad_request("missing_file", "no `file` field"))?;

    // Excel uploads: convert .xlsx / .xls / .xlsm / .xlsb / .ods to CSV
    // bytes BEFORE we hit disk so the rest of the pipeline (encoding
    // detection, Polars CSV parser, redtable paging, cleaning steps)
    // treats the file as plain CSV. The DB row keeps the user's
    // original filename for display — only the stored bytes change.
    let bytes = if data::parse::is_excel_filename(&original_filename) {
        let xbytes = bytes;
        tokio::task::spawn_blocking(move || data::parse::xlsx_to_csv(&xbytes))
            .await
            .map_err(|e| AppError::internal("join", e.to_string()))??
    } else {
        bytes
    };

    let size  = bytes.len() as u64;
    let rid   = id::new("FIL");
    let storage_rel = format!("files/{rid}.bin");

    let abs_path = state.file_path(&rid);
    tokio::fs::write(&abs_path, &bytes).await
        .map_err(|e| AppError::internal("io", format!("write {}: {e}", abs_path.display())))?;

    let globals = db::list_global_sentinels(&state.db).await?;
    let tld = tld_hint.clone();
    let bytes_for_parse = bytes;
    let parsed = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let (df, enc) = data::parse::from_csv_bytes(&bytes_for_parse, tld.as_deref())?;
        let cols = data::dtype::summarize(&df)?;
        // Score on the worker thread — the structural pass touches every
        // string cell, so it doesn't belong on the async runtime.
        // Upload-path scoring uses the shared vocabulary (globals).
        // The uploader's personal additions get applied later via
        // compute_cleanness when they explicitly request it.
        let cleanness = data::stats::cleanness(&df, &cols, &globals);
        let fully_null = data::stats::count_fully_null_rows(&df);
        Ok((df, enc, cols, cleanness, fully_null))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;
    let (df, encoding, columns, cleanness, fully_null_rows) = parsed;

    // Strip the upload extension off the DB-stored filename (mig 011).
    // file_type owns the extension; filename is the user-facing stem.
    // `data::parse::strip_upload_ext` covers the seven upload-accepted
    // extensions, falls through for anything else.
    let filename = data::parse::strip_upload_ext(&original_filename).to_string();
    db::insert_file(
        &state.db, &rid, &project, &filename, &encoding,
        df.height() as u64, df.width() as u32, size, &storage_rel, &columns, cleanness,
    )
    .await?;

    crate::event::info(&state.db, "file_upload", format!("uploaded {filename}"))
        .user(user.clone())
        .context(serde_json::json!({
            "file": rid.clone(), "project": project.clone(), "rows": df.height(),
        }))
        .send();

    let now = Utc::now();
    let summary = FileSummary {
        redpash_id:         rid.clone(),
        project_redpash_id: project.clone(),
        filename:           filename.clone(),
        display_name:       Some(filename),
        file_type:          "csv".into(),
        stage:              "new".into(), // fresh file — no steps/charts/dashboards yet
        row_count:          Some(df.height() as u64),
        col_count:          Some(df.width() as u32),
        file_size_bytes:    Some(size),
        cleanness_pct:      cleanness,
        encoding:           Some(encoding),
        delimiter:          Some(",".into()),
        created_at:         now,
        updated_at:         now,
        fully_null_rows:    Some(fully_null_rows),
    };
    state.files.insert(
        rid,
        FileEntry { summary: summary.clone(), columns: columns.clone(), frame: Arc::new(df) },
    );

    Ok((StatusCode::CREATED, Json(FileEnvelope { summary, columns, steps: vec![] })))
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn get_summary(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;

    // chart-/dashboard-typed project_files rows have no on-disk blob —
    // their spec lives in the project_files.spec JSON column (see
    // db::insert_chart / db::insert_dashboard which write storage_path
    // = '' by design). Hydrate would then EISDIR on the empty path. We
    // short-circuit to a metadata-only envelope so the FE can dispatch
    // by `summary.file_type` to /api/charts/:rid or /api/dashboards/:rid
    // (workspace.js:loadFile already reads the file_type from this
    // envelope and routes accordingly).
    let meta = db::find_file(&state.db, &rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?;
    if meta.summary.file_type != "csv" {
        return Ok(Json(FileEnvelope {
            summary: meta.summary,
            columns: vec![],
            steps:   vec![],
        }));
    }

    let entry = hydrate(&state, &rid).await?;
    let steps = db::list_steps(&state.db, &rid).await?;
    Ok(Json(FileEnvelope { summary: entry.summary, columns: entry.columns, steps }))
}

#[derive(serde::Deserialize)]
struct PatchFileBody {
    #[serde(default)] display_name:       Option<String>,
    #[serde(default)] project_redpash_id: Option<String>,
    #[serde(default)] encoding:           Option<String>,
    #[serde(default)] delimiter:          Option<String>,
}

/// `PATCH /api/files/:rid` — sparse metadata update from the Objects
/// overview's inline edit-mode. Editable: `display_name` (rename),
/// `project_redpash_id` (move the file to another of the owner's
/// projects), `encoding`, and `delimiter`. The cleaning pipeline
/// (steps, columns) has its own endpoints, and `stage` is a computed
/// value (see the `file_stages` view), not a stored column.
///
/// `encoding` is validated against `encoding_rs` and `project_redpash_id`
/// must resolve to a project the caller owns — both surface a clean
/// error rather than a constraint violation. An `encoding` or project
/// change makes the cached frame / summary stale, so the hot-frame
/// cache entry is evicted (the next access re-hydrates from disk).
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn patch_file(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchFileBody>,
) -> Result<Json<FileSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;

    // Move target — must be a project the same user owns. Resolving the
    // owner doubles as the existence check; mismatch / missing → 404.
    let new_project = body.project_redpash_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(pid) = new_project {
        let owns = db::project_owner(&state.db, pid)
            .await?
            .map(|o| o == user)
            .unwrap_or(false);
        if !owns {
            return Err(AppError::not_found("not_found", "target project not found"));
        }
    }

    // Encoding — validate the label before committing (same check as
    // the dedicated `POST /:rid/encoding` endpoint).
    let new_encoding = body.encoding.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(enc) = new_encoding {
        if encoding_rs::Encoding::for_label(enc.as_bytes()).is_none() {
            return Err(AppError::bad_request("invalid_encoding",
                format!("unknown encoding: {enc}")));
        }
    }

    // Strip any upload extension from display_name (mig 011). The
    // frontend already strips on its end, but a stale caller could
    // still send "foo.csv"; defending here keeps the schema invariant
    // (`project_files.display_name` is a stem) regardless of input.
    let display_owned: Option<String> = body.display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| data::parse::strip_upload_ext(s).to_string());
    let updated = db::update_file_meta(
        &state.db, &rid,
        display_owned.as_deref(),
        new_project,
        new_encoding,
        body.delimiter.as_deref().filter(|s| !s.is_empty()),
    )
    .await?
    .ok_or_else(|| AppError::not_found("not_found", "file not found"))?;

    // A new encoding re-decodes the bytes; a move changes the cached
    // summary's project — either way the cache entry is now stale.
    if new_encoding.is_some() || new_project.is_some() {
        state.files.remove(&rid);
    }

    crate::event::info(&state.db, "file_patch", format!("patched file {rid}"))
        .user(user.clone())
        .context(serde_json::json!({
            "file":         rid.clone(),
            "renamed":      display_owned.is_some(),
            "moved":        new_project.is_some(),
            "re_encoded":   new_encoding.is_some(),
            "redelimited":  body.delimiter.as_deref().filter(|s| !s.is_empty()).is_some(),
        }))
        .send();
    Ok(Json(updated.summary))
}

/// `DELETE /api/files/:rid` — remove a file. The DB delete cascades to
/// `project_steps` (history) and `reports` built from this file. The
/// hot-frame cache entry is evicted FIRST so a concurrent request
/// can't re-hydrate a file mid-delete; the on-disk blob is removed
/// best-effort afterwards (a leftover .bin is disk litter, not a
/// correctness bug — the row it pointed at is already gone).
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn delete_file(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    state.files.remove(&rid);
    let existed = db::delete_file(&state.db, &rid).await?;
    if !existed {
        return Err(AppError::not_found("not_found", "file not found"));
    }
    crate::event::info(&state.db, "file_delete", format!("deleted file {rid}"))
        .user(user.clone())
        .context(serde_json::json!({ "file": rid.clone() }))
        .send();
    let _ = tokio::fs::remove_file(state.file_path(&rid)).await;
    Ok(StatusCode::NO_CONTENT)
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn get_page(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<PageQuery>,
) -> Result<Json<Page<shared::file::Row>>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);

    let start = Instant::now();
    let q_clone = q.clone();
    let (rows, total, all_count, row_indices) = tokio::task::spawn_blocking(move || data::parse::page(&frame, &q_clone))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
    let ms = start.elapsed().as_millis() as u32;

    let size  = q.size.unwrap_or(25).clamp(1, 50_000);
    let page  = q.page.unwrap_or(1).max(1);
    let pages = ((total as f64) / (size as f64)).ceil() as u32;

    Ok(Json(Page { rows, total, all_count, page, size, pages, ms, row_indices }))
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn add_step(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<StepRequest>,
) -> Result<Json<AddStepResponse>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    // Validate the step by applying it to the real cached frame BEFORE
    // we touch the DB. Replaying a poisoned step would otherwise make
    // the file un-hydratable until the user manually undoes.
    let entry = hydrate(&state, &rid).await?;
    let before_frame = Arc::clone(&entry.frame);

    let kind   = req.kind.clone();
    let params = req.params.clone();
    let before_clone = (*before_frame).clone();
    let after_frame = tokio::task::spawn_blocking(move || data::steps::apply(before_clone, &kind, &params))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;

    let rows_before = before_frame.height() as u64;
    let rows_after  = after_frame.height() as u64;
    let cells_changed = if rows_before == rows_after && matches!(
        req.kind.as_str(),
        "fill_nulls" | "replace_text" | "change_case" | "fix_invalid"
    ) {
        let before_clone2 = (*before_frame).clone();
        let after_clone2  = after_frame.clone();
        let n = tokio::task::spawn_blocking(move ||
            data::stats::count_cell_diffs(&before_clone2, &after_clone2))
            .await
            .map_err(|e| AppError::internal("join", e.to_string()))?;
        Some(n)
    } else {
        None
    };

    let step_rid = id::new("STP");
    db::insert_step(&state.db, &step_rid, &rid, &req.kind, &req.params)
        .await?;

    crate::event::info(&state.db, "step_apply", format!("applied `{}` step", req.kind))
        .user(user.clone())
        .context(serde_json::json!({ "file": rid.clone(), "step": req.kind.clone() }))
        .send();

    // Cache invalidation forces the next hydrate to replay from disk,
    // including the new step.
    state.files.remove(&rid);
    let entry = hydrate(&state, &rid).await?;
    let steps = db::list_steps(&state.db, &rid).await?;

    Ok(Json(AddStepResponse {
        summary: entry.summary,
        columns: entry.columns,
        steps,
        last_op: StepResult { rows_before, rows_after, cells_changed },
    }))
}

#[derive(serde::Deserialize)]
struct CastPreviewReq {
    column: String,
    dtype:  String,
}

#[derive(serde::Serialize)]
struct CastPreviewResp {
    total:      u64,
    would_null: u64,
    /// Up to 5 distinct source values that would be nulled by the cast —
    /// shown in the confirm prompt so the user sees what they'd lose.
    samples:    Vec<String>,
}

/// Dry-run a `cast` step against the current cached frame WITHOUT
/// persisting it. Returns the count + samples of source values that
/// would silently become null after the cast (e.g. casting a date
/// column with one `"2023"` cell — that cell can't be parsed as a
/// full date and would be nulled). The frontend uses this to surface
/// a confirm prompt before the destructive apply.
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn cast_preview(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<CastPreviewReq>,
) -> Result<Json<CastPreviewResp>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let before_frame = Arc::clone(&entry.frame);

    let column = req.column.clone();
    let dtype  = req.dtype.clone();
    let params = serde_json::json!({ "column": column, "dtype": dtype });

    let before_clone = (*before_frame).clone();
    let after_frame = tokio::task::spawn_blocking(move || data::steps::apply(before_clone, "cast", &params))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;

    // Diff: count source rows that are non-null pre-cast but null
    // post-cast. Sample up to 5 distinct stringified source values.
    let col_name = req.column.clone();
    let before_for_diff = Arc::clone(&before_frame);
    let (would_null, samples) = tokio::task::spawn_blocking(move || -> Result<(u64, Vec<String>), data::DataError> {
        use polars::prelude::*;
        let before_col = before_for_diff.column(&col_name)?;
        let after_col  = after_frame.column(&col_name)?;
        let mut nulled = 0u64;
        let mut seen   = std::collections::BTreeSet::<String>::new();
        let mut samples = Vec::<String>::new();
        let total = before_col.len();
        for i in 0..total {
            let b = before_col.get(i).map_err(data::DataError::from)?;
            let a = after_col.get(i).map_err(data::DataError::from)?;
            let b_null = matches!(b, AnyValue::Null);
            let a_null = matches!(a, AnyValue::Null);
            if !b_null && a_null {
                nulled += 1;
                if samples.len() < 5 {
                    let s = match b {
                        AnyValue::String(s)      => s.to_string(),
                        AnyValue::StringOwned(s) => s.to_string(),
                        other                    => other.to_string(),
                    };
                    if seen.insert(s.clone()) {
                        samples.push(s);
                    }
                }
            }
        }
        Ok((nulled, samples))
    })
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;

    Ok(Json(CastPreviewResp {
        total: before_frame.height() as u64,
        would_null,
        samples,
    }))
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn undo(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let _ = hydrate(&state, &rid).await?;
    let changed = db::undo_last(&state.db, &rid).await?;
    if changed { state.files.remove(&rid); }
    rebuild_envelope(&state, &rid).await
}

/// `POST /api/files/:rid/clear-filters` — surgically un-applies every
/// `filter_rows` step on the file, regardless of position in history.
/// Built for the cleaner's eraser button: undo-only walks the topmost
/// step, so a filter buried under later operations (filter_columns,
/// renames, …) was unreachable. This flips `applied = false` for the
/// matching rows; other steps stay applied. Returns the rebuilt
/// envelope so the frontend can drop its page cache + repaint.
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn clear_filters(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let _ = hydrate(&state, &rid).await?;
    let n = db::clear_steps_of_kind(&state.db, &rid, "filter_rows").await?;
    if n > 0 { state.files.remove(&rid); }
    rebuild_envelope(&state, &rid).await
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn redo(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let _ = hydrate(&state, &rid).await?;
    let changed = db::redo_next(&state.db, &rid).await?;
    if changed { state.files.remove(&rid); }
    rebuild_envelope(&state, &rid).await
}

#[derive(serde::Deserialize)]
struct DedupQuery {
    /// Comma-separated key columns. Empty → full-row dedup.
    by:    Option<String>,
    /// Cap on rows in the preview. Defaults to 500.
    limit: Option<usize>,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn dedup(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<DedupQuery>,
) -> Result<Json<data::dedup::DedupReport>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);
    let by: Vec<String> = q.by.as_deref()
        .map(|s| s.split(',').map(|c| c.trim()).filter(|c| !c.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);

    let report = tokio::task::spawn_blocking(move || data::dedup::detect(&frame, &by, limit))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
    Ok(Json(report))
}

// ─── uniques (filter-panel autocomplete) ───────────────────────

#[derive(serde::Deserialize)]
struct UniquesQuery {
    col:   String,
    #[serde(default)] q:     Option<String>,
    #[serde(default)] limit: Option<usize>,
}

/// One distinct-value slice for a column. `total` = pre-`q` distinct
/// count (so the FE can show "X of N matched"); `truncated` flips
/// true when the underlying distinct set hit MAX_UNIQUE=5000 and the
/// kept set is a top-N-by-frequency pick — gives the FE a "5000+"
/// signal vs promising completeness. Existing single-value
/// `{ values }` callers (cleaner filter dropdown) still parse fine
/// because the new fields are additive.
#[derive(serde::Serialize)]
struct UniquesResponse {
    values:    Vec<String>,
    total:     u32,
    truncated: bool,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn uniques(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<UniquesQuery>,
) -> Result<Json<UniquesResponse>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let frame  = Arc::clone(&entry.frame);
    let col    = q.col.clone();
    let needle = q.q.clone();
    let limit  = q.limit.unwrap_or(50).clamp(1, 500);

    let result = tokio::task::spawn_blocking(move ||
        data::distinct::for_column(&frame, &col, needle.as_deref(), limit)
    )
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    Ok(Json(UniquesResponse {
        values:    result.values,
        total:     result.total,
        truncated: result.truncated,
    }))
}

// ─── sentinels (fix-invalid modal — surface what's actually in the file) ───

#[derive(serde::Serialize)]
struct SentinelsResponse {
    /// One entry per distinct sentinel value found, sorted by count desc.
    items:      Vec<data::stats::SentinelOccurrence>,
    /// The canonical sentinel list the scan uses — handy for the UI to
    /// show "0 found across {known.len()} known sentinels" when empty.
    known:      Vec<String>,
}

#[derive(serde::Deserialize)]
struct SentinelsQuery {
    /// CSV of extra values to also scan for — typically the user's
    /// learned set (`prefs.learned_sentinels`) plus any ad-hoc value
    /// the user just typed into the modal. Whitespace + empties
    /// dropped server-side; case folded to lowercase for matching but
    /// the response preserves the cell's original casing.
    #[serde(default)] extra: Option<String>,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn sentinels(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<SentinelsQuery>,
) -> Result<Json<SentinelsResponse>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);
    let extras: Vec<String> = q.extra.as_deref().unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let items = tokio::task::spawn_blocking(move || data::stats::find_sentinels(&frame, &extras))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))?;
    let known = data::stats::SENTINELS.iter().map(|s| (*s).to_string()).collect();
    Ok(Json(SentinelsResponse { items, known }))
}

// ─── joins ─────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct JoinsQuery {
    /// Min overlap-coefficient to surface a candidate. Defaults to 0.3.
    threshold:   Option<f32>,
    /// Max candidates per other-file. Defaults to 20.
    per_file:    Option<usize>,
    /// Same shape as PageQuery.filters. When present, the current
    /// file's frame is filtered before candidates are computed — so
    /// the detector matches what the user sees in the table.
    filters:     Option<String>,
}

#[derive(serde::Serialize)]
struct JoinsResponse {
    files: Vec<JoinFile>,
}

#[derive(serde::Serialize)]
struct JoinFile {
    redpash_id:  String,
    title:       String,
    candidates:  Vec<data::joins::JoinCandidate>,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn joins(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<JoinsQuery>,
) -> Result<Json<JoinsResponse>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let project = entry.summary.project_redpash_id.clone();

    // If a filter is active, narrow this_frame before detection so the
    // candidates reflect what the user has on screen.
    let filter_json = q.filters.clone().unwrap_or_default();
    let this_frame = if filter_json.is_empty() {
        Arc::clone(&entry.frame)
    } else {
        let base = (*entry.frame).clone();
        let filtered = tokio::task::spawn_blocking(move || data::parse::apply_filter(base, &filter_json))
            .await
            .map_err(|e| AppError::internal("join", e.to_string()))??;
        Arc::new(filtered)
    };

    let others = db::list_files_in_project_except(&state.db, &project, &rid).await?;

    let threshold = q.threshold.unwrap_or(0.3).clamp(0.0, 1.0);
    let per_file  = q.per_file.unwrap_or(20).clamp(1, 200);

    let mut files = Vec::with_capacity(others.len());
    for (other_rid, title) in others {
        let other_entry = hydrate(&state, &other_rid).await?;
        let other_frame = Arc::clone(&other_entry.frame);
        let this = Arc::clone(&this_frame);
        let candidates = tokio::task::spawn_blocking(move ||
            data::joins::detect_pair(&this, &other_frame, threshold, per_file))
            .await
            .map_err(|e| AppError::internal("join", e.to_string()))??;
        if candidates.is_empty() { continue; }
        files.push(JoinFile { redpash_id: other_rid, title, candidates });
    }

    Ok(Json(JoinsResponse { files }))
}

// ─── joins: create ─────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct CreateJoinBody {
    other_file: String,
    /// Compound keys — paired by position: `this_cols[i]` joins with
    /// `other_cols[i]`. Single-key joins pass arrays of length 1.
    this_cols:  Vec<String>,
    other_cols: Vec<String>,
    #[serde(default = "default_join_type")]
    join_type:  String,
    /// Optional filename for the new project_files row. Defaults to
    /// `{this}__{other}_join.csv`.
    name:       Option<String>,
    /// Active filter on this file. When present, only rows matching
    /// the filter participate in the join — joining what's visible
    /// rather than the full underlying frame.
    filters:    Option<serde_json::Value>,
}
fn default_join_type() -> String { "inner".into() }

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn create_join(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<CreateJoinBody>,
) -> Result<(StatusCode, Json<FileEnvelope>), AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    super::ensure_owner(
        db::file_owner(&state.db, &body.other_file).await,
        &user, "file", &body.other_file,
    )?;
    let this_entry  = hydrate(&state, &rid).await?;
    let other_entry = hydrate(&state, &body.other_file).await?;

    // Narrow this_frame to the active filter so the join operates on
    // the visible subset, not the full canonical frame.
    let filter_json = body.filters
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default())
        .unwrap_or_default();
    let this_frame = if filter_json.is_empty() || filter_json == "null" {
        Arc::clone(&this_entry.frame)
    } else {
        let base = (*this_entry.frame).clone();
        let filtered = tokio::task::spawn_blocking(move || data::parse::apply_filter(base, &filter_json))
            .await
            .map_err(|e| AppError::internal("join", e.to_string()))??;
        Arc::new(filtered)
    };
    let other_frame = Arc::clone(&other_entry.frame);

    let jt = body.join_type.clone();
    let lks = body.this_cols.clone();
    let rks = body.other_cols.clone();
    if lks.is_empty() || lks.len() != rks.len() {
        return Err(AppError::bad_request("invalid_spec",
            "this_cols and other_cols must be same-length non-empty arrays"));
    }

    // Pre-allocate the destination so the worker streams the CSV
    // straight to disk — keeping a full in-memory `Vec<u8>` for big
    // joins is what gets the process OOM-killed.
    let new_rid     = id::new("FIL");
    let storage_rel = format!("files/{new_rid}.bin");
    let abs_path    = state.file_path(&new_rid);
    let path_for_blocking = abs_path.clone();

    let globals = db::list_global_sentinels(&state.db).await?;
    let (columns, h, w, cleanness, fully_null_rows) = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let mut joined = data::joins::execute(&this_frame, &other_frame, &lks, &rks, &jt)?;
        let h = joined.height();
        let w = joined.width();
        let columns = data::dtype::summarize(&joined)?;
        // Join output scored against the shared (global) vocabulary —
        // the caller can recompute against their personal additions
        // via compute_cleanness afterward.
        let cleanness = data::stats::cleanness(&joined, &columns, &globals);
        let fully_null = data::stats::count_fully_null_rows(&joined);
        let file = std::fs::File::create(&path_for_blocking)
            .map_err(data::DataError::Io)?;
        use polars::prelude::SerWriter;
        polars::io::csv::write::CsvWriter::new(file)
            .include_header(true)
            .finish(&mut joined)
            .map_err(data::DataError::from)?;
        Ok((columns, h, w, cleanness, fully_null))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    let csv_size = tokio::fs::metadata(&abs_path).await
        .map_err(|e| AppError::internal("io", format!("metadata: {e}")))?
        .len();

    // Stem only — mig 011 stores filenames without their extension;
    // file_type owns the .csv half. Both `this_entry.summary.filename`
    // and `other_entry.summary.filename` are already stems at read
    // time; defensive trim covers legacy rows that somehow slipped
    // through the migration. Body-provided name gets the same trim.
    let filename = body.name
        .map(|s| data::parse::strip_upload_ext(&s).to_string())
        .unwrap_or_else(|| format!(
            "{}__{}_join",
            data::parse::strip_upload_ext(&this_entry.summary.filename),
            data::parse::strip_upload_ext(&other_entry.summary.filename),
        ));

    // Persist metadata — same project as the source file so reports/
    // dashboards built from this project can pick it up.
    let project = this_entry.summary.project_redpash_id.clone();
    db::insert_file(
        &state.db, &new_rid, &project, &filename, "utf-8",
        h as u64, w as u32, csv_size, &storage_rel, &columns, cleanness,
    )
    .await?;

    let now = chrono::Utc::now();
    let summary = FileSummary {
        redpash_id:         new_rid.clone(),
        project_redpash_id: project,
        filename:           filename.clone(),
        display_name:       Some(filename),
        file_type:          "csv".into(),
        stage:              "new".into(), // fresh file — no steps/charts/dashboards yet
        row_count:          Some(h as u64),
        col_count:          Some(w as u32),
        file_size_bytes:    Some(csv_size),
        cleanness_pct:      cleanness,
        encoding:           Some("utf-8".into()),
        delimiter:          Some(",".into()),
        created_at:         now,
        updated_at:         now,
        fully_null_rows:    Some(fully_null_rows),
    };

    // Don't cache the frame eagerly — the next /files/:rid GET will
    // hydrate it from disk on first access. Keeps memory pressure
    // predictable on bursts of join creation.

    crate::event::info(
        &state.db,
        "file_join_create",
        format!("joined {rid} with {} → {new_rid}", body.other_file),
    )
    .user(user.clone())
    .context(serde_json::json!({
        "file":            new_rid.clone(),
        "left_file":       rid.clone(),
        "right_file":      body.other_file.clone(),
        "join_type":       body.join_type.clone(),
        "key_count":       body.this_cols.len(),
        "rows":            h,
        "cols":            w,
        "filtered_input":  body.filters.is_some(),
    }))
    .send();

    Ok((StatusCode::CREATED, Json(FileEnvelope { summary, columns, steps: vec![] })))
}

// ─── snapshot ──────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct SnapshotBody { name: Option<String> }

/// Materialise the current view (post step-replay) as a new project
/// file. The fresh file has no step history — it's a clean snapshot
/// the user can hand to Reports / Dashboards without worrying about
/// step changes invalidating downstream work.
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn snapshot(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<SnapshotBody>,
) -> Result<(StatusCode, Json<FileEnvelope>), AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);

    let new_rid     = id::new("FIL");
    let storage_rel = format!("files/{new_rid}.bin");
    let abs_path    = state.file_path(&new_rid);
    let path_for_blocking = abs_path.clone();

    let globals = db::list_global_sentinels(&state.db).await?;
    let (columns, h, w, cleanness, fully_null_rows) = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let mut df = (*frame).clone();
        let h = df.height();
        let w = df.width();
        let columns = data::dtype::summarize(&df)?;
        // Snapshot scored against the shared vocabulary (globals).
        let cleanness = data::stats::cleanness(&df, &columns, &globals);
        let fully_null = data::stats::count_fully_null_rows(&df);
        let file = std::fs::File::create(&path_for_blocking)
            .map_err(data::DataError::Io)?;
        use polars::prelude::SerWriter;
        polars::io::csv::write::CsvWriter::new(file)
            .include_header(true)
            .finish(&mut df)
            .map_err(data::DataError::from)?;
        Ok((columns, h, w, cleanness, fully_null))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    let csv_size = tokio::fs::metadata(&abs_path).await
        .map_err(|e| AppError::internal("io", format!("metadata: {e}")))?
        .len();

    let project   = entry.summary.project_redpash_id.clone();
    // Stem only (mig 011). Base names are already stripped at read
    // time; defensive strip covers legacy data + any body-provided
    // name the caller happened to include an extension on.
    let base_name = data::parse::strip_upload_ext(
        entry.summary.display_name.as_deref().unwrap_or(&entry.summary.filename),
    );
    let filename  = body.name
        .filter(|s| !s.is_empty())
        .map(|s| data::parse::strip_upload_ext(&s).to_string())
        .unwrap_or_else(|| format!("{base_name}_cleaned"));

    db::insert_file(
        &state.db, &new_rid, &project, &filename, "utf-8",
        h as u64, w as u32, csv_size, &storage_rel, &columns, cleanness,
    )
    .await?;

    let now = chrono::Utc::now();
    let summary = FileSummary {
        redpash_id:         new_rid.clone(),
        project_redpash_id: project,
        filename:           filename.clone(),
        display_name:       Some(filename),
        file_type:          "csv".into(),
        stage:              "new".into(), // fresh file — no steps/charts/dashboards yet
        row_count:          Some(h as u64),
        col_count:          Some(w as u32),
        file_size_bytes:    Some(csv_size),
        cleanness_pct:      cleanness,
        encoding:           Some("utf-8".into()),
        delimiter:          Some(",".into()),
        created_at:         now,
        updated_at:         now,
        fully_null_rows:    Some(fully_null_rows),
    };

    crate::event::info(&state.db, "file_snapshot", format!("snapshot of {rid} → {new_rid}"))
        .user(user.clone())
        .context(serde_json::json!({
            "file":   new_rid.clone(),
            "source": rid.clone(),
            "rows":   h,
            "cols":   w,
        }))
        .send();

    Ok((StatusCode::CREATED, Json(FileEnvelope { summary, columns, steps: vec![] })))
}

#[derive(serde::Deserialize)]
struct ExportQuery {
    #[serde(default)]
    format: Option<String>,
}

/// `GET /api/files/:rid/export?format=` — stream the current view
/// (post step-replay) as a download. `format` is `csv` (default),
/// `xlsx`, or `json`; an unknown value is a 400. Unlike `snapshot`
/// this writes nothing to disk and creates no new file row: it's a
/// pure materialise-and-hand-back. The body is built in-memory; for
/// the 256 MiB upload cap that's a few hundred MiB worst case,
/// acceptable for a single-shot download (we can switch to a
/// streaming body if big-file exports become common).
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn export(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<ExportQuery>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;

    // Resolve the renderer up front so an unknown format fails fast
    // with a 400 — before hydrating the frame.
    let format = q.format.as_deref().unwrap_or("csv").to_ascii_lowercase();
    let (render, ext, content_type): (
        fn(&polars::prelude::DataFrame) -> data::Result<Vec<u8>>,
        &str,
        &str,
    ) = match format.as_str() {
        "csv"  => (data::export::to_csv, "csv", "text/csv; charset=utf-8"),
        "xlsx" => (
            data::export::to_xlsx,
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "json" => (data::export::to_json, "json", "application/json; charset=utf-8"),
        other  => return Err(AppError::bad_request(
            "unsupported_format",
            format!("export format '{other}' is not supported (use csv, xlsx, or json)"),
        )),
    };

    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);
    let bytes = tokio::task::spawn_blocking(move || render(frame.as_ref()))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;

    // Download filename — prefer the display name, force the chosen
    // format's extension, and strip anything that could break the
    // Content-Disposition header (quotes, control chars, path seps).
    let raw_name = entry.summary.display_name.as_deref()
        .unwrap_or(&entry.summary.filename);
    let stem = raw_name
        .trim_end_matches(".csv")
        .trim_end_matches(".xlsx")
        .trim_end_matches(".json")
        .trim_end_matches('.');
    let safe: String = stem.chars()
        .map(|c| if c.is_control() || matches!(c, '"' | '\\' | '/' | '\n' | '\r') { '_' } else { c })
        .collect();
    let download_name = format!("{safe}.{ext}");

    use axum::http::header;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{download_name}\"")),
        ],
        bytes,
    ))
}

#[derive(serde::Deserialize)]
struct EncodingBody { encoding: String }

#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn set_encoding(
    State(state):  State<AppState>,
    headers:       axum::http::HeaderMap,
    Path(rid):     Path<String>,
    Json(body):    Json<EncodingBody>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    // Validate the label via encoding_rs before we commit.
    if encoding_rs::Encoding::for_label(body.encoding.as_bytes()).is_none() {
        return Err(AppError::bad_request("invalid_encoding",
            format!("unknown encoding: {}", body.encoding)));
    }
    // Make sure the file exists.
    let _ = hydrate(&state, &rid).await?;
    db::update_file_encoding(&state.db, &rid, &body.encoding).await?;
    state.files.remove(&rid);

    crate::event::info(&state.db, "file_re_encode", format!("set encoding {} on {rid}", body.encoding))
        .user(user.clone())
        .context(serde_json::json!({ "file": rid.clone(), "encoding": body.encoding.clone() }))
        .send();
    rebuild_envelope(&state, &rid).await
}

/// `POST /api/files/:rid/cleanness` — (re)compute and persist the
/// file's cleanness score. New uploads / joins / snapshots get a
/// score automatically; this endpoint backfills legacy files
/// (uploaded before scoring existed) and lets the overview's "Score
/// files" button refresh a stale number on demand. Evicting the cache
/// first forces a fresh hydrate, which recomputes cleanness from the
/// current step cursor and persists it via `update_file_columns`.
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn compute_cleanness(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;

    // Wipe the cached entry → next hydrate scores against the *global*
    // baseline (canonical SENTINELS ∪ global_sentinels view). Then, if
    // the file owner has any personal additions in their
    // prefs.learned_sentinels, re-score with the full union and persist
    // — that's the difference between "scoring agrees with everyone"
    // (hydrate baseline) and "scoring agrees with what THIS user
    // considers junk too" (compute_cleanness output).
    state.files.remove(&rid);
    let entry = hydrate(&state, &rid).await?;

    let learned = db::find_user_by_id(&state.db, &user).await?
        .and_then(|u| u.prefs.get("learned_sentinels").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    let learned: Vec<String> = learned.into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    if learned.is_empty() {
        // Hydrate's score already matches the only vocabulary this user
        // has — return as-is, no re-score needed.
        return Ok(Json(entry.summary));
    }

    // Union learned + globals. Globals were already baked into the
    // hydrate score, but we re-query for the union here so the scorer
    // sees one self-consistent vocabulary (and so we don't depend on
    // a stale process-level cache).
    let globals = db::list_global_sentinels(&state.db).await?;
    let mut union: std::collections::HashSet<String> = globals.into_iter().collect();
    for v in learned { union.insert(v); }
    let extras: Vec<String> = union.into_iter().collect();

    // Re-score against the user's full vocabulary off the request task.
    let frame    = std::sync::Arc::clone(&entry.frame);
    let cols_clone = entry.columns.clone();
    let new_score = tokio::task::spawn_blocking(move || {
        data::stats::cleanness(&frame, &cols_clone, &extras)
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))?;

    db::update_file_columns(
        &state.db, &rid, &entry.columns,
        entry.summary.row_count.unwrap_or(0),
        entry.summary.col_count.unwrap_or(0),
        new_score,
    ).await?;

    // Refresh the cached entry's summary score so subsequent reads
    // see the user-vocabulary number until the next eviction.
    let mut updated = entry.clone();
    updated.summary.cleanness_pct = new_score;
    state.files.insert(rid.clone(), updated.clone());

    crate::event::info(
        &state.db,
        "file_cleanness_recompute",
        match new_score {
            Some(pct) => format!("recomputed cleanness on {rid}: {pct:.1}%"),
            None      => format!("recomputed cleanness on {rid} (no score)"),
        },
    )
    .user(user.clone())
    .context(serde_json::json!({
        "file":      rid.clone(),
        "score_pct": new_score,
    }))
    .send();
    Ok(Json(updated.summary))
}

/// `DELETE /api/files/:rid/cleanness` — null-out the stored cleanness
/// score (dev/test convenience). Evicts the hot-frame cache so the next
/// hydrate doesn't re-stamp a value. Returns the updated FileSummary.
#[tracing::instrument(skip_all, fields(rid = %rid))]
async fn clear_cleanness(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    db::clear_file_cleanness(&state.db, &rid).await?;
    state.files.remove(&rid);
    let meta = db::find_file(&state.db, &rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?;
    Ok(Json(meta.summary))
}

#[tracing::instrument(skip_all)]
async fn rebuild_envelope(state: &AppState, rid: &str) -> Result<Json<FileEnvelope>, AppError> {
    let entry = hydrate(state, rid).await?;
    let steps = db::list_steps(&state.db, rid).await?;
    Ok(Json(FileEnvelope { summary: entry.summary, columns: entry.columns, steps }))
}

/// Get a FileEntry by RID, populating the cache from disk on miss.
/// The cached frame reflects the current cursor (applied steps replayed).
/// `pub(super)` so sibling route modules (reports, …) can reuse it.
pub(super) async fn hydrate(state: &AppState, rid: &str) -> Result<FileEntry, AppError> {
    if let Some(e) = state.files.get(rid) {
        return Ok(e.clone());
    }
    let meta = db::find_file(&state.db, rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?;
    // Chart / dashboard rows share the `project_files` table but have
    // no on-disk bytes (storage_path is empty by construction in
    // `insert_chart` / `insert_dashboard`). A frontend that lands a
    // chart RID on a data endpoint (/page, /uniques, /joins, …) used
    // to hit `tokio::fs::read(data_dir.join(""))` and 500 with `Is a
    // directory`. Reject early with a clean 400 so the FE bug surfaces
    // instead of looking like a server fault.
    if meta.storage_path.is_empty() {
        return Err(AppError::bad_request(
            "not_a_data_file",
            format!("{rid} is a {} — no underlying data file", meta.summary.file_type),
        ));
    }
    let steps_all = db::list_steps(&state.db, rid).await?;

    let path = state.data_dir.join(&meta.storage_path);
    let bytes = tokio::fs::read(&path).await
        .map_err(|e| AppError::internal("io", format!("read {}: {e}", path.display())))?;

    // Hydrate has no per-request session, so it scores against the
    // shared vocabulary only — the canonical SENTINELS list plus the
    // global_sentinels view (≥2-user submissions). User-personal
    // additions get layered on top by compute_cleanness via an
    // explicit recompute after eviction.
    let globals = db::list_global_sentinels(&state.db).await?;

    // Build the (kind, params) replay list off the request task — Polars
    // work isn't async-friendly. We move the steps in by value.
    let applied: Vec<(String, serde_json::Value)> = steps_all.iter()
        .filter(|s| s.applied)
        .map(|s| (s.kind.clone(), s.params.clone()))
        .collect();

    // Persisted encoding wins on rehydrate — the user may have overridden
    // chardetng's guess through the cleaner sidebar.
    let encoding = meta.summary.encoding.clone();
    let (df, columns, cleanness, fully_null_rows) = tokio::task::spawn_blocking(move || -> Result<_, data::DataError> {
        let base = match encoding {
            Some(enc) => data::parse::from_csv_bytes_with_encoding(&bytes, &enc)?,
            None      => data::parse::from_csv_bytes(&bytes, None)?.0,
        };
        let pairs: Vec<(&str, serde_json::Value)> = applied.iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let df = data::steps::replay(base, &pairs)?;
        let cols = data::dtype::summarize(&df)?;
        // Recomputed on every (cache-miss) hydrate, so it tracks the
        // current step cursor for free.
        let cleanness = data::stats::cleanness(&df, &cols, &globals);
        let fully_null = data::stats::count_fully_null_rows(&df);
        Ok((df, cols, cleanness, fully_null))
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    // Refresh row/col counts + columns_meta + cleanness in the DB so
    // /api/files/:rid AND the project file-list (which reads the row
    // directly, no hydrate) both reflect the current cursor.
    if let Err(e) = db::update_file_columns(
        &state.db, rid, &columns, df.height() as u64, df.width() as u32, cleanness,
    ).await {
        tracing::warn!(error = %e, "columns_meta update failed (non-fatal)");
    }

    let mut summary = meta.summary;
    summary.row_count       = Some(df.height() as u64);
    summary.col_count       = Some(df.width() as u32);
    summary.cleanness_pct   = cleanness;
    summary.fully_null_rows = Some(fully_null_rows);

    let entry = FileEntry { summary, columns, frame: Arc::new(df) };
    state.files.insert(rid.to_string(), entry.clone());
    Ok(entry)
}
