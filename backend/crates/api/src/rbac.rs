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

use crate::{error::AppError, state::AppState};

// Post-neuter, only the #[cfg(test)] neuter_tests dead-pool oracle still names
// PgPool; the runtime gates admit before any pool is touched. cfg-gating the
// import keeps the non-test build warning-clean now that load_contract /
// company_of (the only runtime PgPool namers) are gone.
#[cfg(test)]
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
