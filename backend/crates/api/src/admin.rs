//! Purpose: /api/admin — platform-admin-only management surface. Today: the
//! field_permissions override upsert (PUT /fields). Non-admins get the SAME
//! leak-free 404 a wrong path would — the surface does not advertise itself
//! (the settings.rs role-scope posture).

use axum::{extract::State, http::StatusCode, routing::put, Json, Router};
use serde::Deserialize;

use crate::{error::AppError, event, field_perms, rbac::Caller, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/fields", put(put_field))
}

#[derive(Deserialize)]
struct FieldOverrideBody {
    type_id: String,
    field: String,
    role: String,
    can_read: bool,
    can_write: bool,
}

/// PUT /api/admin/fields — upsert ONE sparse field_permissions override cell
/// (the derived perm_class matrix stays untouched; this overlays it). 204.
/// Validation: role must be one of the four tiers and (type_id, field) must
/// exist in the catalog — both fail as 404, same shape as the admin gate.
async fn put_field(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<FieldOverrideBody>,
) -> Result<StatusCode, AppError> {
    // Platform-admin gate FIRST — leak-free for everyone else.
    if !caller.is_platform_admin {
        return Err(AppError::not_found("not_found", "admin fields"));
    }
    if !field_perms::TIERS.contains(&body.role.as_str()) {
        return Err(AppError::not_found("not_found", format!("unknown role {}", body.role)));
    }
    let exists: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM type_fields WHERE type_id = $1 AND field = $2")
            .bind(&body.type_id)
            .bind(&body.field)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_none() {
        return Err(AppError::not_found(
            "not_found",
            format!("unknown field {}.{}", body.type_id, body.field),
        ));
    }

    sqlx::query(
        "INSERT INTO field_permissions (type_id, field, role, can_read, can_write)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (type_id, field, role)
         DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write",
    )
    .bind(&body.type_id)
    .bind(&body.field)
    .bind(&body.role)
    .bind(body.can_read)
    .bind(body.can_write)
    .execute(&state.db)
    .await?;

    event::info(
        &state.db,
        "field_permission_set",
        format!(
            "override {}.{} {} → read={} write={}",
            body.type_id, body.field, body.role, body.can_read, body.can_write
        ),
        Some(caller.rid),
        serde_json::json!({
            "type": body.type_id, "field": body.field, "role": body.role,
            "can_read": body.can_read, "can_write": body.can_write,
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}
