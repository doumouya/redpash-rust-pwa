//! Purpose: `GET /api/me` — who am I, the FE's admin-gate verdict, and the
//! RESOLVED behavior-registry settings (platform → role → user cascade) so the
//! frontend boots with one request. The FE hides surfaces off this payload;
//! the backend gates remain the real boundary.

use axum::{extract::State, routing::get, Json, Router};

use crate::{db, error::AppError, rbac::Caller, settings, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(me))
}

async fn me(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = db::find_user_by_id(&state.db, &caller.rid)
        .await?
        .ok_or_else(AppError::unauthenticated)?;
    let resolved = settings::resolved_for(&state.db, &caller.rid, &user.role).await?;
    Ok(Json(serde_json::json!({
        "user": user,
        "is_platform_admin": caller.is_platform_admin,
        "settings": resolved,
    })))
}
