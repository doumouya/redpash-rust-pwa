//! Purpose: `/api/teams` — teams CRUD + per-team member CRUD.
//! Doc: docs/internal/code/backend/api/routes/teams.md
//!
//! A team is a company-scoped subgroup, used as a grant-bearing
//! principal by the RBAC resolver (`rbac::caller_principals`). The
//! membership edge is the same polymorphic `memberships` table as
//! companies/projects/cases — so `routes/members.rs` is mounted under
//! `/:rid/members` unchanged.
//!
//! Roles: `owner > admin > member`. Only an owner can mint another
//! owner; the last owner can't be removed or demoted (gates in
//! routes/members.rs).

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::team::{Team, TeamSummary};

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct TeamList { items: Vec<TeamSummary> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one).patch(patch).delete(delete_one))
        // Same generic edge-CRUD layer as companies/projects/cases — see
        // routes/members.rs. require_member()/manage gates work because
        // the helpers key on `object_redpash_id`, not a typed column.
        .nest("/:rid/members", super::members::routes())
}

fn db_err(e: sqlx::Error) -> AppError {
    AppError::internal("db", e.to_string())
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<TeamList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_teams(&state.db, &user).await.map_err(db_err)?;
    Ok(Json(TeamList { items }))
}

#[derive(Deserialize)]
struct CreateTeamBody {
    name:       String,
    /// The parent company (`teams.company_id` is NOT NULL). Caller must be
    /// at least a member of that company so a non-member can't seed a
    /// team into it.
    company_id: String,
    /// `team` (default) or `department`. Departments carry the
    /// single-parent / one-direct-dept-per-user invariants enforced
    /// downstream by `enforce_one_department_per_user` + members.rs
    /// (see CAS_913 019cd4a settled-dept context). The schema CHECK
    /// already restricts to {team, department}; this validator gives
    /// the FE a clean 400 instead of a 500-from-23514.
    #[serde(default = "default_team_kind")] kind: String,
}

fn default_team_kind() -> String { "team".to_string() }

async fn create(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateTeamBody>,
) -> Result<Json<Team>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad_request("invalid", "team name is required"));
    }
    if body.company_id.trim().is_empty() {
        return Err(AppError::bad_request("invalid", "company_id is required"));
    }
    let kind = body.kind.trim();
    if !matches!(kind, "team" | "department") {
        return Err(AppError::bad_request(
            "invalid",
            "kind must be 'team' or 'department'",
        ));
    }
    // Caller must reach the parent company at member+ — anything less
    // would let an outsider plant a team inside someone else's company.
    // Platform admins bypass via the resolver.
    crate::rbac::require_grant(&state, &user, &body.company_id, "company",
        |g| g.effective().is_some()).await?;

    let rid = id::new("TEM");
    let team = match db::create_team(&state.db, &rid, name, &body.company_id, kind, &user).await {
        Ok(t) => t,
        // 23503 = FK violation — usually the company_id doesn't exist.
        // Surface as 404 so the route doesn't 500 on a bad rid.
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("23503") => {
            return Err(AppError::not_found("not_found", "company not found"));
        }
        Err(e) => return Err(AppError::internal("db", e.to_string())),
    };
    crate::event::info(&state.db, "team_create", format!("created {kind} {name}"))
        .user(user.clone())
        .context(serde_json::json!({ "team": rid, "company": body.company_id, "kind": kind }))
        .send();
    Ok(Json(team))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<Team>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::members::require_member(&state, &rid, &user).await?;
    let team = db::get_team(&state.db, &rid)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", format!("team {rid}")))?;
    Ok(Json(team))
}

#[derive(Deserialize)]
struct PatchTeamBody {
    #[serde(default)] name: Option<String>,
}

async fn patch(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchTeamBody>,
) -> Result<Json<Team>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: team.update — team admin+ (direct role) or platform admin.
    // Same gate shape as company.update. 404 on deny (leak-free).
    crate::rbac::require_grant(&state, &user, &rid, "team",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Admin)).await?;
    let name = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let team = db::update_team(&state.db, &rid, name)
        .await
        .map_err(db_err)?
        .ok_or_else(|| AppError::not_found("not_found", format!("team {rid}")))?;
    crate::event::info(&state.db, "team_update", format!("updated team {}", team.name))
        .user(user)
        .context(serde_json::json!({ "team": rid }))
        .send();
    Ok(Json(team))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    // RBAC: team.delete — team owner only (direct owner) or platform
    // admin. Same gate shape as company.delete.
    crate::rbac::require_grant(&state, &user, &rid, "team",
        |g| g.effective().map_or(false, |r| r >= crate::rbac::Role::Owner)).await?;
    if !db::delete_team(&state.db, &rid).await.map_err(db_err)? {
        return Err(AppError::not_found("not_found", format!("team {rid}")));
    }
    crate::event::warn(&state.db, "team_delete", format!("deleted team {rid}"))
        .user(user)
        .context(serde_json::json!({ "team": rid }))
        .send();
    Ok(Json(serde_json::json!({ "ok": true })))
}
