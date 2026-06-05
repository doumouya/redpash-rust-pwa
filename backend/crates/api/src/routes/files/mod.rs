//! Doc: docs/internal/code/backend/api/routes/files/mod.md
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
//!   POST   /api/files/:rid/steps/preview  { kind, params } → dry-run diff
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

mod joins;
mod meta;
mod output;
mod sql;
mod state_ops;
mod stats;

const MAX_UPLOAD_BYTES: usize = 256 * 1024 * 1024;

/// Best-effort cleanup for a freshly-written blob. The upload / snapshot
/// / join handlers write the `.bin` to disk *before* the DB row that
/// references it exists. If a later step fails (parse error, DB error)
/// and the handler returns early, the blob would be orphaned — no row
/// points at it, so no later sweep can ever find it, and disk leaks per
/// failed request. Arm the guard right after the write and `disarm()` it
/// once the row is committed; if it drops still armed, it removes the
/// file. Drop is sync (`std::fs`) — fine for best-effort cleanup.
pub(super) struct BlobGuard {
    path:  std::path::PathBuf,
    armed: bool,
}

impl BlobGuard {
    pub(super) fn arm(path: std::path::PathBuf) -> Self {
        Self { path, armed: true }
    }

    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BlobGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[derive(Serialize)]
pub(super) struct FileEnvelope {
    pub(super) summary: FileSummary,
    pub(super) columns: Vec<ColumnMeta>,
    pub(super) steps:   Vec<ProjectStep>,
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
        .route("/:rid/steps/preview", post(state_ops::step_preview))
        .route("/:rid/cast-preview", post(state_ops::cast_preview))
        .route("/:rid/undo",     post(state_ops::undo))
        .route("/:rid/redo",     post(state_ops::redo))
        .route("/:rid/clear-filters", post(state_ops::clear_filters))
        .route("/:rid/encoding", post(meta::set_encoding))
        .route("/:rid/dedup",    get(stats::dedup))
        .route("/:rid/joins",    get(joins::joins).post(joins::create_join))
        .route("/:rid/sql",      post(sql::execute))
        .route("/:rid/snapshot",  post(output::snapshot))
        .route("/:rid/uniques",   get(stats::uniques))
        .route("/:rid/sentinels", get(stats::sentinels))
        .route("/:rid/export",    get(output::export))
        .route("/:rid/cleanness", post(meta::compute_cleanness).delete(meta::clear_cleanness))
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

    // Route through the framework upload pipeline — RBAC + blob write + parse
    // + summarize + insert + the `file_upload` audit event all live there now,
    // shared with every connector (kafka_loader and future ETL). Excel→CSV
    // conversion and the TLD parse hint are handled inside. The web caller
    // uploads to their OWN project (resolved above), so the pipeline's
    // write-reach check is a pass-through here; platform admins bypass it.
    let is_admin = crate::rbac::is_platform_admin(&state, &user).await?;
    let outcome = crate::pipeline::upload_csv(
        &state.db,
        state.data_dir.as_path(),
        &user,
        is_admin,
        &project,
        &original_filename,
        bytes,
        tld_hint,
    )
    .await?;

    let crate::pipeline::UploadOutcome {
        rid, filename, encoding, columns, cleanness, size_bytes, fully_null_rows, frame,
    } = outcome;

    let now = Utc::now();
    let summary = FileSummary {
        redpash_id:         rid.clone(),
        project_redpash_id: project.clone(),
        filename:           filename.clone(),
        display_name:       Some(filename),
        file_type:          "csv".into(),
        stage:              "new".into(), // fresh file — no steps/charts/dashboards yet
        row_count:          Some(frame.height() as u64),
        col_count:          Some(frame.width() as u32),
        file_size_bytes:    Some(size_bytes),
        cleanness_pct:      cleanness,
        encoding:           Some(encoding),
        delimiter:          Some(",".into()),
        created_at:         now,
        updated_at:         now,
        fully_null_rows:    Some(fully_null_rows),
    };
    // Web-only: cache the hot frame so the redtable's first page doesn't
    // re-parse. A batch connector skips this (no interactive session).
    state.files.insert(
        rid,
        FileEntry { summary: summary.clone(), columns: columns.clone(), frame: Arc::new(frame) },
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
    // RBAC: file.view (own / project / company / all) — the resolver cascades
    // file→project→company, so a project owner/member or company member (or
    // platform admin) sees it. Broadens the old owner-only read. dev bypasses.
    crate::rbac::require_view(&state, &user, &rid, "file").await?;

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
    // RBAC: file update — admin+ via any reach (owner resolves to scope Owner
    // through the project; project/company admin via cascade; platform). 404
    // on deny (leak-free). The per-field move below stays double-gated.
    crate::rbac::require_grant(&state, &user, &rid, "file",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;

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
    // Field-level RBAC (CAS_C4219F2B s3) — narrows the coarse file gate per field.
    let mut wf: Vec<&str> = Vec::new();
    if display_owned.is_some() { wf.push("display_name"); }
    if new_project.is_some()   { wf.push("project"); }
    if new_encoding.is_some()  { wf.push("encoding"); }
    if body.delimiter.as_deref().filter(|s| !s.is_empty()).is_some() { wf.push("delimiter"); }
    crate::field_perms::require_fields(&state, &user, &rid, "file", &wf).await?;
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
    // RBAC: file delete — admin+ via any reach (catalog file.delete own·company;
    // not viewers). Owner = scope Owner via the project; platform bypasses.
    crate::rbac::require_grant(&state, &user, &rid, "file",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
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
    // RBAC: file.view (own / project / company / all) — see get_summary. The
    // page (data rows) is a read; broadened from owner-only. dev bypasses.
    crate::rbac::require_view(&state, &user, &rid, "file").await?;
    let entry = hydrate(&state, &rid).await?;
    let frame = Arc::clone(&entry.frame);

    let start = Instant::now();
    let q_clone = q.clone();
    let (rows, total, all_count, row_indices) = tokio::task::spawn_blocking(move || data::parse::page(&frame, &q_clone))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
    let ms = start.elapsed().as_millis() as u32;

    // 500k ceiling, in lockstep with the frontend CLIENT_ENGINE_ROW_CAP
    // (CAS_21B43BEC) — covers the real 400k-row file. The client buffers the
    // whole set in one fetch (size = cap+1) and sorts it in a Web Worker, so the
    // old main-thread-freeze ceiling no longer applies. Must stay ≥ the client
    // cap or the completeness guard drops the file to server-mode paging.
    let size  = q.size.unwrap_or(25).clamp(1, 500_000);
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
    // RBAC: applying a cleaning step is a file content mutation — same gate as
    // file.update (admin+ via any reach). "If you can update it you can apply
    // steps" (file.md). Platform bypasses.
    crate::rbac::require_grant(&state, &user, &rid, "file",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
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

#[tracing::instrument(skip_all)]
pub(super) async fn rebuild_envelope(state: &AppState, rid: &str) -> Result<Json<FileEnvelope>, AppError> {
    let entry = hydrate(state, rid).await?;
    let steps = db::list_steps(&state.db, rid).await?;
    Ok(Json(FileEnvelope { summary: entry.summary, columns: entry.columns, steps }))
}

/// Get a FileEntry by RID, populating the cache from disk on miss.
/// The cached frame reflects the current cursor (applied steps replayed).
/// `pub(in crate::routes)` so sibling route modules (reports, …) AND
/// submodules of `files` (joins, …) can reuse it — `pub(super)` only
/// covered the former, broken after the files.rs → files/ split.
pub(in crate::routes) async fn hydrate(state: &AppState, rid: &str) -> Result<FileEntry, AppError> {
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
