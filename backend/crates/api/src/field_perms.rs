//! Purpose: the **field registry** — every object field as a row, its
//! properties (`is_editable`, `is_sortable`) + the per-role permission state
//! (`owner`/`admin`/`member`/`viewer`) as columns. A redtable of fields, the
//! same way the cleaner is a redtable of columns (CAS_C4219F2B).
//! Doc: docs/internal/code/backend/api/field_perms.md
//!
//! Slice 1: the static catalog, authored from the `docs/internal/specs/rbac/`
//! per-field atoms + reaches + the shared DTO shapes. Read-only here; the
//! `field_permissions` override table + handler enforcement + the FE redtable
//! are later slices. The 4 membership tiers are fixed columns; the configurable
//! axis is the per-field permission.
//!
//! Scope: the **membership-bearing** object types (company / project / case /
//! team / file / chart / dashboard) — where a caller's tier on the object (the
//! resolver's `effective()`) maps onto these columns. `user` (a subject) and
//! `comment` (author-gated) are governed differently and stay out of the grid.

use serde::Serialize;

/// Permission for one `(field, role)` cell. `Write` implies `Read`. Ordered so
/// "at least Read" becomes a `>=` once enforcement lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Perm {
    None,
    Read,
    Write,
}

use Perm::{None as N, Read as R, Write as W};

impl Perm {
    pub fn as_str(self) -> &'static str {
        match self {
            Perm::None => "none",
            Perm::Read => "read",
            Perm::Write => "write",
        }
    }
    pub fn from_str(s: &str) -> Option<Perm> {
        match s {
            "none" => Some(Perm::None),
            "read" => Some(Perm::Read),
            "write" => Some(Perm::Write),
            _ => None,
        }
    }
}

/// One field row in the registry — the redtable row. `is_editable` = the field
/// has an update path (a write atom); read-only / computed fields are `false`
/// and read-only for every role. `is_sortable` = the list views allow ordering
/// on it. `owner/admin/member/viewer` = the per-role permission state.
#[derive(Debug, Clone, Serialize)]
pub struct FieldRow {
    pub object:      &'static str,
    pub field:       &'static str,
    pub is_editable: bool,
    pub is_sortable: bool,
    pub owner:       Perm,
    pub admin:       Perm,
    pub member:      Perm,
    pub viewer:      Perm,
    /// True once any of this row's cells has been overridden away from the
    /// catalog default (set during the GET merge). Lets the FE highlight
    /// customized rows.
    #[serde(default)]
    pub is_overridden: bool,
}

impl FieldRow {
    /// Set the cell for `role` and mark the row overridden. No-op for an
    /// unknown role. Used by the GET merge to overlay `field_permissions` rows.
    pub fn apply_override(&mut self, role: &str, perm: Perm) {
        match role {
            "owner" => self.owner = perm,
            "admin" => self.admin = perm,
            "member" => self.member = perm,
            "viewer" => self.viewer = perm,
            _ => return,
        }
        self.is_overridden = true;
    }
    /// The catalog-default perm for `role` (pre-override), for the PUT handler's
    /// "reverting to default deletes the override row" logic.
    pub fn default_for(&self, role: &str) -> Option<Perm> {
        match role {
            "owner" => Some(self.owner),
            "admin" => Some(self.admin),
            "member" => Some(self.member),
            "viewer" => Some(self.viewer),
            _ => None,
        }
    }
}

/// Look up the catalog row (defaults) for an `(object, field)` — the PUT
/// handler validates against this and reads the default for the revert check.
pub fn find_default(object: &str, field: &str) -> Option<FieldRow> {
    default_registry().into_iter().find(|r| r.object == object && r.field == field)
}

/// Editable field — carries the per-role permission tuple.
const fn ed(object: &'static str, field: &'static str, is_sortable: bool,
            owner: Perm, admin: Perm, member: Perm, viewer: Perm) -> FieldRow {
    FieldRow { object, field, is_editable: true, is_sortable, owner, admin, member, viewer, is_overridden: false }
}
/// Read-only / computed field — readable by everyone, writable by none.
const fn ro(object: &'static str, field: &'static str, is_sortable: bool) -> FieldRow {
    FieldRow { object, field, is_editable: false, is_sortable,
               owner: R, admin: R, member: R, viewer: R, is_overridden: false }
}

/// The default field registry. Default perm rules (overridable later):
/// standard updatable `W W R R`; owner-grade (ownership/re-parent/default)
/// `W R R R`; case content (participant-editable) `W W W R`; personal pin
/// (`dashboard.is_favorite`) `W N N N`; read-only/computed `R R R R`.
pub fn default_registry() -> Vec<FieldRow> {
    vec![
        // ── company ──────────────────────────────────────────────────────
        ed("company", "name",        true,  W, W, R, R),
        ed("company", "slug",        true,  W, W, R, R),
        ed("company", "avatar_url",  false, W, W, R, R),
        ro("company", "redpash_id",  false),
        ro("company", "member_count",true),
        ro("company", "created_at",  true),
        // ── project ──────────────────────────────────────────────────────
        ed("project", "name",        true,  W, W, R, R),
        ed("project", "description", false, W, W, R, R),
        ed("project", "status",      true,  W, W, R, R),
        ed("project", "is_default",  true,  W, R, R, R), // owner-grade — personal default
        ed("project", "owner",       true,  W, R, R, R), // owner-grade — ownership transfer
        ed("project", "company",     true,  W, R, R, R), // owner-grade — re-scope to a company
        ro("project", "redpash_id",  false),
        ro("project", "stage",       true),              // computed from files
        ro("project", "file_count",  true),
        ro("project", "created_at",  true),
        ro("project", "updated_at",  true),
        // ── case ─────────────────────────────────────────────────────────
        ed("case", "title",         true,  W, W, W, R), // case content — participants edit
        ed("case", "description",   false, W, W, W, R),
        ed("case", "status",        true,  W, W, W, R),
        ed("case", "priority",      true,  W, W, W, R),
        ed("case", "type",          true,  W, W, W, R),
        ed("case", "assignee",      true,  W, W, W, R),
        ed("case", "category",      true,  W, W, W, R),
        ed("case", "error_message", false, W, W, R, R),
        ed("case", "project",       true,  W, W, R, R), // re-scope — admin+
        ed("case", "company",       true,  W, W, R, R),
        ro("case", "redpash_id",    false),
        ro("case", "reporter_id",   true),
        ro("case", "created_at",    true),
        ro("case", "updated_at",    true),
        // ── team ─────────────────────────────────────────────────────────
        ed("team", "name",        true,  W, W, R, R),
        ed("team", "company_id",  true,  W, R, R, R), // owner-grade — re-parent
        ed("team", "kind",        true,  W, R, R, R), // team|department — owner-grade
        ro("team", "redpash_id",  false),
        ro("team", "member_count",true),
        ro("team", "created_at",  true),
        // ── file ─────────────────────────────────────────────────────────
        ed("file", "display_name", true,  W, W, R, R),
        ed("file", "encoding",     false, W, W, R, R),
        ed("file", "delimiter",    false, W, W, R, R),
        ed("file", "project",      true,  W, W, R, R), // move (double-gated on destination)
        ro("file", "redpash_id",   false),
        ro("file", "filename",     true),
        ro("file", "stage",        true),
        ro("file", "row_count",    true),
        ro("file", "created_at",   true),
        // ── chart ────────────────────────────────────────────────────────
        ed("chart", "title",          true,  W, W, R, R),
        ed("chart", "spec",           false, W, W, R, R), // blob — not sortable
        ed("chart", "source_file_id", true,  W, W, R, R),
        ed("chart", "project",        true,  W, W, R, R),
        ro("chart", "redpash_id",     false),
        ro("chart", "created_at",     true),
        // ── dashboard ────────────────────────────────────────────────────
        ed("dashboard", "title",       true,  W, W, R, R),
        ed("dashboard", "description", false, W, W, R, R),
        ed("dashboard", "spec",        false, W, W, R, R), // blob
        ed("dashboard", "folder",      true,  W, W, R, R),
        ed("dashboard", "is_public",   true,  W, W, R, R), // publish — owner/company-admin
        ed("dashboard", "is_favorite", true,  W, N, N, N), // personal pin — owner only
        ro("dashboard", "redpash_id",  false),
        ro("dashboard", "created_at",  true),
    ]
}
