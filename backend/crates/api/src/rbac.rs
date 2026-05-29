//! RBAC grant resolution.
//!
//! Turns the catalog's role→key grant matrices
//! (`docs/internal/specs/rbac/<entity>.md`) into a computed grant set
//! for a caller, exposed via `GET /api/me` so the frontend's element-
//! gating + (later) route-gating middleware read ONE source instead of
//! re-deriving authorization per handler.
//!
//! SPEC, NOT ENFORCEMENT. This module only *computes + exposes* grants.
//! Nothing gates on them yet — the app stays dev-permissive
//! (`ensure_owner` is the only live gate). See `rbac/index.md`.
//!
//! Slice 1 (this file): the resolution framework + the Case object's
//! matrix (the catalog's locked worked example). The other 12 objects
//! are mechanical additions — one `&[KeyGrants]` const each, appended to
//! `OBJECTS`.
//!
//! Two gaps deliberately deferred (flagged in the slice-1 report):
//!   - **Platform tier:** the catalog cites `users.role`, but no such
//!     column exists yet. `resolve` takes the platform role as
//!     `Option<&str>` — `None` today, so platform-admin (`*@all`) grants
//!     aren't emitted until that column (or an equivalent) lands. Grants
//!     today come from company memberships + `@own`.
//!   - **Project tier:** `project_memberships` is schema-only (inert),
//!     so the project columns from the matrices aren't encoded yet.

use std::collections::BTreeMap;

/// Row-level scope a scoped grant covers. Ordered narrowest→widest so
/// `max` picks the effective scope when a caller holds a key via several
/// role tiers. (`team` — Case Team Member — is pending Em sign-off per
/// `rbac/index.md`; not a variant yet.)
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Scope {
    Own,
    /// Reserved: part of the catalog's closed scope vocabulary, but no
    /// cell emits it yet — the project tier (`project_memberships`) is
    /// inert. Drops the dead-code warning until those columns land.
    #[allow(dead_code)]
    Project,
    Company,
    All,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Own => "own",
            Scope::Project => "project",
            Scope::Company => "company",
            Scope::All => "all",
        }
    }
}

/// One matrix cell. `Held` is a scopeless action grant (`create` — you
/// don't own a row you're creating); `Scoped` carries the row scope. A
/// given key's cells are all the same kind (a key is either scoped or
/// scopeless), so the resolver never has to compare the two.
#[derive(Clone, Copy)]
enum Cell {
    No,
    Held,
    Scoped(Scope),
}

use Cell::{Held, No, Scoped};
use Scope::{All, Company, Own};

/// One key's grants across the role columns we source today: platform
/// admin, the three company roles, and the `@own` column. (Project
/// columns deferred — see the module docs.)
struct KeyGrants {
    key: &'static str,
    plat_admin: Cell,
    co_owner: Cell,
    co_admin: Cell,
    co_member: Cell,
    own: Cell,
}

/// Case — transcribed verbatim from `docs/internal/specs/rbac/case.md`
/// §2 (the catalog's locked worked example). Project columns omitted
/// (project tier inert). `@own` for Case is reporter-OR-assignee, but
/// that two-pronged predicate is an enforcement-time detail; here `own`
/// just means "the caller holds this key for rows they own."
const CASE: &[KeyGrants] = &[
    KeyGrants { key: "case.create",             plat_admin: Held,        co_owner: Held,           co_admin: Held,           co_member: Held,           own: No },
    KeyGrants { key: "case.read",               plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: Scoped(Company), own: Scoped(Own) },
    KeyGrants { key: "case.list",               plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: Scoped(Company), own: Scoped(Own) },
    KeyGrants { key: "case.search",             plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: Scoped(Company), own: Scoped(Own) },
    KeyGrants { key: "case.update",             plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: Scoped(Own) },
    KeyGrants { key: "case.delete",             plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: No },
    KeyGrants { key: "case.type.update",        plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: No },
    KeyGrants { key: "case.title.update",       plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: Scoped(Own) },
    KeyGrants { key: "case.description.update", plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: Scoped(Own) },
    KeyGrants { key: "case.status.update",      plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: Scoped(Company), own: Scoped(Own) },
    KeyGrants { key: "case.priority.update",    plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: No },
    KeyGrants { key: "case.assignee.update",    plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: Scoped(Own) },
    KeyGrants { key: "case.project.update",     plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: No },
    KeyGrants { key: "case.company.update",     plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: No,             co_member: No,             own: No },
    KeyGrants { key: "case.error_message.update", plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,           own: Scoped(Own) },
    KeyGrants { key: "case.category.update",    plat_admin: Scoped(All), co_owner: Scoped(Company), co_admin: Scoped(Company), co_member: No,             own: No },
];

/// Every encoded object's matrix. Slice 1: Case only; append the other
/// 12 (`user`, `company`, `project`, `file`, `step`, `comment`,
/// `case-category`, `membership`, `event`, `user-preference`, `chart`,
/// `dashboard`, `report`) as each catalog doc is transcribed.
const OBJECTS: &[&[KeyGrants]] = &[CASE];

fn apply(c: Cell, held: &mut bool, widest: &mut Option<Scope>) {
    match c {
        Cell::No => {}
        Cell::Held => *held = true,
        Cell::Scoped(s) => *widest = Some(widest.map_or(s, |w| w.max(s))),
    }
}

/// Resolve a caller's effective grant set: `key → widest scope`
/// (`own`/`project`/`company`/`all`), or `"yes"` for a held scopeless
/// action (`create`). Union across the role tiers the caller holds; the
/// widest scope wins per key. Keys the caller holds at no tier are
/// omitted.
///
/// - `platform_role`: the caller's `users.role` — `None` until that
///   column exists, so no platform-admin grants today.
/// - `company_roles`: the caller's `company_memberships.role` values
///   (across every company they belong to).
/// - `@own` always applies: a caller can own rows (reporter / assignee /
///   owner), so every key with an `@own` grant is held at (≥) `own`.
pub fn resolve(platform_role: Option<&str>, company_roles: &[&str]) -> BTreeMap<String, String> {
    let is_plat_admin = platform_role == Some("admin");
    let mut out = BTreeMap::new();
    for object in OBJECTS {
        for kg in *object {
            let mut held = false;
            let mut widest: Option<Scope> = None;
            if is_plat_admin {
                apply(kg.plat_admin, &mut held, &mut widest);
            }
            for r in company_roles {
                match *r {
                    "owner" => apply(kg.co_owner, &mut held, &mut widest),
                    "admin" => apply(kg.co_admin, &mut held, &mut widest),
                    "member" => apply(kg.co_member, &mut held, &mut widest),
                    _ => {}
                }
            }
            apply(kg.own, &mut held, &mut widest); // @own always applies
            if held {
                out.insert(kg.key.to_string(), "yes".to_string());
            } else if let Some(s) = widest {
                out.insert(kg.key.to_string(), s.as_str().to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope_of<'a>(g: &'a BTreeMap<String, String>, k: &str) -> Option<&'a str> {
        g.get(k).map(String::as_str)
    }

    #[test]
    fn company_admin_gets_company_scoped_case_grants() {
        let g = resolve(None, &["admin"]);
        assert_eq!(scope_of(&g, "case.read"), Some("company"));
        assert_eq!(scope_of(&g, "case.delete"), Some("company"));
        assert_eq!(scope_of(&g, "case.create"), Some("yes"));
        // a company admin can't move a case to another company (owner-only)
        assert_eq!(scope_of(&g, "case.company.update"), None);
    }

    #[test]
    fn company_member_holds_the_collaborative_subset() {
        let g = resolve(None, &["member"]);
        assert_eq!(scope_of(&g, "case.read"), Some("company"));
        // the kanban flow: members advance status on company cases
        assert_eq!(scope_of(&g, "case.status.update"), Some("company"));
        // but can't delete or reprioritize company cases
        assert_eq!(scope_of(&g, "case.delete"), None);
        assert_eq!(scope_of(&g, "case.priority.update"), None);
        // @own still lets them retitle their own case
        assert_eq!(scope_of(&g, "case.title.update"), Some("own"));
    }

    #[test]
    fn no_membership_resolves_own_only() {
        let g = resolve(None, &[]);
        assert_eq!(scope_of(&g, "case.read"), Some("own"));
        assert_eq!(scope_of(&g, "case.status.update"), Some("own"));
        // create needs a role (no @own column); delete is never @own
        assert_eq!(scope_of(&g, "case.create"), None);
        assert_eq!(scope_of(&g, "case.delete"), None);
    }

    #[test]
    fn platform_admin_is_all() {
        let g = resolve(Some("admin"), &[]);
        assert_eq!(scope_of(&g, "case.read"), Some("all"));
        assert_eq!(scope_of(&g, "case.delete"), Some("all"));
        assert_eq!(scope_of(&g, "case.create"), Some("yes"));
    }

    #[test]
    fn widest_scope_wins_across_tiers() {
        // member in one company, admin in another → admin's wider grants win
        let g = resolve(None, &["member", "admin"]);
        assert_eq!(scope_of(&g, "case.delete"), Some("company")); // admin grants it
        assert_eq!(scope_of(&g, "case.read"), Some("company"));
    }
}
