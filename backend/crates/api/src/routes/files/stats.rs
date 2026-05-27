//! Stats endpoints for a single file: dedup detection, distinct-value
//! probe for the filter-panel autocomplete, sentinel scan for the
//! fix-invalid modal.
//!
//! All three are read-only queries over the hydrated frame. Split out
//! of `files/mod.rs` so the per-handler request/response types live
//! next to their handler instead of cluttering the dispatcher.

use axum::{
    extract::{Path, Query, State},
    Json,
};
use std::sync::Arc;

use crate::{db, error::AppError, state::AppState};

use super::hydrate;

#[derive(serde::Deserialize)]
pub(super) struct DedupQuery {
    /// Comma-separated key columns. Empty → full-row dedup.
    by:    Option<String>,
    /// Cap on rows in the preview. Defaults to 500.
    limit: Option<usize>,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn dedup(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<DedupQuery>,
) -> Result<Json<data::dedup::DedupReport>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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
pub(super) struct UniquesQuery {
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
pub(super) struct UniquesResponse {
    values:    Vec<String>,
    total:     u32,
    truncated: bool,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn uniques(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<UniquesQuery>,
) -> Result<Json<UniquesResponse>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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
pub(super) struct SentinelsResponse {
    /// One entry per distinct sentinel value found, sorted by count desc.
    items:      Vec<data::stats::SentinelOccurrence>,
    /// The canonical sentinel list the scan uses — handy for the UI to
    /// show "0 found across {known.len()} known sentinels" when empty.
    known:      Vec<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct SentinelsQuery {
    /// CSV of extra values to also scan for — typically the user's
    /// learned set (`prefs.learned_sentinels`) plus any ad-hoc value
    /// the user just typed into the modal. Whitespace + empties
    /// dropped server-side; case folded to lowercase for matching but
    /// the response preserves the cell's original casing.
    #[serde(default)] extra: Option<String>,
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn sentinels(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<SentinelsQuery>,
) -> Result<Json<SentinelsResponse>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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
