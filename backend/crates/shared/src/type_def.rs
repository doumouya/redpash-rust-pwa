//! Purpose: the TypeDefinition wire contract — the runtime-typed object shape
//! every framework module consumes instead of hardcoding the builtin types
//! (spec docs/internal/specs/type-definition.md §2). Served by
//! `GET /api/admin/types`. Forward-compatible with user-defined custom objects.
//! Doc: docs/internal/code/backend/shared/type_def.md

use serde::Serialize;
use std::collections::BTreeMap;

/// `GET /api/admin/types` list envelope: `{ "types": [...] }`.
#[derive(Debug, Clone, Serialize)]
pub struct TypeList {
    pub types: Vec<TypeDefinition>,
}

/// One object type's full runtime definition (spec §2). A builtin type is
/// assembled from the field registry + a code-defined identity/ui_hints; a
/// custom type comes from the future type-registry table — both traverse the
/// SAME serialization path (Em Q5: builtins are "built-in custom objects").
#[derive(Debug, Clone, Serialize)]
pub struct TypeDefinition {
    // ── identity ──
    #[serde(rename = "type")]
    pub type_id: String,
    /// 3-char-ish uppercase rid prefix (e.g. `CAS_`). Reported as actually
    /// minted — builtin dashboards currently share `FIL_` with files.
    pub rid_prefix: String,
    pub display_name: String,
    pub display_name_plural: String,
    pub is_builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_origin: Option<String>,
    // ── fields (authoritative catalog: storage + presentation + perms) ──
    pub fields: Vec<FieldDef>,
    // ── relationships (cross-type pointers; derived from the fields' rels) ──
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub relationships: Vec<RelationshipDef>,
    // ── UI hints (rail icon, default columns/sort) ──
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_hints: Option<UIHints>,
}

/// One field's definition (spec §2). Carries STORAGE metadata (`data_type`,
/// backend-owned §4), PRESENTATION metadata (`editor`/`options`/`render`/
/// `data_*`, FE-owned & opaque to the backend §5), PERMISSION metadata
/// (`perm_class` §3 + the server-resolved per-role cells), and a relationship
/// pointer (`rel`). Empty/absent optional fields are omitted from JSON.
#[derive(Debug, Clone, Serialize)]
pub struct FieldDef {
    pub key:   String,
    pub label: String,
    pub data_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    // ── presentation (FE-owned, opaque to backend) ──
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_full: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_trunc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_prefix: Option<String>,
    // ── permissions (§3) ──
    #[serde(skip_serializing_if = "Option::is_none")]
    pub perm_class: Option<String>,
    /// Server-resolved per-role cells (perm_class default ⊕ field_permissions
    /// overrides). `"write" | "read" | "none"`. Set on read, never on write.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer: Option<String>,
    // ── relationship ──
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel: Option<FieldRel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_admin: Option<bool>,
}

/// A field-level relationship target (spec §2, `FieldDef.rel`).
#[derive(Debug, Clone, Serialize)]
pub struct FieldRel {
    #[serde(rename = "type")]
    pub to_type: String,
    pub multi: bool,
}

/// A type-level relationship edge (spec §2) — the rollup of the fields' rels,
/// so entity-pickers + introspection work without hardcoding type→type edges.
#[derive(Debug, Clone, Serialize)]
pub struct RelationshipDef {
    pub field: String,
    pub to:    String,
    pub multi: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via:   Option<String>,
}

/// Default presentation hints for the generic list-page renderer (spec §2).
#[derive(Debug, Clone, Serialize, Default)]
pub struct UIHints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail_icon: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub default_columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_sort: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub list_filters: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub chip_render: BTreeMap<String, String>,
}
