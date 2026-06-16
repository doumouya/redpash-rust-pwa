//! Purpose: /api/group/preview — the stateless report/chart aggregation engine.
//! Takes a file_id + a ReportSpec, runs data::group_by::execute over the
//! hydrated frame, returns the windowed result. View-gated. There is no stored
//! Report entity (the object-model lock); a chart/report is a derived view.

use axum::{extract::State, routing::post, Json, Router};
use serde::Deserialize;

use crate::{
    error::AppError,
    files,
    rbac::{self, Action, Caller},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/preview", post(preview))
}

#[derive(Deserialize)]
struct PreviewBody {
    file_id: String,
    spec: shared::report::ReportSpec,
}

async fn preview(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<PreviewBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &body.file_id, Action::View).await?;
    let frame = (*files::hydrate(&state, &body.file_id).await?.frame).clone();
    let spec = body.spec;
    let out = tokio::task::spawn_blocking(move || data::group_by::execute(&frame, &spec))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
    let p = data::view::page(&out, 0, data::ROW_CAP);
    Ok(Json(serde_json::json!({
        "columns": p.columns,
        "rows": p.rows,
        "total": p.total,
    })))
}
