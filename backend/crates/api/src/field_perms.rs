//! Purpose: the **field registry** — every object field as a `FieldRow`
//! (= the spec's FieldDef): identity + storage (`data_type`) + presentation
//! (`editor`/`options`/`rel`) + permission (`perm_class` → per-role cells) +
//! `is_editable`/`is_sortable`. The redtable of fields (CAS_C4219F2B) AND the
//! per-type field catalog the TypeDefinition contract serves (CAS_0FBF301F §3/§4).
//! Doc: docs/internal/code/backend/api/field_perms.md
//!
//! Per-role permissions DERIVE from `perm_class` (not hand-authored per field),
//! so a custom object's fields resolve without source-code defaults — the
//! disposability requirement (spec §3.3). The `field_permissions` override
//! table layers on top (the existing /admin/fields merge); `require_fields`
//! enforces on write.
//!
//! Scope: the membership-bearing object types (company / project / case / team /
//! file / chart / dashboard) — where the resolver's `effective()` tier maps onto
//! these columns. `user` (a subject) and `comment` (author-gated) stay out.

use axum::http::StatusCode;
use serde::Serialize;

use crate::{error::AppError, state::AppState};

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

/// The permission class of a field — the per-role default matrix DERIVES from
/// it (spec §3.1), so custom objects resolve without hand-authored defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermClass {
    /// `W W R R` — default editable field (owner/admin write, below read).
    Standard,
    /// `W W W R` — member-writable content (case fields; participants edit).
    Collaborative,
    /// `W R R R` — ownership transfer / re-parent / personal-default flag.
    OwnerGrade,
    /// `W N N N` — owner-only personal pin (e.g. dashboard.is_favorite).
    Personal,
    /// `R R R R` — computed / system-managed (is_editable=false).
    Readonly,
}

impl PermClass {
    /// Wire string (matches the serde snake_case repr); the type registry uses
    /// it to stamp `perm_class` onto a FieldDef.
    pub fn as_str(self) -> &'static str {
        match self {
            PermClass::Standard => "standard",
            PermClass::Collaborative => "collaborative",
            PermClass::OwnerGrade => "owner_grade",
            PermClass::Personal => "personal",
            PermClass::Readonly => "readonly",
        }
    }
    /// Parse the stored wire string (TypeDefCache load) back to the enum.
    pub fn from_str(s: &str) -> Option<PermClass> {
        match s {
            "standard"      => Some(PermClass::Standard),
            "collaborative" => Some(PermClass::Collaborative),
            "owner_grade"   => Some(PermClass::OwnerGrade),
            "personal"      => Some(PermClass::Personal),
            "readonly"      => Some(PermClass::Readonly),
            _               => None,
        }
    }
    /// `[owner, admin, member, viewer]`.
    fn cells(self) -> [Perm; 4] {
        match self {
            PermClass::Standard      => [W, W, R, R],
            PermClass::Collaborative => [W, W, W, R],
            PermClass::OwnerGrade    => [W, R, R, R],
            PermClass::Personal      => [W, N, N, N],
            PermClass::Readonly      => [R, R, R, R],
        }
    }
}

/// A relationship field → another type (e.g. `case.assignee_id` → `user`).
/// Lets pickers + rid write-validation work without hardcoding (spec §2).
#[derive(Debug, Clone, Serialize)]
pub struct Rel {
    #[serde(rename = "type")]
    pub ty:    &'static str,
    pub multi: bool,
}

/// One field row in the registry = the spec's FieldDef. The per-role cells
/// (`owner`/`admin`/`member`/`viewer`) are derived from `perm_class` at
/// construction; `field_permissions` overrides layer on at serve time.
#[derive(Debug, Clone, Serialize)]
pub struct FieldRow {
    pub object:      &'static str,
    pub field:       &'static str,
    pub is_editable: bool,
    pub is_sortable: bool,
    /// Storage type — backend-owned, write-validated (spec §4.2).
    pub data_type:   &'static str,
    /// Presentation editor id — opaque to the backend, FE-resolved (spec §5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor:      Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options:     Vec<&'static str>,
    pub perm_class:  PermClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel:         Option<Rel>,
    pub owner:       Perm,
    pub admin:       Perm,
    pub member:      Perm,
    pub viewer:      Perm,
    /// Set during the GET merge when a cell is overridden away from the default.
    #[serde(default)]
    pub is_overridden: bool,
}

impl FieldRow {
    /// Set the cell for `role` and mark the row overridden (the GET merge).
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
    /// The catalog-default perm for `role` (pre-override) — the PUT revert check.
    pub fn default_for(&self, role: &str) -> Option<Perm> {
        match role {
            "owner" => Some(self.owner),
            "admin" => Some(self.admin),
            "member" => Some(self.member),
            "viewer" => Some(self.viewer),
            _ => None,
        }
    }
    // ── builder modifiers (default_registry authoring) ──
    fn nosort(mut self) -> Self { self.is_sortable = false; self }
    fn opts(mut self, o: &[&'static str]) -> Self { self.options = o.to_vec(); self }
    fn rel(mut self, ty: &'static str, multi: bool) -> Self { self.rel = Some(Rel { ty, multi }); self }

    /// Reconstruct a row from stored inputs (the TypeDefCache load path) — the
    /// SAME derivation as `fld()`: the per-role cells + default editor +
    /// is_editable come from `(data_type, perm_class)`, never stored, so the
    /// seeded rows can't drift from the derivation. Strings are interned to
    /// `&'static str` by the caller (the cache lives for the process).
    pub(crate) fn from_parts(
        object:      &'static str,
        field:       &'static str,
        data_type:   &'static str,
        perm_class:  PermClass,
        is_sortable: bool,
        options:     Vec<&'static str>,
        rel:         Option<Rel>,
    ) -> Self {
        let [owner, admin, member, viewer] = perm_class.cells();
        FieldRow {
            object,
            field,
            is_editable: !matches!(perm_class, PermClass::Readonly),
            is_sortable,
            data_type,
            editor: default_editor(data_type, perm_class),
            options,
            perm_class,
            rel,
            owner,
            admin,
            member,
            viewer,
            is_overridden: false,
        }
    }
}

/// Default editor id for a `data_type` (readonly fields get none). Opaque to the
/// backend — the FE editor-registry resolves it, falling back to "text".
fn default_editor(data_type: &str, pc: PermClass) -> Option<&'static str> {
    if matches!(pc, PermClass::Readonly) {
        return None;
    }
    Some(match data_type {
        "enum"    => "chip-enum",
        "rid"     => "entity-picker",
        "boolean" => "toggle",
        _         => "text", // string / markdown / int / float / datetime / json
    })
}

/// Field builder — derives the per-role cells + is_editable + default editor.
/// Sortable by default; chain `.nosort()` / `.opts()` / `.rel()`.
fn fld(object: &'static str, field: &'static str, data_type: &'static str, pc: PermClass) -> FieldRow {
    let [owner, admin, member, viewer] = pc.cells();
    FieldRow {
        object,
        field,
        is_editable: !matches!(pc, PermClass::Readonly),
        is_sortable: true,
        data_type,
        editor: default_editor(data_type, pc),
        options: Vec::new(),
        perm_class: pc,
        rel: None,
        owner,
        admin,
        member,
        viewer,
        is_overridden: false,
    }
}

/// Look up the catalog row (defaults) for an `(object, field)`.
pub fn find_default(object: &str, field: &str) -> Option<FieldRow> {
    default_registry().into_iter().find(|r| r.object == object && r.field == field)
}

/// The default field registry — the 5 builtin membership-object types' fields.
/// Per-role perms derive from `perm_class`; the existing /admin/fields perms are
/// preserved exactly (Standard=WWRR, Collaborative=WWWR, OwnerGrade=WRRR,
/// Personal=WNNN, Readonly=RRRR). Builtin = "built-in custom objects" (spec Q5).
pub fn default_registry() -> Vec<FieldRow> {
    use PermClass::{Collaborative, OwnerGrade, Personal, Readonly, Standard};
    vec![
        // ── company ──────────────────────────────────────────────────────
        fld("company", "name", "string", Standard),
        fld("company", "slug", "string", Standard),
        fld("company", "avatar_url", "string", Standard).nosort(),
        fld("company", "redpash_id", "rid", Readonly).nosort(),
        fld("company", "member_count", "int", Readonly),
        fld("company", "created_at", "datetime", Readonly),
        // ── project ──────────────────────────────────────────────────────
        fld("project", "name", "string", Standard),
        fld("project", "description", "markdown", Standard).nosort(),
        fld("project", "status", "enum", Standard).opts(&["draft", "active", "archived"]),
        fld("project", "is_default", "boolean", OwnerGrade),
        fld("project", "owner", "rid", OwnerGrade).rel("user", false),
        fld("project", "company", "rid", OwnerGrade).rel("company", false),
        fld("project", "redpash_id", "rid", Readonly).nosort(),
        fld("project", "stage", "string", Readonly),
        fld("project", "file_count", "int", Readonly),
        fld("project", "created_at", "datetime", Readonly),
        fld("project", "updated_at", "datetime", Readonly),
        // ── case ─────────────────────────────────────────────────────────
        fld("case", "title", "string", Collaborative),
        fld("case", "description", "markdown", Collaborative).nosort(),
        fld("case", "status", "enum", Collaborative).opts(&["backlog", "todo", "in_progress", "in_review", "done"]),
        fld("case", "priority", "enum", Collaborative).opts(&["low", "medium", "high", "critical"]),
        fld("case", "type", "enum", Collaborative).opts(&["bug", "feature", "task", "epic"]),
        fld("case", "assignee", "rid", Collaborative).rel("user", false),
        fld("case", "category", "rid", Collaborative).rel("case_category", false),
        fld("case", "error_message", "string", Standard).nosort(),
        fld("case", "project", "rid", Standard).rel("project", false),
        fld("case", "company", "rid", Standard).rel("company", false),
        fld("case", "redpash_id", "rid", Readonly).nosort(),
        fld("case", "reporter_id", "rid", Readonly).rel("user", false),
        fld("case", "created_at", "datetime", Readonly),
        fld("case", "updated_at", "datetime", Readonly),
        // ── team ─────────────────────────────────────────────────────────
        fld("team", "name", "string", Standard),
        fld("team", "company_id", "rid", OwnerGrade).rel("company", false),
        fld("team", "kind", "enum", OwnerGrade).opts(&["team", "department"]),
        fld("team", "redpash_id", "rid", Readonly).nosort(),
        fld("team", "member_count", "int", Readonly),
        fld("team", "created_at", "datetime", Readonly),
        // ── file ─────────────────────────────────────────────────────────
        fld("file", "display_name", "string", Standard),
        fld("file", "encoding", "string", Standard).nosort(),
        fld("file", "delimiter", "string", Standard).nosort(),
        fld("file", "project", "rid", Standard).rel("project", false),
        fld("file", "redpash_id", "rid", Readonly).nosort(),
        fld("file", "filename", "string", Readonly),
        fld("file", "stage", "string", Readonly),
        fld("file", "row_count", "int", Readonly),
        fld("file", "created_at", "datetime", Readonly),
        // ── chart ────────────────────────────────────────────────────────
        fld("chart", "title", "string", Standard),
        fld("chart", "spec", "json", Standard).nosort(),
        fld("chart", "source_file_id", "rid", Standard).rel("file", false),
        fld("chart", "project", "rid", Standard).rel("project", false),
        fld("chart", "redpash_id", "rid", Readonly).nosort(),
        fld("chart", "created_at", "datetime", Readonly),
        // ── dashboard ────────────────────────────────────────────────────
        fld("dashboard", "title", "string", Standard),
        fld("dashboard", "description", "markdown", Standard).nosort(),
        fld("dashboard", "spec", "json", Standard).nosort(),
        fld("dashboard", "folder", "string", Standard),
        fld("dashboard", "is_public", "boolean", Standard),
        fld("dashboard", "is_favorite", "boolean", Personal),
        fld("dashboard", "redpash_id", "rid", Readonly).nosort(),
        fld("dashboard", "created_at", "datetime", Readonly),
    ]
}

fn db_err(e: sqlx::Error) -> AppError {
    AppError::internal("db", e.to_string())
}

/// Field-level write gate (CAS_C4219F2B slice 3). After the coarse object gate
/// has admitted the caller, this refines per field: each field being written
/// must be `Write` for the caller's **effective tier** on the object in the
/// merged matrix (catalog defaults ⊕ `field_permissions` overrides). Platform
/// admins bypass. 403 naming the first field the tier can't write.
pub async fn require_fields(
    state:       &AppState,
    caller:      &str,
    object_rid:  &str,
    object_type: &str,
    fields:      &[&str],
) -> Result<(), AppError> {
    if fields.is_empty() {
        return Ok(());
    }
    if crate::rbac::is_platform_admin(state, caller).await.map_err(db_err)? {
        return Ok(());
    }
    let role = match crate::rbac::resolve_grant(&state.db, caller, object_rid)
        .await
        .map_err(db_err)?
        .effective()
    {
        Some(tier) => tier.as_str(),
        None => return Err(forbidden("no access")),
    };
    let overrides: Vec<(String, String)> = sqlx::query_as(
        "SELECT field, permission FROM field_permissions WHERE object_type = $1 AND role = $2",
    )
    .bind(object_type)
    .bind(role)
    .fetch_all(&state.db)
    .await
    .map_err(db_err)?;
    let registry = default_registry();
    for f in fields {
        let mut perm = registry
            .iter()
            .find(|r| r.object == object_type && r.field == *f)
            .and_then(|r| r.default_for(role))
            .unwrap_or(Perm::None);
        if let Some((_, p)) = overrides.iter().find(|(fld, _)| fld == f) {
            if let Some(pp) = Perm::from_str(p) {
                perm = pp;
            }
        }
        if perm != Perm::Write {
            return Err(AppError {
                status:  StatusCode::FORBIDDEN,
                kind:    "field_forbidden",
                message: format!("your role ({role}) can't edit {object_type}.{f}").into(),
                inner:   None,
            });
        }
    }
    Ok(())
}

fn forbidden(msg: &'static str) -> AppError {
    AppError { status: StatusCode::FORBIDDEN, kind: "forbidden", message: msg.into(), inner: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stage 0 (CAS_0FBF301F): the `case.status` PATCH gate reads its enum +
    /// options from the field catalog, not a hardcoded `matches!`. Pin that the
    /// registry row exists with the expected shape, and that the validator —
    /// driven by it — accepts a valid status and rejects an invalid one with
    /// `rule_code = data_type`.
    #[test]
    fn case_status_drives_registry_validation() {
        let def = find_default("case", "status").expect("case.status in registry");
        assert_eq!(def.data_type, "enum");
        for s in ["backlog", "todo", "in_progress", "in_review", "done"] {
            assert!(def.options.contains(&s), "status option {s} missing from registry");
        }

        let ok = crate::validate_rules::validate_value(
            def.data_type, &def.options, "status", &[],
            &serde_json::json!("in_progress"), &crate::validate_rules::Row::new(),
        );
        assert!(ok.is_ok(), "valid status must pass");

        let bad = crate::validate_rules::validate_value(
            def.data_type, &def.options, "status", &[],
            &serde_json::json!("frozen"), &crate::validate_rules::Row::new(),
        );
        assert!(!bad.is_ok(), "invalid status must fail");
        assert_eq!(bad.errors[0].rule_code, "data_type");
    }
}
