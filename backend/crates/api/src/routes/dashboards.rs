//! Doc: docs/internal/code/backend/api/routes/dashboards.md
//! `/api/dashboards/*` — CRUD + favourite toggle.
//!
//! A dashboard is a layout of widgets, persisted as a dashboard-typed
//! `project_files` row (`file_type='dashboard'`) — the "everything is a
//! File" object model, the same one charts use. Widgets reference
//! charts by id in the `spec` JSON. This module persists the layout;
//! the render-time data fetch is widget-by-widget on the frontend.

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
    // RBAC: dashboard metadata update — admin+ via any reach (owner = scope
    // Owner via the project; project/company admin via cascade; platform). The
    // is_public publish flag is owner-tier per catalog; coarse object-level gate
    // here, per-field atom enforcement is v3. 404 on deny.
    crate::rbac::require_grant(&state, &user, &rid, "dashboard",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    let title_trim = body.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let desc_trim  = body.description.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let folder_trim = body.folder.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let any_field = title_trim.is_some() || desc_trim.is_some() || folder_trim.is_some()
        || body.is_favorite.is_some() || body.is_public.is_some();
    let d = db::patch_dashboard_meta(
        &state.db, &rid,
        title_trim, desc_trim, folder_trim,
        body.is_favorite, body.is_public,
    )
    .await?
    .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;

    // Heuristic: an empty PATCH body is a no-op on the audit trail —
    // don't record an event when no field actually changed.
    if any_field {
        crate::event::info(&state.db, "dashboard_patch", format!("patched dashboard {rid}"))
            .user(user.clone())
            .context(serde_json::json!({
                "dashboard":   rid.clone(),
                "renamed":     title_trim.is_some(),
                "described":   desc_trim.is_some(),
                "moved":       folder_trim.is_some(),
                "favorited":   body.is_favorite.is_some(),
                "visibility":  body.is_public.is_some(),
            }))
            .send();
    }
    Ok(Json(d))
}

async fn list(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
) -> Result<Json<DashboardsList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_dashboards(&state.db, &user)
        .await?;
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
    let rid = id::new("FIL");
    let dashboard = db::insert_dashboard(
        &state.db, &rid, &req.project_redpash_id, &req.title, &req.spec,
        req.folder.as_deref().filter(|s| !s.is_empty()),
        req.description.as_deref().filter(|s| !s.is_empty()),
    )
    .await?;

    crate::event::info(
        &state.db,
        "dashboard_create",
        format!("created dashboard {} ({rid})", req.title),
    )
    .user(user.clone())
    .context(serde_json::json!({
        "dashboard": rid.clone(),
        "project":   req.project_redpash_id.clone(),
    }))
    .send();
    Ok(Json(dashboard))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Dashboard>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: dashboard.view — derived-view (project_files row); resolver
    // cascades dashboard→project→company. Project/company member or platform
    // admin sees it. Writes stay owner-gated. dev bypasses.
    crate::rbac::require_view(&state, &user, &rid, "dashboard").await?;
    let d = db::find_dashboard(&state.db, &rid).await?
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
    // RBAC: dashboard spec/widget update — admin+ via any reach (see patch_one).
    crate::rbac::require_grant(&state, &user, &rid, "dashboard",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    let d = db::update_dashboard(
        &state.db, &rid, &req.title, &req.spec,
        req.folder.as_deref().filter(|s| !s.is_empty()),
        req.description.as_deref().filter(|s| !s.is_empty()),
    )
    .await?
    .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;

    crate::event::info(&state.db, "dashboard_update", format!("updated dashboard {rid} ({})", req.title))
        .user(user.clone())
        .context(serde_json::json!({ "dashboard": rid.clone() }))
        .send();
    Ok(Json(d))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
) -> Result<axum::http::StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: dashboard delete — admin+ via any reach (catalog own·company; not
    // viewers). Owner = scope Owner via the project; platform bypasses.
    crate::rbac::require_grant(&state, &user, &rid, "dashboard",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    let removed = db::delete_dashboard(&state.db, &rid).await?;

    // Heuristic (per Gus's auth-audit pass): only audit-trail an actual
    // delete — a 404 shouldn't leave a phantom row.
    if removed {
        crate::event::info(&state.db, "dashboard_delete", format!("deleted dashboard {rid}"))
            .user(user.clone())
            .context(serde_json::json!({ "dashboard": rid.clone() }))
            .send();
    }
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
    let d = db::set_dashboard_favorite(&state.db, &rid, body.value).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;

    crate::event::info(
        &state.db,
        "dashboard_favorite",
        format!("{} dashboard {rid}", if body.value { "favorited" } else { "unfavorited" }),
    )
    .user(user.clone())
    .context(serde_json::json!({ "dashboard": rid.clone(), "value": body.value }))
    .send();
    Ok(Json(d))
}
