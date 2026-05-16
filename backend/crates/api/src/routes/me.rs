//! `/api/me` — current user profile.
//!
//! Resolution order:
//!   1. If an `rp_session` cookie is present and resolves to a valid
//!      session, return that user.
//!   2. Otherwise, when OAuth is *not* configured (dev mode), fall
//!      back to the bootstrap `state.dev_user`.
//!   3. When OAuth *is* configured but no valid session is present,
//!      return 401 so the frontend can redirect to the landing page.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use shared::user::UserProfile;

use crate::{db, error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(get_me).patch(patch_me))
}

async fn get_me(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<UserProfile>, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;
    let user = db::find_user_by_id(&state.db, &user_rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;
    Ok(Json(user))
}

/// `PATCH /api/me` — sparse profile update. Every field is optional;
/// `prefs` is shallow-merged with the existing JSONB, so callers can
/// flip one key (`{"prefs":{"accent":"#ff0000"}}`) without
/// re-sending the whole object.
#[derive(Deserialize)]
struct PatchMeBody {
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] job_title:    Option<String>,
    #[serde(default)] organisation: Option<String>,
    #[serde(default)] use_case:     Option<String>,
    #[serde(default)] locale:       Option<String>,
    #[serde(default)] prefs:        Option<serde_json::Value>,
}

async fn patch_me(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<PatchMeBody>,
) -> Result<Json<UserProfile>, AppError> {
    let user_rid = resolve_user_rid(&state, &headers).await?;
    let user = db::update_user(
        &state.db,
        &user_rid,
        body.display_name.as_deref(),
        None, // username — /me doesn't expose
        None, // email — managed by OAuth flow, not user-editable here
        None, // plan — billing-only, not user-editable
        None, // avatar_url — managed by OAuth/upload, not user-editable here
        body.job_title.as_deref(),
        body.organisation.as_deref(),
        body.use_case.as_deref(),
        body.locale.as_deref(),
        body.prefs.as_ref(),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", "current user not found"))?;
    Ok(Json(user))
}

/// Pick which user the request is for. Shared by `/api/me` today;
/// Phase 4b will adopt it across every owner-scoped endpoint.
pub async fn resolve_user_rid(state: &AppState, headers: &HeaderMap) -> Result<String, AppError> {
    if let Some(sid) = super::read_cookie(headers, "rp_session") {
        if let Some(uid) = db::find_session_user(&state.db, &sid)
            .await
            .map_err(|e| AppError::internal("db", e.to_string()))?
        {
            return Ok(uid);
        }
    }
    // No session — OAuth disabled means dev mode (fall back). OAuth
    // enabled means the user must sign in.
    if state.oauth.is_some() {
        return Err(AppError {
            status:  StatusCode::UNAUTHORIZED,
            kind:    "unauthenticated",
            message: "no session cookie".into(),
        });
    }
    Ok(state.dev_user.as_ref().clone())
}
