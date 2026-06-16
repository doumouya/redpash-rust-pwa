//! Purpose: RBAC — one polymorphic edge, ONE generated resolver, ONE gate.
//!
//! Day-one decisions #5/#6 made code:
//!   - The cascade lives in `type_definitions.scope_parents` (data). The
//!     recursive `scopes` CTE is generated once by `TypeDefCache` and shared
//!     by the grant resolver, the admin edge introspection, AND company-of —
//!     the predecessor's three hand-synced SQL copies collapse to one source.
//!     The cascade is fully transitive (file → project → company falls out of
//!     recursion instead of a hand-written join arm).
//!   - `require_action` is the ONLY handler-facing gate: vertical tier floor
//!     (View→Viewer, Create/Edit→Member, Delete→Admin) ∩ the company's
//!     horizontal Contract (team-PK → object-TYPE → CRUD), wired from the
//!     first route. `require_rule` exists as the documented escape hatch for
//!     reach-split atoms (e.g. members-manage); it is not the default.
//!
//! Denial is 404, never 403 (leak-free). Platform-admin bypass is FIRST in
//! every gate — and the admin verdict arrives pre-resolved on the `Caller`
//! (the per-request auth context), so gates never re-query it.

use std::collections::BTreeMap;

use sqlx::PgPool;

use crate::{error::AppError, type_cache::TypeDefCache};

/// The per-request auth context — resolved ONCE by the session extractor.
#[derive(Debug, Clone)]
pub struct Caller {
    pub rid: String,
    pub is_platform_admin: bool,
}

/// Ordered so "highest role wins" is a plain `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Viewer,
    Member,
    Admin,
    Owner,
}

impl Role {
    fn from_rank(rank: i32) -> Option<Role> {
        match rank {
            4 => Some(Role::Owner),
            3 => Some(Role::Admin),
            2 => Some(Role::Member),
            1 => Some(Role::Viewer),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Member => "member",
            Role::Viewer => "viewer",
        }
    }
}

/// Resolved access split by REACH: `direct` = an edge ON the object itself;
/// `scope` = an edge on something the object cascades to. A case reporter and
/// a bare company member are both member-tier — only the reporter is direct.
#[derive(Debug, Clone, Copy)]
pub struct Grant {
    pub direct: Option<Role>,
    pub scope: Option<Role>,
}

impl Grant {
    pub fn effective(&self) -> Option<Role> {
        self.direct.max(self.scope)
    }
    pub fn is_member(&self) -> bool {
        self.direct.is_some()
    }
    pub fn scope_at_least(&self, min: Role) -> bool {
        self.scope.map_or(false, |r| r >= min)
    }
}

const RANKED_CTE: &str = ",
ranked(object_redpash_id, rank) AS (
    SELECT object_redpash_id,
           CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
                     WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
    FROM memberships
    WHERE member_redpash_id IN (SELECT pid FROM principals)
)";

/// Reach-split grant for `caller` on `object`. The WITH clause (principal
/// closure + recursive scopes) is the generated single source.
pub async fn resolve_grant(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &str,
    object: &str,
) -> sqlx::Result<Grant> {
    let sql = format!(
        "{with}{ranked}
SELECT
  (SELECT max(rank) FROM ranked WHERE object_redpash_id = $2) AS direct,
  (SELECT max(rank) FROM ranked
    WHERE object_redpash_id IN (SELECT oid FROM scopes WHERE oid <> $2)) AS scope",
        with = cache.rbac_with_clause(),
        ranked = RANKED_CTE,
    );
    let (direct, scope): (Option<i32>, Option<i32>) =
        sqlx::query_as(&sql).bind(caller).bind(object).fetch_one(pool).await?;
    Ok(Grant { direct: direct.and_then(Role::from_rank), scope: scope.and_then(Role::from_rank) })
}

/// Admin introspection — the membership edges (across the subject's principal
/// closure) granting any reach on `object`, with the WHY. Same generated WITH
/// clause; different projection. Route applies the platform-admin gate.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GrantEdge {
    pub object: String,
    pub member: String,
    pub role: String,
    pub context_role: String,
    pub reach: String,
}

pub async fn grant_edges(
    pool: &PgPool,
    cache: &TypeDefCache,
    subject: &str,
    object: &str,
) -> sqlx::Result<Vec<GrantEdge>> {
    let sql = format!(
        "{with}
SELECT m.object_redpash_id, m.member_redpash_id, m.role, m.context_role,
       CASE WHEN m.object_redpash_id = $2 THEN 'direct' ELSE 'scope' END AS reach
FROM memberships m
WHERE m.member_redpash_id IN (SELECT pid FROM principals)
  AND m.object_redpash_id IN (SELECT oid FROM scopes)
ORDER BY reach, m.role",
        with = cache.rbac_with_clause(),
    );
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as(&sql).bind(subject).bind(object).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(object, member, role, context_role, reach)| GrantEdge {
            object,
            member,
            role,
            context_role,
            reach,
        })
        .collect())
}

/// The object's company — the third consumer of the same generated CTE: the
/// first ancestor in the scope closure whose entity type is 'company'.
pub async fn company_of(
    pool: &PgPool,
    cache: &TypeDefCache,
    object: &str,
) -> sqlx::Result<Option<String>> {
    let sql = format!(
        "{with}
SELECT s.oid FROM scopes s JOIN entities e ON e.id = s.oid AND e.type = 'company'
ORDER BY s.depth LIMIT 1",
        with = cache.rbac_with_clause(),
    );
    // $1 (caller) is unused by this projection but the shared WITH clause
    // binds it — pass the object for both.
    sqlx::query_scalar(&sql).bind(object).bind(object).fetch_optional(pool).await
}

/// Caller + every team they belong to (recursive). Resolve once, then list
/// queries scope rows with `member_redpash_id = ANY($principals)`.
pub async fn principals(pool: &PgPool, caller: &str) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "WITH RECURSIVE p(pid) AS (
                SELECT $1::text
            UNION
                SELECT m.object_redpash_id FROM memberships m
                JOIN p ON p.pid = m.member_redpash_id
                JOIN entities e ON e.id = m.object_redpash_id AND e.type = 'team')
         SELECT pid FROM p",
    )
    .bind(caller)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

// ─── the per-company horizontal contract ───────────────────────────────────

/// Versioned JSONB in company_rbac (active = max(version)). INVARIANT:
/// enforcement branches on tier + team PKs + object TYPEs only; `labels` and
/// `context_role` are display-only — no enforcement path reads them.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Contract {
    #[serde(default)]
    pub company: String,
    /// company_owner — god of this company's subtree.
    #[serde(default)]
    pub owner: Option<String>,
    /// company_admins — ORG management only, fail-closed for content.
    #[serde(default)]
    pub admins: Vec<String>,
    /// DISPLAY ONLY.
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    /// team PK → object TYPE → allowed actions (⊆ {c,r,u,d}).
    #[serde(default)]
    pub grants: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

impl Contract {
    pub fn is_company_owner(&self, user: &str) -> bool {
        self.owner.as_deref() == Some(user)
    }
    /// Union over the caller's principals; a user PK is never a grant key.
    pub fn allows(&self, principals: &[String], object_type: &str, action: &str) -> bool {
        principals.iter().any(|p| {
            self.grants
                .get(p)
                .and_then(|by_type| by_type.get(object_type))
                .map_or(false, |acts| acts.iter().any(|a| a == action))
        })
    }
}

pub async fn load_contract(pool: &PgPool, company_id: &str) -> sqlx::Result<Option<Contract>> {
    let row: Option<sqlx::types::Json<Contract>> = sqlx::query_scalar(
        "SELECT contract FROM company_rbac WHERE company_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(company_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|j| j.0))
}

// ─── THE gate ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    View,
    Create,
    Edit,
    Delete,
}

impl Action {
    pub fn crud(self) -> &'static str {
        match self {
            Action::View => "r",
            Action::Create => "c",
            Action::Edit => "u",
            Action::Delete => "d",
        }
    }
    /// The universal vertical floor.
    pub fn min_tier(self) -> Role {
        match self {
            Action::View => Role::Viewer,
            Action::Create | Action::Edit => Role::Member,
            Action::Delete => Role::Admin,
        }
    }
}

/// PURE decision — tier (vertical) ∩ contract (horizontal). No contract ⇒
/// tier-only (non-breaking); company_owner ⇒ full subtree; company_admin is
/// NOT auto-content (fail-closed).
fn evaluate(
    grant: Grant,
    contract: Option<&Contract>,
    principals: &[String],
    caller: &str,
    object_type: &str,
    action: Action,
) -> bool {
    let tier_ok = grant.effective().map_or(false, |r| r >= action.min_tier());
    match contract {
        None => tier_ok,
        Some(c) if c.is_company_owner(caller) => true,
        Some(c) => tier_ok && c.allows(principals, object_type, action.crud()),
    }
}

/// The single handler-facing gate. 404 on deny, always.
pub async fn require_action(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &Caller,
    object: &str,
    action: Action,
) -> Result<(), AppError> {
    if caller.is_platform_admin {
        return Ok(());
    }
    let object_type = cache.object_kind(object);
    let grant = resolve_grant(pool, cache, &caller.rid, object).await?;
    let company = company_of(pool, cache, object).await?;
    let contract = match &company {
        Some(c) => load_contract(pool, c).await?,
        None => None,
    };
    let princ =
        if contract.is_some() { principals(pool, &caller.rid).await? } else { Vec::new() };
    if evaluate(grant, contract.as_ref(), &princ, &caller.rid, object_type, action) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("{object_type} {object}")))
    }
}

/// Convenience: any reach at all (View).
pub async fn require_view(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &Caller,
    object: &str,
) -> Result<(), AppError> {
    require_action(pool, cache, caller, object, Action::View).await
}

/// The ESCAPE HATCH for reach-split atoms only (e.g. members-manage rules
/// like "direct member or cascade admin"). Routine CRUD uses require_action;
/// reaching for this in a normal handler is a review finding.
pub async fn require_rule(
    pool: &PgPool,
    cache: &TypeDefCache,
    caller: &Caller,
    object: &str,
    label: &str,
    rule: impl Fn(Grant) -> bool,
) -> Result<(), AppError> {
    if caller.is_platform_admin {
        return Ok(());
    }
    let grant = resolve_grant(pool, cache, &caller.rid, object).await?;
    if rule(grant) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("{label} {object}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member_grant() -> Grant {
        Grant { direct: None, scope: Some(Role::Member) }
    }

    #[test]
    fn tier_floor_holds_without_a_contract() {
        assert!(evaluate(member_grant(), None, &[], "USR_x", "case", Action::View));
        assert!(evaluate(member_grant(), None, &[], "USR_x", "case", Action::Edit));
        assert!(!evaluate(member_grant(), None, &[], "USR_x", "case", Action::Delete));
    }

    #[test]
    fn contract_intersects_and_owner_overrides() {
        let c: Contract = serde_json::from_str(
            r#"{"company":"CMP_x","owner":"USR_o",
                "grants":{"TEM_eng":{"case":["c","r","u"]}}}"#,
        )
        .unwrap();
        let eng = vec!["TEM_eng".to_string()];
        // member tier + contract grant → allowed
        assert!(evaluate(member_grant(), Some(&c), &eng, "USR_x", "case", Action::Edit));
        // contract grants 'u' but not 'd'; tier wouldn't allow Delete anyway
        assert!(!evaluate(member_grant(), Some(&c), &eng, "USR_x", "case", Action::Delete));
        // no contract grant for this type → denied even with tier
        assert!(!evaluate(member_grant(), Some(&c), &eng, "USR_x", "user", Action::Edit));
        // company owner bypasses all of it
        let no_grant = Grant { direct: None, scope: None };
        assert!(evaluate(no_grant, Some(&c), &[], "USR_o", "user", Action::Delete));
        // labels never enforce: a caller whose only key is a label gets nothing
        assert!(!c.allows(&["Manager".to_string()], "case", "u"));
    }
}
