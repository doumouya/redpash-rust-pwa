//! Cleaner-sidebar state operations: cast dry-run (preview lost
//! rows), undo / redo (walk the step history), clear_filters (eraser
//! that surgically un-applies every filter_rows step regardless of
//! position in history).
//!
//! All four are pure state-machine ops on `project_steps` + the cached
//! frame eviction. None mutate the canonical CSV bytes on disk and none
//! query data — they're the "what step is applied" toggles.

use axum::{
    extract::{Path, State},
    Json,
};
use std::sync::Arc;

use crate::{db, error::AppError, state::AppState};

use super::{hydrate, rebuild_envelope, FileEnvelope};

#[derive(serde::Deserialize)]
pub(super) struct CastPreviewReq {
    column: String,
    dtype:  String,
}

#[derive(serde::Serialize)]
pub(super) struct CastPreviewResp {
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
pub(super) async fn cast_preview(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<CastPreviewReq>,
) -> Result<Json<CastPreviewResp>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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
pub(super) async fn undo(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
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
pub(super) async fn clear_filters(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let _ = hydrate(&state, &rid).await?;
    let n = db::clear_steps_of_kind(&state.db, &rid, "filter_rows").await?;
    if n > 0 { state.files.remove(&rid); }
    rebuild_envelope(&state, &rid).await
}

#[tracing::instrument(skip_all, fields(rid = %rid))]
pub(super) async fn redo(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<FileEnvelope>, AppError> {
    let user = crate::routes::resolve_user_rid(&state, &headers).await?;
    crate::routes::ensure_owner(db::file_owner(&state.db, &rid).await, &user, "file", &rid)?;
    let _ = hydrate(&state, &rid).await?;
    let changed = db::redo_next(&state.db, &rid).await?;
    if changed { state.files.remove(&rid); }
    rebuild_envelope(&state, &rid).await
}
