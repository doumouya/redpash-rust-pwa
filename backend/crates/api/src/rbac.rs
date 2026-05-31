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
//! `None` = no edge reaches the object → access denied. This is P1 of the
//! enforcement workstream: the resolver only. No gate wires it in yet.

use sqlx::PgPool;

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

/// The §2 resolver. `principals` = the caller plus every team they belong to
/// (recursive, so nested teams close); `scopes` = the object plus the
/// company/project it lives in (cascade), covering case / project / file
/// (project_files) containment. The effective tier is the max `role` rank over
/// every membership where a principal holds a role on a scope.
const EFFECTIVE_ROLE_SQL: &str = "
WITH RECURSIVE principals(pid) AS (
        SELECT $1::text
    UNION
        SELECT m.object_redpash_id
        FROM memberships m
        JOIN principals p ON p.pid = m.member_redpash_id
        JOIN entities  e ON e.id  = m.object_redpash_id AND e.type = 'team'
),
scopes(oid) AS (
        SELECT $2::text
    UNION SELECT company_id          FROM cases         WHERE redpash_id = $2
    UNION SELECT project_id          FROM cases         WHERE redpash_id = $2
    UNION SELECT company_id          FROM projects      WHERE redpash_id = $2
    UNION SELECT project_redpash_id  FROM project_files WHERE redpash_id = $2
    UNION SELECT p.company_id
            FROM project_files f JOIN projects p ON p.redpash_id = f.project_redpash_id
           WHERE f.redpash_id = $2
)
SELECT max(CASE m.role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
                       WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
FROM memberships m
WHERE m.member_redpash_id IN (SELECT pid FROM principals)
  AND m.object_redpash_id IN (SELECT oid FROM scopes)
";

/// Highest role `caller` effectively holds on `object` (any entity rid), or
/// `None` for no access (default-deny).
pub async fn effective_role(
    pool:   &PgPool,
    caller: &str,
    object: &str,
) -> sqlx::Result<Option<Role>> {
    let (rank,): (Option<i32>,) = sqlx::query_as(EFFECTIVE_ROLE_SQL)
        .bind(caller)
        .bind(object)
        .fetch_one(pool)
        .await?;
    Ok(rank.and_then(Role::from_rank))
}
