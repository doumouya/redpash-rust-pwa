//! Purpose: /api/files/:rid/joins — the multi-file differentiator over HTTP.
//! GET detects candidate keys against every other CSV in the project (overlap
//! coefficient); POST executes a chosen join and materializes the result as a
//! NEW file via the sealed pipeline (additive, never mutates a source).

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;

use super::hydrate;
use crate::{
    db,
    error::AppError,
    pipeline,
    rbac::{self, Action, Caller},
    state::AppState,
};

const OVERLAP_THRESHOLD: f32 = 0.3;
const MAX_CANDIDATES_PER_FILE: usize = 20;

/// GET /:rid/joins — detect candidate join keys against the project's other
/// CSV files.
pub(super) async fn detect(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let meta = db::find_file(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?;
    let this = (*hydrate(&state, &rid).await?.frame).clone();
    let others = db::project_csv_files(&state.db, &meta.project_id, &rid).await?;

    let mut out = Vec::new();
    for (other_rid, filename) in others {
        // View-reach already implied by project cascade, but check per file so
        // a future cross-project file can't leak.
        if rbac::require_action(&state.db, &state.type_cache, &caller, &other_rid, Action::View)
            .await
            .is_err()
        {
            continue;
        }
        // One un-hydratable sibling (a missing/corrupt frame) must not sink the
        // whole candidate scan — skip it and keep detecting against the rest.
        let other = match hydrate(&state, &other_rid).await {
            Ok(e) => (*e.frame).clone(),
            Err(_) => continue,
        };
        let this_c = this.clone();
        let cands = tokio::task::spawn_blocking(move || {
            data::joins::detect_pair(&this_c, &other, OVERLAP_THRESHOLD, MAX_CANDIDATES_PER_FILE)
        })
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
        if !cands.is_empty() {
            out.push(serde_json::json!({
                "file_id": other_rid,
                "filename": filename,
                "candidates": cands.iter().map(|c| serde_json::json!({
                    "this_col": c.this_col, "other_col": c.other_col,
                    "matches": c.matches, "this_uniques": c.this_uniques,
                    "other_uniques": c.other_uniques, "samples": c.samples,
                })).collect::<Vec<_>>(),
            }));
        }
    }
    Ok(Json(serde_json::json!({ "files": out })))
}

#[derive(Deserialize)]
pub(super) struct JoinBody {
    other_file: String,
    left_keys: Vec<String>,
    right_keys: Vec<String>,
    #[serde(default = "default_join_type")]
    join_type: String,
    #[serde(default)]
    materialize_as: Option<String>,
}
fn default_join_type() -> String {
    "inner".into()
}

/// POST /:rid/joins — execute a join, materialize the result as a new file.
pub(super) async fn execute(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<JoinBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    rbac::require_action(&state.db, &state.type_cache, &caller, &body.other_file, Action::View).await?;
    let project = db::find_file(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?
        .project_id;

    let left = (*hydrate(&state, &rid).await?.frame).clone();
    let right = (*hydrate(&state, &body.other_file).await?.frame).clone();
    let (lk, rk, jt) = (body.left_keys.clone(), body.right_keys.clone(), body.join_type.clone());
    let csv = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, data::DataError> {
        let joined = data::joins::execute(&left, &right, &lk, &rk, &jt)?;
        data::export::to_csv(&joined)
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    let name = body.materialize_as.clone().unwrap_or_else(|| "joined".into());
    let outcome = pipeline::upload_csv(
        &state.db,
        &state.type_cache,
        &state.data_dir,
        &caller.rid,
        caller.is_platform_admin,
        &project,
        &format!("{name}.csv"),
        csv,
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "rid": outcome.rid, "filename": outcome.filename, "rows": outcome.frame.height() })))
}
