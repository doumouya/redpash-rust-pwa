//! `/api/companies` — companies + memberships.
//!
//! A company is the multi-tenancy boundary: a user belongs to zero or
//! more companies via `company_memberships`. That table also IS the
//! access-control check — every handler resolves the caller's role and
//! 404s (not 403) when they aren't a member, so company existence is
//! never leaked.
//!
//! Roles: `owner` > `admin` > `member`. owner/admin manage membership
//! and company metadata; member is read-only. Only an owner can grant
//! the owner role or delete the company, and the last owner can't be
//! removed or demoted.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::company::{Company, CompanyMember, CompanySummary};

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct CompanyList { items: Vec<CompanySummary> }

#[derive(Serialize)]
struct MemberList { items: Vec<CompanyMember> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",                      get(list).post(create))
        .route("/:rid",                  get(get_one).patch(patch).delete(delete_one))
        .route("/:rid/members",          get(members).post(add_member))
        .route("/:rid/members/:user_id",
            axum::routing::patch(patch_member_role).delete(remove_member))
}

// ── helpers ────────────────────────────────────────────────────────
fn db_err(e: sqlx::Error) -> AppError {
    AppError::internal("db", e.to_string())
}
fn forbidden(msg: &'static str) -> AppError {
    AppError { status: StatusCode::FORBIDDEN, kind: "forbidden", message: msg.into() }
}

/// Resolve the caller's role in a company, 404ing when they aren't a
/// member — same treatment as "company doesn't exist", so existence
/// isn't leaked. Returns the role for the caller to gate on.
async fn require_member(
    state:   &AppState,
    company: &str,
    user:    &str,
) -> Result<String, AppError> {
    db::company_role(&state.db, company, user)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", format!("company {company}")))
}

/// owner / admin gate for membership + metadata management.
fn require_manage(role: &str) -> Result<(), AppError> {
    if role == "owner" || role == "admin" {
        Ok(())
    } else {
        Err(forbidden("owner or admin role required"))
    }
}

/// Lowercase ASCII-alphanumeric runs joined by single hyphens. Used to
/// derive a company's immutable slug from its name.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = true; // seeded true → trims leading separators
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') { out.pop(); }
    if out.is_empty() { out.push_str("company"); }
    out
}

// ── handlers ───────────────────────────────────────────────────────
async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<CompanyList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_companies(&state.db, &user).await.map_err(db_err)?;
    Ok(Json(CompanyList { items }))
}

#[derive(Deserialize)]
struct CreateCompanyBody {
    name: String,
    /// Optional slug base — defaults to a slugified `name`. Either way
    /// it's suffixed with a short rid slice so it's unique by
    /// construction (no collision retry needed).
    #[serde(default)] slug: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateCompanyBody>,
) -> Result<Json<Company>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad_request("invalid", "company name is required"));
    }
    let rid  = id::new("CMP");
    let base = body.slug.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(slugify)
        .unwrap_or_else(|| slugify(name));
    let slug = format!("{base}-{}", &rid[4..10].to_ascii_lowercase());
    let company = db::create_company(&state.db, &rid, name, &slug, &user)
        .await
        .map_err(db_err)?;
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "company_create".into(),
        message: format!("created company {name}"),
        user:    Some(user.clone()),
        context: serde_json::json!({ "company": rid, "slug": slug }),
        ..Default::default()
    });
    Ok(Json(company))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Company>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    require_member(&state, &rid, &user).await?;
    let company = db::get_company(&state.db, &rid)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", format!("company {rid}")))?;
    Ok(Json(company))
}

#[derive(Deserialize)]
struct PatchCompanyBody {
    #[serde(default)] name:       Option<String>,
    #[serde(default)] slug:       Option<String>,
    #[serde(default)] avatar_url: Option<String>,
}

// Sparse PATCH — name / slug / avatar_url inline edits from the
// Companies tab. Dev-permissive: any authenticated user can patch any
// company (matches the relaxed delete gate). Tighten back to
// require_member + require_manage before multi-tenant prod.
//
// `slug` carries a UNIQUE index — a duplicate maps to a clean 409
// instead of a sqlx 23505 bubbling up as a 500.
async fn patch(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchCompanyBody>,
) -> Result<Json<Company>, AppError> {
    // AUTH-AUDIT-ACK: dev-permissive per [[redpash-stage]]; tighten at RBAC
    // (siblings delete_one + patch share the dev-stage policy)
    let user = super::resolve_user_rid(&state, &headers).await?;
    let mut fields: Vec<&str> = Vec::new();
    if body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some()       { fields.push("name");       }
    if body.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some()       { fields.push("slug");       }
    if body.avatar_url.as_deref().map(str::trim).is_some()                            { fields.push("avatar_url"); }
    let res = db::update_company(
        &state.db, &rid,
        body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(slugify),
        body.avatar_url.as_deref().map(str::trim),
    ).await;
    let company = match res {
        Ok(opt) => opt.ok_or_else(|| AppError::not_found("not_found", format!("company {rid}")))?,
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23505") => {
            return Err(AppError::conflict("slug_taken", "slug already in use"));
        }
        Err(e) => return Err(AppError::internal("db", e.to_string())),
    };
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "company_update".into(),
        message: format!("updated company {}", company.name),
        user:    Some(user),
        context: serde_json::json!({ "company": rid, "fields": fields }),
        ..Default::default()
    });
    Ok(Json(company))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Dev-permissive: any authenticated user can delete any company.
    // Tighten back to owner-only (require_member + role check) before
    // multi-tenant prod — left open while the app is in active dev so
    // the Objects-page Companies tab can freely manipulate seed data.
    // AUTH-AUDIT-ACK: dev-permissive per [[redpash-stage]]; tighten at RBAC
    let user = super::resolve_user_rid(&state, &headers).await?;
    if !db::delete_company(&state.db, &rid).await.map_err(db_err)? {
        return Err(AppError::not_found("not_found", format!("company {rid}")));
    }
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "warn",
        kind:    "company_delete".into(),
        message: format!("deleted company {rid}"),
        user:    Some(user),
        context: serde_json::json!({ "company": rid }),
        ..Default::default()
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn members(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    require_member(&state, &rid, &user).await?;
    let items = db::list_company_members(&state.db, &rid).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}

#[derive(Deserialize)]
struct AddMemberBody {
    user_id: String,
    #[serde(default = "default_role")] role: String,
}
fn default_role() -> String { "member".into() }

/// `POST /api/companies/:rid/members` — add a member or change an
/// existing member's role (upsert). Returns the refreshed member list.
async fn add_member(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<AddMemberBody>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let role = require_member(&state, &rid, &user).await?;
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
    // Re-adding an existing owner with a lesser role is a demotion —
    // never let it strand the company without an owner.
    if let Some(current) = db::company_role(&state.db, &rid, &body.user_id).await.map_err(db_err)? {
        if current == "owner"
            && body.role != "owner"
            && db::company_owner_count(&state.db, &rid).await.map_err(db_err)? <= 1
        {
            return Err(forbidden("can't demote the last owner — promote another first"));
        }
    }
    db::add_company_member(&state.db, &rid, &body.user_id, &body.role)
        .await
        .map_err(db_err)?;
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "company_member_add".into(),
        message: format!("added {} to company {rid} as {}", body.user_id, body.role),
        user:    Some(user),
        context: serde_json::json!({
            "company": rid,
            "member":  body.user_id,
            "role":    body.role,
        }),
        ..Default::default()
    });
    let items = db::list_company_members(&state.db, &rid).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}

/// `DELETE /api/companies/:rid/members/:user_id` — remove a member. A
/// member may remove themselves (leave); removing anyone else needs
/// owner/admin. The last owner can't be removed, and an admin can't
/// remove an owner.
async fn remove_member(
    State(state):          State<AppState>,
    headers:               HeaderMap,
    Path((rid, user_id)):  Path<(String, String)>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let role = require_member(&state, &rid, &user).await?;

    let is_self = user_id == user;
    if !is_self {
        require_manage(&role)?;
    }
    let target_role = db::company_role(&state.db, &rid, &user_id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", "membership not found"))?;

    if target_role == "owner"
        && db::company_owner_count(&state.db, &rid).await.map_err(db_err)? <= 1
    {
        return Err(forbidden("can't remove the last owner — transfer ownership first"));
    }
    if !is_self && role == "admin" && target_role == "owner" {
        return Err(forbidden("admins can't remove an owner"));
    }
    db::remove_company_member(&state.db, &rid, &user_id)
        .await
        .map_err(db_err)?;
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   if is_self { "info" } else { "warn" },
        kind:    if is_self { "company_member_leave".into() } else { "company_member_remove".into() },
        message: if is_self { format!("left company {rid}") }
                 else        { format!("removed {user_id} from company {rid}") },
        user:    Some(user),
        context: serde_json::json!({
            "company":      rid,
            "member":       user_id,
            "was_self":     is_self,
            "target_role":  target_role,
        }),
        ..Default::default()
    });
    let items = db::list_company_members(&state.db, &rid).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}

#[derive(Deserialize)]
struct PatchMemberBody {
    role: String,
}

/// `PATCH /api/companies/:rid/members/:user_id` — change a member's
/// role without the DELETE + re-add round-trip. Strict update: 404
/// if the target user isn't a member of this company.
///
/// Same gates as `add_member`'s upsert path: caller must be
/// owner/admin; only an owner can grant the owner role; demoting
/// the last owner is blocked.
async fn patch_member_role(
    State(state):          State<AppState>,
    headers:               HeaderMap,
    Path((rid, user_id)):  Path<(String, String)>,
    Json(body):            Json<PatchMemberBody>,
) -> Result<Json<MemberList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let role = require_member(&state, &rid, &user).await?;
    require_manage(&role)?;

    let new_role = body.role.trim();
    if !matches!(new_role, "owner" | "admin" | "member") {
        return Err(AppError::bad_request("invalid", "role must be owner, admin or member"));
    }
    if new_role == "owner" && role != "owner" {
        return Err(forbidden("only an owner can grant the owner role"));
    }

    let current = db::company_role(&state.db, &rid, &user_id)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", "membership not found"))?;

    if current == "owner"
        && new_role != "owner"
        && db::company_owner_count(&state.db, &rid).await.map_err(db_err)? <= 1
    {
        return Err(forbidden("can't demote the last owner — promote another first"));
    }

    db::update_company_member_role(&state.db, &rid, &user_id, new_role)
        .await
        .map_err(db_err)?;
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "company_member_role_change".into(),
        message: format!("{user_id} role in {rid}: {current} -> {new_role}"),
        user:    Some(user),
        context: serde_json::json!({
            "company":     rid,
            "member":      user_id,
            "prior_role":  current,
            "new_role":    new_role,
        }),
        ..Default::default()
    });
    let items = db::list_company_members(&state.db, &rid).await.map_err(db_err)?;
    Ok(Json(MemberList { items }))
}
