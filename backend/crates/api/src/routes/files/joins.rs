//! Doc: docs/internal/code/backend/api/routes/files/joins.md
//! `/api/files/:rid/joins` — detect candidates + create the join.
//!
//! Split out of `files/mod.rs` so the join detection + materialisation
//! path (Polars `joins::detect_pair` + `joins::execute`, filter-aware,
//! cleanness-scored, CSV-streamed) lives next to its request/response
//! types instead of being buried in the 1.4k-LOC routes module.
//!
//! `mod.rs` registers the two handlers from here in `routes()` —
//! visibility is `pub(super)` because the registration is the only
//! consumer.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::{db, error::AppError, id, state::AppState};

use super::{hydrate, FileEnvelope};
use shared::file::FileSummary;

#[derive(serde::Deserialize)]
pub(super) struct JoinsQuery {
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
pub(super) struct JoinsResponse {
    files: Vec<JoinFile>,
}

#[derive(serde::Serialize)]
struct JoinFile {
    redpash_id:  String,
    title:       String,
    candidates:  Vec<data::joins::JoinCandidate>,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn joins(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<JoinsQuery>,
) -> Result<Json<JoinsResponse>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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

#[derive(serde::Deserialize)]
pub(super) struct CreateJoinBody {
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
pub(super) async fn create_join(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<CreateJoinBody>,
) -> Result<(StatusCode, Json<FileEnvelope>), AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    crate::routes::ensure_owner(
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
    // The join output is written to disk inside the blocking task below,
    // before the DB row exists. Guard it so a failure in the writer,
    // metadata, or insert removes the orphan; disarmed after the commit.
    let mut blob_guard = super::BlobGuard::arm(abs_path.clone());

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
    blob_guard.disarm();

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
