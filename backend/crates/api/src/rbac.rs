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

use crate::type_cache::TypeDefCache;
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

/// Generic write/access gate. LEAN SINGLE-USER NEUTER (CAS_C8A9): admits
/// unconditionally with ZERO per-request RBAC/membership SQL — it returns
/// `Ok(())` before the pool is ever touched, so the sole user is never denied
/// and no `resolve_grant`/`is_platform_admin` query runs. The signature is
/// UNCHANGED (`rule`, `label`, `object` retained) so every call site compiles;
/// the multi-tenant body that consulted the `rule` closure against a resolved
/// `Grant` lives in the `full-app-pre-slim` snapshot.
pub async fn require_grant(
    _state:  &AppState,
    _caller: &str,
    _object: &str,
    _label:  &str,
    _rule:   impl Fn(Grant) -> bool,
) -> Result<(), AppError> {
    Ok(())
}

/// View gate (`*.view`). LEAN SINGLE-USER NEUTER (CAS_C8A9): admits with zero
/// per-request SQL (signature unchanged; see `require_grant`).
pub async fn require_view(
    _state:  &AppState,
    _caller: &str,
    _object: &str,
    _label:  &str,
) -> Result<(), AppError> {
    Ok(())
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

/// The object's company (to load that company's contract) — itself if it IS a
/// company, else the cascade scope (case/project/file → company). `object_kind`
/// is registry-driven (the `TypeDefCache`), so a new type resolves without a
/// code edit (object-registry Stage 1; this also fixes the legacy `TEM_`/`TEAM`
/// + adds `CON_` mis-dispatch — see type_cache::object_kind).
async fn company_of(cache: &TypeDefCache, pool: &PgPool, object: &str) -> sqlx::Result<Option<String>> {
    if cache.object_kind(object) == "company" {
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

/// Contract-aware gate. LEAN SINGLE-USER NEUTER (CAS_C8A9): admits
/// unconditionally with ZERO per-request RBAC/membership SQL — returns `Ok(())`
/// before the pool is touched (no `resolve_grant`/`company_of`/`load_contract`).
/// Signature unchanged (`action: Action` retained) so all call sites compile.
/// The multi-tenant tier ∩ contract decision lives in the `full-app-pre-slim`
/// snapshot.
pub async fn require_action(
    _state:  &AppState,
    _caller: &str,
    _object: &str,
    _action: Action,
) -> Result<(), AppError> {
    Ok(())
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

// ─── RBAC-neuter gate tests (CAS_C8A9A3EC0935498880A468625FE3F490) ──────────
// Tester-owned (the coder cannot edit this module). Lean single-user-mode
// neuter: the four gate fns + require_platform_admin_mw admit unconditionally,
// then the multi-tenant machinery (resolve_grant / GRANT_SQL / EDGES_SQL /
// principals / Contract / load_contract / company_of / evaluate) is deleted.
// CHECKPOINT-1 APPROVED scope (the authoritative comment on the Case).
//
// RED-now / GREEN-after design — the honest proof of "ZERO per-request RBAC SQL":
//   We build an AppState whose `db` is a LAZY pool pointed at an unreachable
//   address (127.0.0.1:1 — connection refused the instant any query runs) and a
//   `TypeDefCache::default()` (no DB). The caller is a NON-dev RID.
//   • TODAY: require_grant/require_view/require_action with a non-dev caller call
//     `resolve_grant` (and friends) → the lazy pool tries to connect → Err. The
//     gate returns Err, so `is_ok()` is FALSE → these tests FAIL (correct red).
//   • AFTER the no-op-neuter: the gate returns Ok(()) before touching the pool →
//     these tests PASS (green). A green here is a PROOF the gate did no SQL,
//     because the only pool available would have errored on the first query.
//
// We deliberately use a NON-dev caller: a dev_user caller already trips the
// `is_platform_admin` fast-path (Ok with no SQL) TODAY, so it can't distinguish
// "neutered" from "not neutered" — it would be a fake-green (the same trap the
// objects.rs IDOR harness flags). The dev_user path is asserted separately as
// the floor that must STILL hold.
#[cfg(test)]
mod neuter_tests {
    use super::*;
    use crate::state::{AppState, FileEntry};
    use dashmap::DashMap;
    use std::{path::PathBuf, sync::Arc};

    const DEV: &str = "USR_dev_bootstrap";
    const NON_DEV: &str = "USR_some_other_caller";
    const OBJECT: &str = "CMP_target_object";

    /// An AppState backed by a LAZY pool to an unreachable DB. `connect_lazy`
    /// never opens a socket until the first query — so a gate that returns Ok
    /// WITHOUT querying never touches it, and a gate that DOES query gets a
    /// connection-refused Err. That asymmetry is the AC-5 "zero per-request SQL"
    /// oracle. `type_cache` is the empty registry (object_kind is pure/in-memory).
    fn state_with_dead_pool() -> AppState {
        // Port 1 is unbound; connect_lazy defers the failing connect to query
        // time. A short acquire_timeout makes the RED state (a gate that still
        // queries) fail FAST instead of waiting the default 30s connect timeout
        // — once the gate is neutered it returns Ok before the pool is touched,
        // so the timeout is never hit in the green state.
        let db: PgPool = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/nodb")
            .expect("connect_lazy parses the URL without connecting");
        AppState {
            db,
            files:               Arc::new(DashMap::<String, FileEntry>::new()),
            data_dir:            Arc::new(PathBuf::from("/tmp/redpash-neuter-test")),
            dev_user:            Arc::new(DEV.to_string()),
            oauth:               None,
            http:                reqwest::Client::default(),
            avatars:             Arc::new(DashMap::new()),
            dev_login:           false,
            internal_company_id: Arc::new(None),
            type_cache:          Arc::new(crate::type_cache::TypeDefCache::empty()),
        }
    }

    // ── AC-5 / AC-6: require_view admits a NON-dev caller with no SQL ─────────
    #[tokio::test]
    async fn ac5_require_view_admits_non_dev_caller_without_touching_the_pool() {
        let state = state_with_dead_pool();
        let r = require_view(&state, NON_DEV, OBJECT, "object").await;
        assert!(
            r.is_ok(),
            "require_view denied/errored for a non-dev caller — in lean single-user mode it must \
             admit unconditionally with ZERO per-request SQL (a query against the dead pool would \
             have errored; an Err here means the multi-tenant resolve_grant path still runs). got: {r:?}"
        );
    }

    // ── AC-5 / AC-6: require_grant admits regardless of the closure rule ──────
    #[tokio::test]
    async fn ac5_require_grant_admits_non_dev_caller_without_touching_the_pool() {
        let state = state_with_dead_pool();
        // A rule that REJECTS every grant — proves the neuter short-circuits
        // BEFORE the rule is even consulted (no resolve_grant, no rule eval).
        let r = require_grant(&state, NON_DEV, OBJECT, "object", |_g| false).await;
        assert!(
            r.is_ok(),
            "require_grant denied/errored for a non-dev caller (even with an always-false rule) — \
             lean mode must admit before resolving any Grant. An Err means resolve_grant queried \
             the dead pool. got: {r:?}"
        );
    }

    // ── AC-5 / AC-6: require_action (the contract-aware gate) admits ──────────
    #[tokio::test]
    async fn ac5_require_action_admits_non_dev_caller_without_touching_the_pool() {
        let state = state_with_dead_pool();
        for action in [Action::View, Action::Create, Action::Edit, Action::Delete] {
            let r = require_action(&state, NON_DEV, OBJECT, action).await;
            assert!(
                r.is_ok(),
                "require_action({action:?}) denied/errored for a non-dev caller — lean mode must \
                 admit before resolve_grant/company_of/load_contract/principals run. An Err means \
                 one of those queried the dead pool. got: {r:?}"
            );
        }
    }

    // ── AC-6 floor: the dev_user path STILL admits (must never regress) ───────
    #[tokio::test]
    async fn ac6_dev_user_still_admits_across_all_gates() {
        let state = state_with_dead_pool();
        assert!(require_view(&state, DEV, OBJECT, "object").await.is_ok(),
            "dev_user must still pass require_view in lean mode");
        assert!(require_grant(&state, DEV, OBJECT, "object", |_g| false).await.is_ok(),
            "dev_user must still pass require_grant in lean mode");
        assert!(require_action(&state, DEV, OBJECT, Action::Delete).await.is_ok(),
            "dev_user must still pass require_action in lean mode");
    }
}
