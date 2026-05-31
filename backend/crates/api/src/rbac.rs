//! Purpose: RBAC effective-access resolver — the entity-membership-model §2
//! query in code. Default-deny; the keystone every gate reads.
//! Doc: docs/internal/code/backend/api/rbac.md
//!
//! `effective_role(caller, object)` returns the *highest* permission tier the
//! caller holds on the object, across three sources unioned (per
//! docs/internal/specs/rbac/entity-membership-model.md §2):
//!   1. direct  — a membership edge on the object itself
//!   2. cascade — a membership on the object's scope (its company / project)
//!   3. team    — a membership held by any team the caller belongs to (recursive)
//! `None` = no edge reaches the object → access denied. `resolve_grant` splits
//! the result by **reach** (own = a membership on the object itself; cascade =
//! on its company/project) so write gates enforce precisely — a case reporter
//! and a bare company member are both `member` tier, but only the reporter
//! holds the object directly. `require_grant` / `require_view` are the
//! handler-facing gates (dev_user bypasses as the dev-mode platform admin).

use sqlx::PgPool;

use crate::{error::AppError, state::AppState};

/// RBAC permission tier. Ordered `Viewer < Member < Admin < Owner` so the
/// derived `Ord` makes "highest role wins" a plain `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Member,
    Admin,
    Owner,
}

impl Role {
    /// Map the `role` rank used in the SQL (`owner=4 … viewer=1`) to a tier.
    fn from_rank(rank: i32) -> Option<Role> {
        match rank {
            4 => Some(Role::Owner),
            3 => Some(Role::Admin),
            2 => Some(Role::Member),
            1 => Some(Role::Viewer),
            _ => None,
        }
    }
}

/// A caller's resolved access on an object, split by REACH. Write atoms need
/// the split: `direct` = the tier from a membership ON the object itself (own
/// reach — reporter/assignee/case-team); `scope` = the tier from a membership
/// on the object's company/project (cascade). `effective()` = the higher of
/// the two (what `*.view` reads).
#[derive(Debug, Clone, Copy)]
pub struct Grant {
    pub direct: Option<Role>,
    pub scope:  Option<Role>,
}

impl Grant {
    /// Effective tier — the highest of either reach (`None` = no access).
    pub fn effective(&self) -> Option<Role> {
        self.direct.max(self.scope)
    }
    /// Does the caller hold a membership directly on the object (own reach)?
    pub fn is_member(&self) -> bool {
        self.direct.is_some()
    }
    /// At least `min` via the company/project cascade?
    pub fn scope_at_least(&self, min: Role) -> bool {
        self.scope.map_or(false, |r| r >= min)
    }
}

/// The reach-aware resolver (entity-membership-model §2, split by reach).
/// `principals` = caller + every team they belong to (recursive, nested teams
/// close). `direct` = tier on the object itself; `scope` = tier on its cascade
/// scopes (company/project; for project_files the file→project→company chain).
const GRANT_SQL: &str = "
WITH RECURSIVE principals(pid) AS (
        SELECT $1::text
    UNION
        SELECT m.object_redpash_id
        FROM memberships m
        JOIN principals p ON p.pid = m.member_redpash_id
        JOIN entities  e ON e.id  = m.object_redpash_id AND e.type = 'team'
),
cascade_scopes(oid) AS (
        SELECT company_id          FROM cases         WHERE redpash_id = $2
    UNION SELECT project_id          FROM cases         WHERE redpash_id = $2
    UNION SELECT company_id          FROM projects      WHERE redpash_id = $2
    UNION SELECT project_redpash_id  FROM project_files WHERE redpash_id = $2
    UNION SELECT p.company_id
            FROM project_files f JOIN projects p ON p.redpash_id = f.project_redpash_id
           WHERE f.redpash_id = $2
),
ranked(object_redpash_id, rank) AS (
    SELECT object_redpash_id,
           CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
                     WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
    FROM memberships
    WHERE member_redpash_id IN (SELECT pid FROM principals)
)
SELECT
  (SELECT max(rank) FROM ranked WHERE object_redpash_id = $2) AS direct,
  (SELECT max(rank) FROM ranked WHERE object_redpash_id IN (SELECT oid FROM cascade_scopes)) AS scope
";

/// Resolve the caller's reach-split `Grant` on `object`.
pub async fn resolve_grant(pool: &PgPool, caller: &str, object: &str) -> sqlx::Result<Grant> {
    let (direct, scope): (Option<i32>, Option<i32>) = sqlx::query_as(GRANT_SQL)
        .bind(caller)
        .bind(object)
        .fetch_one(pool)
        .await?;
    Ok(Grant {
        direct: direct.and_then(Role::from_rank),
        scope:  scope.and_then(Role::from_rank),
    })
}

/// The caller's **principal set** — themselves plus every team they belong to
/// (recursive, so nested teams close). Resolve once, then a list query can
/// scope rows with `member_redpash_id = ANY($principals)` instead of running
/// the recursive closure per row.
pub async fn principals(pool: &PgPool, caller: &str) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "WITH RECURSIVE p(pid) AS (
                SELECT $1::text
            UNION
                SELECT m.object_redpash_id FROM memberships m
                JOIN p        ON p.pid = m.member_redpash_id
                JOIN entities e ON e.id = m.object_redpash_id AND e.type = 'team')
         SELECT pid FROM p",
    )
    .bind(caller)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

/// Highest role `caller` effectively holds on `object` (either reach), or
/// `None` (default-deny). Thin view over `resolve_grant`.
pub async fn effective_role(
    pool:   &PgPool,
    caller: &str,
    object: &str,
) -> sqlx::Result<Option<Role>> {
    Ok(resolve_grant(pool, caller, object).await?.effective())
}

/// Generic gate. Allow when the caller is the bootstrap `dev_user` (dev-mode
/// platform-admin stand-in until a real `users.role` lands) OR when `rule`
/// accepts their resolved `Grant`. Otherwise 404 — a denied caller can't tell
/// "exists but not yours" from "doesn't exist" (matches `ensure_owner`'s
/// leak-free contract). `label` is the object kind for the message.
///
/// Handlers express each atom's rule as the closure, e.g.
///   case.update → `|g| g.is_member() || g.scope_at_least(Role::Admin)`
///   case.delete → `|g| g.scope_at_least(Role::Admin)`
pub async fn require_grant(
    state:  &AppState,
    caller: &str,
    object: &str,
    label:  &str,
    rule:   impl Fn(Grant) -> bool,
) -> Result<(), AppError> {
    if caller == state.dev_user.as_ref() {
        return Ok(());
    }
    let grant = resolve_grant(&state.db, caller, object).await?;
    if rule(grant) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("{label} {object}")))
    }
}

/// View gate (`*.view`): any effective role at any reach. P2's `case.view`.
pub async fn require_view(
    state:  &AppState,
    caller: &str,
    object: &str,
    label:  &str,
) -> Result<(), AppError> {
    require_grant(state, caller, object, label, |g| g.effective().is_some()).await
}
