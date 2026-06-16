//! Purpose: /api/settings — the behavior registry's value store + resolver.
//! Definitions live in frontend code (registerPref/registerPolicy); this API
//! stores scoped VALUES and serves the resolved cascade.
//!
//! Write RBAC:  user scope → self only (or platform admin);
//!              role/platform scope → platform admin only;
//!              company scope → effective >= Admin on that company.
//! Read RBAC:   user scope → self/admin (prefs may be personal);
//!              platform/role/company → any authed caller (policies shape
//!              everyone's UI; they are not secrets).
//! Denials are leak-free 404 per the house contract.
//!
//! Resolution (also exposed on /api/me for boot):
//!   platform('') → role(users.role) → user(rid), later keys overlay earlier.
//!   Company overlay activates when a primary-company concept lands.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use sqlx::PgPool;

use crate::{
    error::AppError,
    rbac::{self, Action, Caller},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/:scope_type/:scope_id/:key",
        get(get_one).put(put_one).delete(delete_one),
    )
}

const SCOPES: [&str; 4] = ["platform", "company", "role", "user"];

fn valid_scope(scope_type: &str) -> Result<(), AppError> {
    if SCOPES.contains(&scope_type) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", "unknown scope"))
    }
}

/// Platform scope has no id (stored as '') but the route needs a non-empty
/// path segment — clients send a placeholder (the FE uses `_`) and we
/// normalize it away here, whatever it was.
fn norm_scope_id(scope_type: &str, scope_id: String) -> String {
    if scope_type == "platform" {
        String::new()
    } else {
        scope_id
    }
}

async fn can_write(
    state: &AppState,
    caller: &Caller,
    scope_type: &str,
    scope_id: &str,
) -> Result<(), AppError> {
    if caller.is_platform_admin {
        return Ok(());
    }
    match scope_type {
        "user" if scope_id == caller.rid => Ok(()),
        // Company scope: company owner/admin manage their own subtree.
        "company" => {
            rbac::require_action(&state.db, &state.type_cache, caller, scope_id, Action::Delete)
                .await // Delete's floor is Admin — the manage tier
                .map_err(|_| AppError::not_found("not_found", "setting"))
        }
        // role / platform / foreign-user: platform admin only — leak-free.
        _ => Err(AppError::not_found("not_found", "setting")),
    }
}

fn can_read(caller: &Caller, scope_type: &str, scope_id: &str) -> Result<(), AppError> {
    match scope_type {
        "user" if scope_id != caller.rid && !caller.is_platform_admin => {
            Err(AppError::not_found("not_found", "setting"))
        }
        _ => Ok(()),
    }
}

async fn get_one(
    State(state): State<AppState>,
    caller: Caller,
    Path((scope_type, scope_id, key)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    valid_scope(&scope_type)?;
    let scope_id = norm_scope_id(&scope_type, scope_id);
    can_read(&caller, &scope_type, &scope_id)?;
    let value: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT value FROM settings WHERE scope_type = $1 AND scope_id = $2 AND key = $3",
    )
    .bind(&scope_type)
    .bind(&scope_id)
    .bind(&key)
    .fetch_optional(&state.db)
    .await?;
    match value {
        Some(v) => Ok(Json(serde_json::json!({ "key": key, "value": v }))),
        None => Err(AppError::not_found("not_found", "setting")),
    }
}

async fn put_one(
    State(state): State<AppState>,
    caller: Caller,
    Path((scope_type, scope_id, key)): Path<(String, String, String)>,
    Json(body): Json<serde_json::Value>,
) -> Result<StatusCode, AppError> {
    valid_scope(&scope_type)?;
    let scope_id = norm_scope_id(&scope_type, scope_id);
    can_write(&state, &caller, &scope_type, &scope_id).await?;
    // Body is either {"value": ...} or the bare value.
    let value = body.get("value").cloned().unwrap_or(body);
    sqlx::query(
        "INSERT INTO settings (scope_type, scope_id, key, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope_type, scope_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(&scope_type)
    .bind(&scope_id)
    .bind(&key)
    .bind(&value)
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Reset-to-default: deleting the stored value re-exposes the next layer of
/// the cascade (or the registered code default).
async fn delete_one(
    State(state): State<AppState>,
    caller: Caller,
    Path((scope_type, scope_id, key)): Path<(String, String, String)>,
) -> Result<StatusCode, AppError> {
    valid_scope(&scope_type)?;
    let scope_id = norm_scope_id(&scope_type, scope_id);
    can_write(&state, &caller, &scope_type, &scope_id).await?;
    sqlx::query("DELETE FROM settings WHERE scope_type = $1 AND scope_id = $2 AND key = $3")
        .bind(&scope_type)
        .bind(&scope_id)
        .bind(&key)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The resolved effective map for a caller: platform('') → role(users.role) →
/// user(rid); later overlays earlier. Served on /api/me for boot.
pub async fn resolved_for(
    pool: &PgPool,
    caller_rid: &str,
    users_role: &str,
) -> sqlx::Result<serde_json::Map<String, serde_json::Value>> {
    let rows: Vec<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT key, value FROM settings
         WHERE (scope_type = 'platform' AND scope_id = '')
            OR (scope_type = 'role' AND scope_id = $1)
            OR (scope_type = 'user' AND scope_id = $2)
         ORDER BY CASE scope_type WHEN 'platform' THEN 1 WHEN 'role' THEN 2 ELSE 3 END",
    )
    .bind(users_role)
    .bind(caller_rid)
    .fetch_all(pool)
    .await?;
    let mut out = serde_json::Map::new();
    for (k, v) in rows {
        out.insert(k, v); // later (higher-precedence) rows overwrite
    }
    Ok(out)
}
