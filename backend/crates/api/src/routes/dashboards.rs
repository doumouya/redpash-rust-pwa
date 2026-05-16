//! `/api/dashboards/*` — CRUD + favourite toggle.
//!
//! Dashboards are project-scoped layouts of widgets. Widgets reference
//! reports/files via their `spec` JSON. The render-time data fetch
//! happens widget-by-widget (next-turn work); this module just
//! persists the layout.

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use shared::dashboard::{Dashboard, DashboardRequest};

use crate::{db, error::AppError, id, state::AppState};

#[derive(serde::Serialize)]
struct DashboardsList { items: Vec<Dashboard> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",              get(list).post(create))
        .route("/:rid",          get(get_one).put(update).patch(patch_one).delete(delete_one))
        .route("/:rid/favorite", post(set_favorite))
}

#[derive(Deserialize)]
struct PatchDashboardBody {
    #[serde(default)] title:       Option<String>,
    #[serde(default)] description: Option<String>,
    #[serde(default)] folder:      Option<String>,
    #[serde(default)] is_favorite: Option<bool>,
    #[serde(default)] is_public:   Option<bool>,
}

// Sparse PATCH for inline-editable Dashboards-tab cells. Each field is
// optional; unsent fields are kept via COALESCE in db::patch_dashboard_meta.
async fn patch_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchDashboardBody>,
) -> Result<Json<Dashboard>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::dashboard_owner(&state.db, &rid).await, &user, "dashboard", &rid)?;
    let d = db::patch_dashboard_meta(
        &state.db, &rid,
        body.title.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.description.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.folder.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.is_favorite,
        body.is_public,
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;
    Ok(Json(d))
}

async fn list(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
) -> Result<Json<DashboardsList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_dashboards(&state.db, &user)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(DashboardsList { items }))
}

async fn create(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Json(req):    Json<DashboardRequest>,
) -> Result<Json<Dashboard>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(
        db::project_owner(&state.db, &req.project_redpash_id).await,
        &user, "project", &req.project_redpash_id,
    )?;
    let rid = id::new("DSH");
    let report = db::insert_dashboard(
        &state.db, &rid, &req.project_redpash_id, &req.title, &req.spec,
        req.folder.as_deref().filter(|s| !s.is_empty()),
        req.description.as_deref().filter(|s| !s.is_empty()),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(report))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Dashboard>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::dashboard_owner(&state.db, &rid).await, &user, "dashboard", &rid)?;
    let d = db::find_dashboard(&state.db, &rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;
    Ok(Json(d))
}

async fn update(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<DashboardRequest>,
) -> Result<Json<Dashboard>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::dashboard_owner(&state.db, &rid).await, &user, "dashboard", &rid)?;
    let d = db::update_dashboard(
        &state.db, &rid, &req.title, &req.spec,
        req.folder.as_deref().filter(|s| !s.is_empty()),
        req.description.as_deref().filter(|s| !s.is_empty()),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;
    Ok(Json(d))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<axum::http::StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::dashboard_owner(&state.db, &rid).await, &user, "dashboard", &rid)?;
    let removed = db::delete_dashboard(&state.db, &rid).await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(if removed { axum::http::StatusCode::NO_CONTENT } else { axum::http::StatusCode::NOT_FOUND })
}

#[derive(Deserialize)]
struct FavoriteBody { value: bool }

async fn set_favorite(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<FavoriteBody>,
) -> Result<Json<Dashboard>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::dashboard_owner(&state.db, &rid).await, &user, "dashboard", &rid)?;
    let d = db::set_dashboard_favorite(&state.db, &rid, body.value).await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;
    Ok(Json(d))
}
