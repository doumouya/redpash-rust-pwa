//! Doc: docs/internal/code/backend/api/routes/charts.md
//! `/api/charts/*` — CRUD for saved charts.
//!
//! A saved chart is a self-contained visualisation authored on the
//! Reports page, persisted as a chart-typed `project_files` row. The
//! backend stores the chart's JSON `spec` (ECharts option + SVG snapshot
//! + group / aggregation) opaquely — it never runs queries on a chart.
//!
//! Endpoints:
//!   GET    /api/charts        list the current user's charts
//!   POST   /api/charts        create
//!   GET    /api/charts/:rid   fetch one
//!   PUT    /api/charts/:rid   update (title + spec — a re-save)
//!   DELETE /api/charts/:rid   delete

use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use shared::chart::{Chart, ChartRequest};

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct ChartsList { items: Vec<Chart> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one).put(update_one).delete(delete_one))
}

async fn list(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
) -> Result<Json<ChartsList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_charts(&state.db, &user)
        .await?;
    Ok(Json(ChartsList { items }))
}

async fn create(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Json(req):    Json<ChartRequest>,
) -> Result<Json<Chart>, AppError> {
    // Resolve the project from the source file — don't trust the client
    // — and gate on the source file's owner so a user can't chart
    // someone else's data.
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(
        db::file_owner(&state.db, &req.source_file_id).await,
        &user, "file", &req.source_file_id,
    )?;
    let file = db::find_file(&state.db, &req.source_file_id).await?
        .ok_or_else(|| AppError::not_found("not_found", "source file"))?;

    let rid = id::new("CHT");
    let chart = db::insert_chart(
        &state.db, &rid, &file.summary.project_redpash_id,
        &req.source_file_id, &req.title, &req.spec,
    )
    .await?;
    crate::event::info(&state.db, "chart_create", format!("created chart {}", req.title))
        .user(user.clone())
        .context(serde_json::json!({
            "chart":   rid,
            "file":    req.source_file_id,
            "project": file.summary.project_redpash_id,
        }))
        .send();
    Ok(Json(chart))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Chart>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: chart.view — derived-view (project_files row); the resolver
    // cascades chart→project→company, so a project/company member or platform
    // admin sees it. Writes stay owner-gated (with file mutations). dev bypasses.
    crate::rbac::require_view(&state, &user, &rid, "chart").await?;
    let chart = db::find_chart(&state.db, &rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("chart {rid}")))?;
    Ok(Json(chart))
}

// A re-save on the Reports page: title + spec change in place, the
// source file stays put (so `source_file_id` in the body is ignored).
async fn update_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<ChartRequest>,
) -> Result<Json<Chart>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: chart update (title + spec) — admin+ via any reach. Owner resolves
    // to scope Owner through the project (charts are project_files); project/
    // company admin via cascade; platform bypasses. 404 on deny.
    crate::rbac::require_grant(&state, &user, &rid, "chart",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    // Field-level RBAC (CAS_C4219F2B s3) — a re-save writes title + spec.
    crate::field_perms::require_fields(&state, &user, &rid, "chart", &["title", "spec"]).await?;
    let chart = db::update_chart(&state.db, &rid, &req.title, &req.spec)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("chart {rid}")))?;
    crate::event::info(&state.db, "chart_update", format!("updated chart {}", chart.title))
        .user(user.clone())
        .context(serde_json::json!({ "chart": rid }))
        .send();
    Ok(Json(chart))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<axum::http::StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: chart delete — admin+ via any reach (catalog chart.delete own·company;
    // not viewers). Owner = scope Owner via the project; platform bypasses.
    crate::rbac::require_grant(&state, &user, &rid, "chart",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    let removed = db::delete_chart(&state.db, &rid).await?;
    if removed {
        crate::event::info(&state.db, "chart_delete", format!("deleted chart {rid}"))
            .user(user.clone())
            .context(serde_json::json!({ "chart": rid }))
            .send();
    }
    Ok(if removed { axum::http::StatusCode::NO_CONTENT } else { axum::http::StatusCode::NOT_FOUND })
}
