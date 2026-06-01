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
use std::collections::BTreeMap;

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
    /// Lowercase wire label — matches the `memberships.role` CHECK values.
    /// Used by the admin introspection endpoint to serialize a tier.
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Member => "member",
            Role::Viewer => "viewer",
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

/// One membership edge contributing to a resolved grant — the "why" behind a
/// `Grant`, for admin introspection. `reach` is `"direct"` (the edge is ON the
/// object) or `"scope"` (it's on a parent company/project the object cascades
/// to). `member` is the principal that holds it — the subject themselves or a
/// team in their closure.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GrantEdge {
    pub object:       String,
    pub member:       String,
    pub role:         String,
    pub context_role: String,
    pub reach:        String,
}

// Same principal-closure + cascade-scope shape as GRANT_SQL — keep the two in
// sync (see "Drift-prone areas" in rbac.md). Where GRANT_SQL collapses to
// max-rank-per-reach, this returns the underlying rows so an admin can see
// exactly which memberships (and via which principal) grant the access.
const EDGES_SQL: &str = "
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
)
SELECT m.object_redpash_id, m.member_redpash_id, m.role, m.context_role,
       CASE WHEN m.object_redpash_id = $2 THEN 'direct' ELSE 'scope' END AS reach
FROM memberships m
WHERE m.member_redpash_id IN (SELECT pid FROM principals)
  AND (m.object_redpash_id = $2 OR m.object_redpash_id IN (SELECT oid FROM cascade_scopes))
ORDER BY reach, m.role
";

/// Admin introspection — the membership edges (across the subject's principal
/// closure) that grant any reach on `object`. Read-only; the route applies the
/// platform-admin gate. Pairs with `resolve_grant` (tiers) to answer "who has
/// reach on X, and why".
pub async fn grant_edges(pool: &PgPool, subject: &str, object: &str) -> sqlx::Result<Vec<GrantEdge>> {
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as(EDGES_SQL).bind(subject).bind(object).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(object, member, role, context_role, reach)| GrantEdge {
            object, member, role, context_role, reach,
        })
        .collect())
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

/// Is `caller` a platform admin (full access — the catalog's `*.view.all`)?
/// The bootstrap `dev_user` always is (fast-path, no query — keeps dev mode
/// working), plus any user with `users.role = 'admin'` (mig 20260531000002).
/// Platform admins bypass every gate.
pub async fn is_platform_admin(state: &AppState, caller: &str) -> sqlx::Result<bool> {
    if caller == state.dev_user.as_ref() {
        return Ok(true);
    }
    let row: Option<(String,)> = sqlx::query_as("SELECT role FROM users WHERE redpash_id = $1")
        .bind(caller)
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map_or(false, |(r,)| r == "admin"))
}

/// Generic gate. Allow when the caller is a platform admin (`is_platform_admin`
/// — bootstrap dev_user or `users.role='admin'`) OR when `rule` accepts their
/// resolved `Grant`. Otherwise 404 — a denied caller can't tell "exists but not
/// yours" from "doesn't exist" (matches `ensure_owner`'s leak-free contract).
/// `label` is the object kind for the message.
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
    if is_platform_admin(state, caller).await? {
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

// ─── permission contract (CAS_0DE2DDEF) ────────────────────────────────────
// Step 1: storage + types + the horizontal-axis check. STORAGE ONLY — wired
// into the gates in step 2, so nothing below changes enforcement yet.
//
// Em's reframe: RBAC is one declarative, per-company, versioned JSONB contract
// the single evaluator reads. The tier ladder (`Role`), the self-overlay, and
// the see-down visibility rule are framework DEFAULTS — not stored. The
// contract carries the company-scope specials (owner/admins) + the HORIZONTAL
// axis: per-(team, object-TYPE) action grants (HR owns Users+Payslips, Eng owns
// Cases+Monitoring — capability, not team-over-team rank). The `memberships`
// graph stays the instances; this is the policy over it.

/// The per-company RBAC permission contract. Stored as JSONB in `company_rbac`
/// (active = max(version)).
///
/// INVARIANT (Em, emphasised twice): enforcement branches on the TIER and these
/// `grants` ONLY. `labels` is DISPLAY-ONLY (their label → tier, for the UI); no
/// enforcement path reads it, and nothing here is keyed on a team/department
/// NAME — only PKs (`company`, the grant keys = team PK) + object TYPEs. They
/// pick whatever `context_role` / names they like; the framework ignores them.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Contract {
    #[serde(default)] pub company: String,
    /// company_owner (USR_ id) — god of this company's subtree.
    #[serde(default)] pub owner:  Option<String>,
    /// company_admin (USR_ ids) — ORG-management only (teams/memberships/users-as-org),
    /// NO auto content-CRUD (fail-closed). Content access is the explicit grants below.
    #[serde(default)] pub admins: Vec<String>,
    /// DISPLAY ONLY: label → tier (e.g. "Manager"→"owner"). Never enforced on.
    #[serde(default)] pub labels: BTreeMap<String, String>,
    /// The horizontal axis: team PK → object-TYPE → allowed actions (⊆ {c,r,u,d}).
    #[serde(default)] pub grants: BTreeMap<String, BTreeMap<String, Vec<String>>>,
}

impl Contract {
    /// A minimal starter for `company` owned by `owner` (empty grants — an admin
    /// fills them in). Convenience for seeding/Admin-Console; the ABSENCE of any
    /// contract row is treated as "unconfigured → tier-only", so this isn't required.
    pub fn default_for(company: &str, owner: &str) -> Self {
        Contract { company: company.into(), owner: Some(owner.into()), ..Default::default() }
    }

    pub fn is_company_owner(&self, user: &str) -> bool { self.owner.as_deref() == Some(user) }
    pub fn is_company_admin(&self, user: &str) -> bool { self.admins.iter().any(|a| a == user) }

    /// Horizontal-axis check: does ANY of `principals` (the caller + their teams,
    /// from `principals()`) grant `action` (`"c"`/`"r"`/`"u"`/`"d"`) on
    /// `object_type`? Tier-capping is applied separately by the evaluator (via
    /// `resolve_grant`); this is purely the per-team object-TYPE capability.
    /// Multi-team = union (any team that grants it wins). A user PK isn't a grant
    /// key, so non-team principals contribute nothing.
    pub fn allows(&self, principals: &[String], object_type: &str, action: &str) -> bool {
        principals.iter().any(|p| {
            self.grants
                .get(p)
                .and_then(|by_type| by_type.get(object_type))
                .map_or(false, |acts| acts.iter().any(|a| a == action))
        })
    }
}

/// Load a company's ACTIVE contract (highest version), or `None` if it has none.
/// `None` = "unconfigured" → the evaluator falls back to tier-only (today's
/// behaviour), keeping the rollout non-breaking until a real contract lands.
pub async fn load_contract(pool: &PgPool, company_id: &str) -> sqlx::Result<Option<Contract>> {
    let row: Option<sqlx::types::Json<Contract>> = sqlx::query_scalar(
        "SELECT contract FROM company_rbac WHERE company_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(company_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|j| j.0))
}

// ─── contract-aware evaluator (epic step 2) ────────────────────────────────
// The single gate, now reading both axes: the TIER (vertical, via resolve_grant)
// AND the contract's per-(team, object-TYPE) grant (horizontal). Non-breaking:
// a company with no registered contract evaluates tier-only (today's behaviour).

/// The action being attempted, mapped to its CRUD letter (the contract's grant
/// alphabet) and its framework-default minimum tier (the vertical axis). The
/// contract's object-type grant is the *additional* horizontal gate on top.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action { View, Create, Edit, Delete }

impl Action {
    pub fn crud(self) -> &'static str {
        match self { Action::View => "r", Action::Create => "c", Action::Edit => "u", Action::Delete => "d" }
    }
    /// Default minimum tier for the action. (Per-company contracts tighten the
    /// horizontal axis; this is the universal vertical floor.)
    pub fn min_tier(self) -> Role {
        match self {
            Action::View                 => Role::Viewer,
            Action::Create | Action::Edit => Role::Member,
            Action::Delete               => Role::Admin,
        }
    }
}

/// Canonical object TYPE from a redpash_id prefix (the contract's grant keys use
/// these). PK-anchored — never a name. Unknown prefix → `"unknown"` (fails the
/// grant check, so a new type is default-denied until the contract grants it).
pub fn object_kind(rid: &str) -> &'static str {
    match rid.split('_').next().unwrap_or("") {
        "CAS"  => "case",
        "PRJ"  => "project",
        "FIL"  => "file",
        "CHT"  => "chart",
        "DSH"  => "dashboard",
        "USR"  => "user",
        "CMP"  => "company",
        "TEAM" => "team",
        _      => "unknown",
    }
}

/// The object's company (to load that company's contract) — itself if it IS a
/// company, else the cascade scope (case/project/file → company).
async fn company_of(pool: &PgPool, object: &str) -> sqlx::Result<Option<String>> {
    if object_kind(object) == "company" {
        return Ok(Some(object.to_string()));
    }
    sqlx::query_scalar(
        "SELECT company_id FROM cases    WHERE redpash_id = $1
         UNION SELECT company_id FROM projects WHERE redpash_id = $1
         UNION SELECT p.company_id FROM project_files f
               JOIN projects p ON p.redpash_id = f.project_redpash_id
               WHERE f.redpash_id = $1
         LIMIT 1",
    )
    .bind(object)
    .fetch_optional(pool)
    .await
}

/// PURE decision: combine the resolved `tier` (vertical) with the company's
/// `contract` (horizontal) for `action` on `object_type`. Platform-admin bypass
/// is the caller's job. INVARIANT: `contract == None` → tier-only (non-breaking);
/// `company_owner` → full subtree; `company_admin` is NOT auto-content (fail-closed —
/// it gets only what `grants` give it, org-management lives on the management routes).
fn evaluate(
    grant:       Grant,
    contract:    Option<&Contract>,
    principals:  &[String],
    caller:      &str,
    object_type: &str,
    action:      Action,
) -> bool {
    let tier_ok = grant.effective().map_or(false, |r| r >= action.min_tier());
    match contract {
        None                                    => tier_ok,                 // unconfigured
        Some(c) if c.is_company_owner(caller)   => true,                     // root of this company
        Some(c)                                 => tier_ok && c.allows(principals, object_type, action.crud()),
    }
}

/// Contract-aware gate: `is_platform_admin` bypasses (RedPash root); else the
/// tier (resolve_grant) ∩ the company's contract decide. 404-on-deny (leak-free,
/// same contract as `require_grant`). Non-breaking until a company registers a
/// contract. The target single gate the epic converges every endpoint onto.
pub async fn require_action(
    state:  &AppState,
    caller: &str,
    object: &str,
    action: Action,
) -> Result<(), AppError> {
    if is_platform_admin(state, caller).await? {
        return Ok(());
    }
    let object_type = object_kind(object);
    let grant   = resolve_grant(&state.db, caller, object).await?;
    let company = company_of(&state.db, object).await?;
    let contract = match &company {
        Some(c) => load_contract(&state.db, c).await?,
        None    => None,
    };
    // principals (the recursive team closure) only needed when a contract exists.
    let princ = if contract.is_some() { principals(&state.db, caller).await? } else { Vec::new() };
    if evaluate(grant, contract.as_ref(), &princ, caller, object_type, action) {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("{object_type} {object}")))
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    // Contract object-TYPE keys are the canonical lowercase types `object_kind`
    // produces ("case"/"user"/…), never display names.
    #[test]
    fn deserializes_the_sketch_and_enforces_object_type_grants() {
        let json = r#"{
          "company":"CMP_x","owner":"USR_o","admins":["USR_a"],
          "labels":{"Manager":"owner"},
          "grants":{"TEAM_eng":{"case":["c","r","u","d"],"monitoring":["r"]},
                    "TEAM_hr":{"user":["c","r","u","d"],"payslip":["r"],"case":["c"]}}
        }"#;
        let c: Contract = serde_json::from_str(json).unwrap();
        assert!(c.is_company_owner("USR_o"));
        assert!(c.is_company_admin("USR_a"));
        // Engineering owns cases + monitoring, NOT users
        assert!( c.allows(&["TEAM_eng".into()], "case", "u"));
        assert!(!c.allows(&["TEAM_eng".into()], "user", "u"));
        assert!( c.allows(&["TEAM_eng".into()], "monitoring", "r"));
        assert!(!c.allows(&["TEAM_eng".into()], "monitoring", "u"));
        // HR owns users + payslips; only CREATE on cases
        assert!( c.allows(&["TEAM_hr".into()], "user", "d"));
        assert!( c.allows(&["TEAM_hr".into()], "case", "c"));
        assert!(!c.allows(&["TEAM_hr".into()], "case", "u"));
        // multi-team membership = union of grants
        assert!( c.allows(&["TEAM_eng".into(), "TEAM_hr".into()], "user", "u"));
        // a non-team principal (the user themselves) grants nothing
        assert!(!c.allows(&["USR_o".into()], "case", "u"));
    }

    #[test]
    fn default_for_grants_nothing_until_filled() {
        let c = Contract::default_for("CMP_x", "USR_o");
        assert!(c.is_company_owner("USR_o"));
        assert!(c.grants.is_empty());
        assert!(!c.allows(&["TEAM_eng".into()], "case", "r"));
    }

    #[test]
    fn object_kind_maps_rid_prefixes() {
        assert_eq!(object_kind("CAS_x"), "case");
        assert_eq!(object_kind("USR_x"), "user");
        assert_eq!(object_kind("TEAM_x"), "team");
        assert_eq!(object_kind("FIL_x"), "file");
        assert_eq!(object_kind("ZZZ_x"), "unknown");
    }

    #[test]
    fn action_crud_and_min_tier() {
        assert_eq!(Action::View.crud(), "r");
        assert_eq!(Action::Edit.crud(), "u");
        assert_eq!(Action::View.min_tier(), Role::Viewer);
        assert_eq!(Action::Delete.min_tier(), Role::Admin);
    }

    #[test]
    fn evaluate_combines_tier_and_contract() {
        let member = Grant { direct: Some(Role::Member), scope: None };
        let viewer = Grant { direct: Some(Role::Viewer), scope: None };
        let none   = Grant { direct: None, scope: None };

        // No contract → tier-only (today's behaviour, non-breaking).
        assert!( evaluate(member, None, &[], "USR_u", "case", Action::Edit));
        assert!(!evaluate(viewer, None, &[], "USR_u", "case", Action::Edit)); // viewer < member-min
        assert!(!evaluate(none,   None, &[], "USR_u", "case", Action::View));

        // With a contract: Eng owns case, not user.
        let c: Contract = serde_json::from_str(
            r#"{"owner":"USR_o","grants":{"TEAM_eng":{"case":["c","r","u","d"]}}}"#).unwrap();
        let eng = vec!["USR_u".to_string(), "TEAM_eng".to_string()];
        assert!( evaluate(member, Some(&c), &eng, "USR_u", "case", Action::Edit));   // granted + tier ok
        assert!(!evaluate(member, Some(&c), &eng, "USR_u", "user", Action::Edit));   // no user grant → deny
        assert!(!evaluate(viewer, Some(&c), &eng, "USR_u", "case", Action::Delete)); // tier too low for delete
        // company_owner bypasses the horizontal axis on its whole subtree.
        assert!( evaluate(none,   Some(&c), &[],  "USR_o", "user", Action::Delete));
    }
}
