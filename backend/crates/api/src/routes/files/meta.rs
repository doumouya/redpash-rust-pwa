//! File-metadata mutation endpoints: set_encoding (override the
//! chardetng guess; evicts the cache so the next hydrate re-decodes
//! with the user's choice) and the cleanness compute / clear pair
//! (re-score against the user's full sentinel vocabulary; null-out the
//! stored score for dev/test).
//!
//! Grouped here because all three are metadata-only writes — they
//! don't materialise new bytes (that's `output.rs`) and don't query
//! data (that's `stats.rs`). They flip a column on `project_files` +
//! evict the cached frame.

use axum::{
    extract::{Path, State},
    Json,
};

use crate::{db, error::AppError, state::AppState};

use super::{hydrate, rebuild_envelope, FileEnvelope};
use shared::file::FileSummary;

#[derive(serde::Deserialize)]
pub(super) struct EncodingBody { encoding: String }

#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn set_encoding(
    State(state):  State<AppState>,
    headers:       axum::http::HeaderMap,
    Path(rid):     Path<String>,
    Json(body):    Json<EncodingBody>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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
pub(super) async fn compute_cleanness(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileSummary>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;

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
pub(super) async fn clear_cleanness(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileSummary>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    db::clear_file_cleanness(&state.db, &rid).await?;
    state.files.remove(&rid);
    let meta = db::find_file(&state.db, &rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?;
    Ok(Json(meta.summary))
}
