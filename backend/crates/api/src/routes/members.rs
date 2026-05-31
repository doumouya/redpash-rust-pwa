//! Purpose: generic object-member management — CRUD on the polymorphic
//! membership edge for ANY object entity (company / project / case / team).
//! One implementation; each object type just `nest`s `routes()` under its
//! `/:rid/members` path. The membership IS the access control + the org graph.
//! Doc: docs/internal/code/backend/api/routes/members.md
//!
//! Routes (relative — nested under e.g. `/api/companies/:rid/members`):
//!   GET    /                  list the object's members      (any member)
//!   POST   /                  add a member                    (owner/admin)
//!   PATCH  /:member_id        change a member's role          (owner/admin)
//!   DELETE /:member_id        remove a member OR self-leave   (owner/admin · @own)
//!
//! Gate: a "manager" is an owner/admin **directly on the object** (or a
//! platform admin). Roles: `owner > admin > member`. Only an owner grants
//! `owner`; the last owner can't be demoted or removed. The DB helpers
//! (`db::company_role`, `db::list_company_members`, …) are object-agnostic —
//! they key on `object_redpash_id`; the legacy `company_` naming is cosmetic.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::company::CompanyMember;

use crate::{db, error::AppError, state::AppState};

#[derive(Serialize)]
struct MemberList { items: Vec<CompanyMember> }

#[derive(Deserialize)]
struct AddMemberBody {
    user_id: String,
    #[serde(default = "default_role")] role: String,
}
fn default_role() -> String { "member".into() }

#[derive(Deserialize)]
struct PatchMemberBody { role: String }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(add))
        .route("/:member_id", axum::routing::patch(patch_role).delete(remove))
}

// ── helpers ────────────────────────────────────────────────────────
fn db_err(e: sqlx::Error) -> AppError {
    AppError::internal("db", e.to_string())
}
fn forbidden(msg: &'static str) -> AppError {
    AppError { status: StatusCode::FORBIDDEN, kind: "forbidden", message: msg.into(), inner: None }
}

/// Resolve the caller's **direct** role on the object, 404ing when they aren't
/// a member (same as "object doesn't exist" — existence isn't leaked). A
/// platform admin resolves as `owner` (full access). Used as the read gate
/// (any member) and the base for the manage gate.
pub(crate) async fn require_member(
    state:  &AppState,
    object: &str,
    user:   &str,
) -> Result<String, AppError> {
    if crate::rbac::is_platform_admin(state, user).await.map_err(db_err)? {
        return Ok("owner".to_string());
    }
    db::company_role(&state.db, object, user)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", format!("object {object}")))
}

/// owner / admin gate for membership management.
fn require_manage(role: &str) -> Result<(), AppError> {
    if role == "owner" || role == "admin" {
        Ok(())
    } else {
        Err(forbidden("owner or admin role required"))
    }
}

/// The object's entity type (`company`/`project`/`case`/`team`) — used to keep
/// event kinds object-typed (`company_member_add`, `project_member_add`, …).
async fn object_type(state: &AppState, object: &str) -> Result<String, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT type FROM entities WHERE id = $1")
        .bind(object)
        .fetch_optional(&state.db)
        .await
        .map_err(db_err)?;
    Ok(row.map(|(t,)| t).unwrap_or_else(|| "object".to_string()))
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(object): Path<String>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    require_member(&state, &object, &user).await?;
    let items = db::list_company_members(&state.db, &object).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}

async fn add(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(object): Path<String>,
    Json(body):   Json<AddMemberBody>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let role = require_member(&state, &object, &user).await?;
    require_manage(&role)?;

    if !matches!(body.role.as_str(), "owner" | "admin" | "member") {
        return Err(AppError::bad_request("invalid", "role must be owner, admin or member"));
    }
    // Only an owner can mint another owner.
    if body.role == "owner" && role != "owner" {
        return Err(forbidden("only an owner can grant the owner role"));
    }
    // Target must be a real user — clean 404 rather than an FK 500.
    if db::find_user_by_id(&state.db, &body.user_id).await.map_err(db_err)?.is_none() {
        return Err(AppError::not_found("not_found", "user not found"));
    }
    // Re-adding an existing owner with a lesser role is a demotion — never let
    // it strand the object without an owner.
    if let Some(current) = db::company_role(&state.db, &object, &body.user_id).await.map_err(db_err)? {
        if current == "owner"
            && body.role != "owner"
            && db::company_owner_count(&state.db, &object).await.map_err(db_err)? <= 1
        {
            return Err(forbidden("can't demote the last owner — promote another first"));
        }
    }
    db::add_company_member(&state.db, &object, &body.user_id, &body.role)
        .await
        .map_err(db_err)?;
    let kind = format!("{}_member_add", object_type(&state, &object).await?);
    crate::event::info(&state.db, &kind, format!("added {} to {object} as {}", body.user_id, body.role))
        .user(user)
        .context(serde_json::json!({ "object": object, "member": body.user_id, "role": body.role }))
        .send();
    let items = db::list_company_members(&state.db, &object).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}

async fn patch_role(
    State(state):           State<AppState>,
    headers:                HeaderMap,
    Path((object, member)): Path<(String, String)>,
    Json(body):             Json<PatchMemberBody>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let role = require_member(&state, &object, &user).await?;
    require_manage(&role)?;

    let new_role = body.role.trim();
    if !matches!(new_role, "owner" | "admin" | "member") {
        return Err(AppError::bad_request("invalid", "role must be owner, admin or member"));
    }
    if new_role == "owner" && role != "owner" {
        return Err(forbidden("only an owner can grant the owner role"));
    }
    let current = db::company_role(&state.db, &object, &member)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", "membership not found"))?;
    if current == "owner"
        && new_role != "owner"
        && db::company_owner_count(&state.db, &object).await.map_err(db_err)? <= 1
    {
        return Err(forbidden("can't demote the last owner — promote another first"));
    }
    db::update_company_member_role(&state.db, &object, &member, new_role)
        .await
        .map_err(db_err)?;
    let kind = format!("{}_member_role_change", object_type(&state, &object).await?);
    crate::event::info(&state.db, &kind, format!("{member} role in {object}: {current} -> {new_role}"))
        .user(user)
        .context(serde_json::json!({ "object": object, "member": member, "prior_role": current, "new_role": new_role }))
        .send();
    let items = db::list_company_members(&state.db, &object).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}

async fn remove(
    State(state):           State<AppState>,
    headers:                HeaderMap,
    Path((object, member)): Path<(String, String)>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let role = require_member(&state, &object, &user).await?;

    let is_self = member == user;
    if !is_self {
        require_manage(&role)?;
    }
    let target_role = db::company_role(&state.db, &object, &member)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", "membership not found"))?;
    if target_role == "owner"
        && db::company_owner_count(&state.db, &object).await.map_err(db_err)? <= 1
    {
        return Err(forbidden("can't remove the last owner — transfer ownership first"));
    }
    if !is_self && role == "admin" && target_role == "owner" {
        return Err(forbidden("admins can't remove an owner"));
    }
    db::remove_company_member(&state.db, &object, &member)
        .await
        .map_err(db_err)?;
    let otype = object_type(&state, &object).await?;
    let ctx = serde_json::json!({ "object": object, "member": member, "was_self": is_self, "target_role": target_role });
    if is_self {
        crate::event::info(&state.db, &format!("{otype}_member_leave"), format!("left {object}"))
            .user(user).context(ctx).send();
    } else {
        crate::event::warn(&state.db, &format!("{otype}_member_remove"), format!("removed {member} from {object}"))
            .user(user).context(ctx).send();
    }
    let items = db::list_company_members(&state.db, &object).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}
