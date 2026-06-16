//! Purpose: `GET /api/me` — who am I, the FE's admin-gate verdict, and the
//! RESOLVED behavior-registry settings (platform → role → user cascade) so the
//! frontend boots with one request. The FE hides surfaces off this payload;
//! the backend gates remain the real boundary.

use axum::{extract::State, routing::get, Json, Router};

use crate::{db, error::AppError, rbac::Caller, settings, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(me))
        .route("/export", get(export_me))
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

/// GET /api/me/export — the data-subject access / portability export (GDPR
/// Art. 15 & 20): everything the SERVER holds about the caller, machine-readable.
/// Closes privacy finding F-H. Auth extraction IS the gate — every query is keyed
/// to caller.rid, so a subject can only export themselves.
///
/// The profile is scoped by data_class: cataloged fields tagged `sensitive` are
/// omitted, and — since we keep ONLY cataloged non-sensitive fields (+ the rid) —
/// any UNcataloged column (e.g. the google_sub OAuth secret) is dropped by
/// construction, safe-by-default. Customer cell DATA stays client-side
/// (registry-redundancy.md); this is the registry view of the subject.
async fn export_me(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<serde_json::Value>, AppError> {
    let rid = &caller.rid;

    let allowed: Vec<String> = sqlx::query_scalar(
        "SELECT field FROM type_fields WHERE type_id = 'user' AND data_class <> 'sensitive'",
    )
    .fetch_all(&state.db)
    .await?;
    let mut subject: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(u) FROM users u WHERE redpash_id = $1")
            .bind(rid)
            .fetch_one(&state.db)
            .await?;
    if let Some(obj) = subject.as_object_mut() {
        let keep: std::collections::HashSet<&str> =
            allowed.iter().map(String::as_str).chain(["redpash_id"]).collect();
        obj.retain(|k, _| keep.contains(k.as_str()));
    }

    let preferences: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM user_preferences p WHERE user_id = $1 ORDER BY 1",
    )
    .bind(rid)
    .fetch_all(&state.db)
    .await?;
    let memberships: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('object', object_redpash_id, 'role', role)
         FROM memberships WHERE member_redpash_id = $1 ORDER BY object_redpash_id",
    )
    .bind(rid)
    .fetch_all(&state.db)
    .await?;
    let authored_comments: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('case_id', case_id, 'body', body, 'created_at', created_at)
         FROM case_comments WHERE author_id = $1 ORDER BY created_at",
    )
    .bind(rid)
    .fetch_all(&state.db)
    .await?;

    // Read-access audit (privacy finding F-I / GDPR Art. 30): a subject-access
    // export is a significant access to personal data — record it.
    crate::event::info(
        &state.db,
        "data_export",
        format!("data-subject export by {rid}"),
        Some(rid.clone()),
        serde_json::json!({ "type": "user", "subject": rid }),
    );

    Ok(Json(serde_json::json!({
        "subject": subject,
        "preferences": preferences,
        "memberships": memberships,
        "authored_comments": authored_comments,
    })))
}
