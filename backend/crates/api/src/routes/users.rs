//! `/api/users` — user directory.
//!
//! Powers the Objects page's owner-reassignment picker and the Users
//! tab. Single-tenant for now: returns every user.
//!
//! Endpoints:
//!   GET    /api/users          list every user (incl. memberships)
//!   POST   /api/users          create a user (dev tool — no email gate)
//!   PATCH  /api/users/:rid     sparse metadata update
//!   DELETE /api/users/:rid     delete a user (cascades sessions /
//!                              memberships / owned projects)
//!
//! All four are dev-permissive — any authenticated user can read /
//! create / patch / delete any user. Tighten before multi-tenant prod.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::user::UserProfile;

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct UserList { items: Vec<UserProfile> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one).patch(patch).delete(delete_one))
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<UserList>, AppError> {
    super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_users(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(UserList { items }))
}

#[derive(Deserialize)]
struct CreateUserBody {
    username:     String,
    display_name: String,
    #[serde(default)] email: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateUserBody>,
) -> Result<Json<UserProfile>, AppError> {
    super::resolve_user_rid(&state, &headers).await?;
    let username     = body.username.trim();
    let display_name = body.display_name.trim();
    if username.is_empty() || display_name.is_empty() {
        return Err(AppError::bad_request("invalid", "username and display_name are required"));
    }
    let email = body.email.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let rid   = id::new("USR");
    let res   = db::insert_user(&state.db, &rid, username, display_name, email).await;
    match res {
        Ok(u) => Ok(Json(u)),
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            Err(AppError::conflict("username_taken", "username already in use"))
        }
        Err(e) => Err(AppError::internal("db", e.to_string())),
    }
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<UserProfile>, AppError> {
    super::resolve_user_rid(&state, &headers).await?;
    let u = db::find_user_by_id(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("user {rid}")))?;
    Ok(Json(u))
}

#[derive(Deserialize)]
struct PatchUserBody {
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] first_name:   Option<String>,
    #[serde(default)] last_name:    Option<String>,
    #[serde(default)] username:     Option<String>,
    #[serde(default)] email:        Option<String>,
    #[serde(default)] plan:         Option<String>,
    #[serde(default)] avatar_url:   Option<String>,
    #[serde(default)] job_title:    Option<String>,
    #[serde(default)] organisation: Option<String>,
    #[serde(default)] use_case:     Option<String>,
    #[serde(default)] locale:       Option<String>,
}

async fn patch(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchUserBody>,
) -> Result<Json<UserProfile>, AppError> {
    super::resolve_user_rid(&state, &headers).await?;
    let trim = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let display_name = trim(body.display_name);
    let first_name   = trim(body.first_name);
    let last_name    = trim(body.last_name);
    let username     = trim(body.username);
    let email        = trim(body.email);
    let plan         = trim(body.plan);
    let avatar_url   = trim(body.avatar_url);
    let job_title    = trim(body.job_title);
    let organisation = trim(body.organisation);
    let use_case     = trim(body.use_case);
    let locale       = trim(body.locale);
    let res = db::update_user(
        &state.db, &rid,
        display_name.as_deref(),
        username.as_deref(),
        email.as_deref(),
        plan.as_deref(),
        avatar_url.as_deref(),
        job_title.as_deref(),
        organisation.as_deref(),
        use_case.as_deref(),
        locale.as_deref(),
        None,
        first_name.as_deref(),
        last_name.as_deref(),
    ).await;
    match res {
        Ok(opt) => Ok(Json(opt.ok_or_else(|| AppError::not_found("not_found", format!("user {rid}")))?)),
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            Err(AppError::conflict("username_taken", "username already in use"))
        }
        Err(e) => Err(AppError::internal("db", e.to_string())),
    }
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::resolve_user_rid(&state, &headers).await?;
    let removed = db::delete_user(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("user {rid}")));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}
