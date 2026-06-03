//! Doc: docs/internal/code/backend/api/routes/companies.md
//! `/api/companies` — companies + memberships.
//!
//! A company is the multi-tenancy boundary: a user belongs to zero or
//! more companies via the unified `memberships` table. That table also IS
//! the access-control check — every handler resolves the caller's role and
//! 404s (not 403) when they aren't a member, so company existence is
//! never leaked.
//!
//! Roles: `owner` > `admin` > `member`. owner/admin manage membership
//! and company metadata; member is read-only. Only an owner can grant
//! the owner role or delete the company, and the last owner can't be
//! removed or demoted.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::company::{Company, CompanySummary};

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct CompanyList { items: Vec<CompanySummary> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one).patch(patch).delete(delete_one))
        // Membership CRUD is the generic object-member module — companies are
        // just one object type on the polymorphic edge. Projects/cases/teams
        // nest the same router. See routes/members.rs.
        .nest("/:rid/members", super::members::routes())
}

// ── helpers ────────────────────────────────────────────────────────
fn db_err(e: sqlx::Error) -> AppError {
    AppError::internal("db", e.to_string())
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
    // See-down scope: platform admins see the full directory; everyone else sees
    // only companies they're a member of (CAS_AF2690C0, step-3 — no cross-company
    // discovery under the see-down model).
    let viewer = if crate::rbac::is_platform_admin(&state, &user).await? { None } else { Some(user.as_str()) };
    let items = db::list_companies(&state.db, &user, viewer).await.map_err(db_err)?;
    Ok(Json(CompanyList { items }))
}

#[derive(Deserialize)]
struct CreateCompanyBody {
    name: String,
    /// Optional slug base — defaults to a slugified `name`. Either way
    /// it's suffixed with a short rid slice so it's unique by
    /// construction (no collision retry needed).
    #[serde(default)] slug: Option<String>,
    /// Optional avatar URL at create. Mirrors the `PatchCompanyBody.avatar_url`
    /// field; setting it here avoids a follow-up PATCH after a fresh
    /// org spins up. The FE Companies modal exposes this so an admin
    /// can paste a URL when filing a new company.
    #[serde(default)] avatar_url: Option<String>,
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
    let avatar_url = body.avatar_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let company = db::create_company(&state.db, &rid, name, &slug, avatar_url, &user)
        .await
        .map_err(db_err)?;
    crate::event::info(&state.db, "company_create", format!("created company {name}"))
        .user(user.clone())
        .context(serde_json::json!({ "company": rid, "slug": slug }))
        .send();
    Ok(Json(company))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Company>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::members::require_member(&state, &rid, &user).await?;
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
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: company.update — company admin+ (direct role) or platform admin;
    // a company member can't edit company metadata. 404 on deny (leak-free).
    crate::rbac::require_grant(&state, &user, &rid, "company",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    let mut fields: Vec<&str> = Vec::new();
    if body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some()       { fields.push("name");       }
    if body.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_some()       { fields.push("slug");       }
    if body.avatar_url.as_deref().map(str::trim).is_some()                            { fields.push("avatar_url"); }
    // Field-level RBAC (CAS_C4219F2B s3) — narrows the coarse company.update gate
    // per field via the matrix (defaults ⊕ overrides). dev bypasses.
    crate::field_perms::require_fields(&state, &user, &rid, "company", &fields).await?;
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
    crate::event::info(&state.db, "company_update", format!("updated company {}", company.name))
        .user(user)
        .context(serde_json::json!({ "company": rid, "fields": fields }))
        .send();
    Ok(Json(company))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: company.delete — company owner only (direct owner) or platform
    // admin; never admin/member (deleting a company is giving it away). 404
    // on deny (leak-free).
    crate::rbac::require_grant(&state, &user, &rid, "company",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Owner)).await?;
    if !db::delete_company(&state.db, &rid).await.map_err(db_err)? {
        return Err(AppError::not_found("not_found", format!("company {rid}")));
    }
    crate::event::warn(&state.db, "company_delete", format!("deleted company {rid}"))
        .user(user)
        .context(serde_json::json!({ "company": rid }))
        .send();
    Ok(Json(serde_json::json!({ "ok": true })))
}
