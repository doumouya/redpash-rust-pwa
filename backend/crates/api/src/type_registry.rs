//! Purpose: assemble the builtin object types as TypeDefinitions — identity +
//! ui_hints (code-defined here) + fields (from the field_perms registry,
//! mapped to FieldDef) + relationships (derived from each field's rel). The
//! source for `GET /api/admin/types`; the handler layers field_permissions
//! overrides onto the per-role cells. Builtins are "built-in custom objects"
//! (Em Q5) — a custom type from the future type-registry table will produce the
//! same TypeDefinition shape through the same serializer.
//! Doc: docs/internal/code/backend/api/type_registry.md

use shared::type_def::{FieldDef, FieldRel, RelationshipDef, TypeDefinition, UIHints};

use crate::field_perms::FieldRow;

/// Code-defined identity + presentation hints for one builtin type. Fields +
/// relationships come from the field registry; this is everything that ISN'T a
/// field. `rid_prefix` is reported as actually minted (live DB) — note that
/// `dashboard` shares `FIL_` with `file` (both are `project_files` rows; only
/// `chart` got a distinct `CHT_`).
pub(crate) struct TypeMeta {
    pub(crate) type_id:             &'static str,
    pub(crate) rid_prefix:          &'static str,
    pub(crate) display_name:        &'static str,
    pub(crate) display_name_plural: &'static str,
    pub(crate) rail_icon:           &'static str,
    pub(crate) default_columns:     &'static [&'static str],
    pub(crate) default_sort:        &'static str,
}

/// "display_name" → "Display name", "redpash_id" → "Redpash ID". Sentence-case,
/// with `id`/`url` tokens upper-cased. A presentation default — a custom type
/// can carry an explicit label instead.
fn humanize(key: &str) -> String {
    let mut s = key
        .split('_')
        .map(|w| match w {
            "id" => "ID".to_string(),
            "url" => "URL".to_string(),
            _ => w.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(first) = s.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    s
}

/// Map one registry row to a FieldDef. The per-role cells are the perm_class
/// DEFAULTS; the handler overlays field_permissions overrides on read.
fn field_to_def(r: &FieldRow) -> FieldDef {
    FieldDef {
        key:        r.field.to_string(),
        label:      humanize(r.field),
        data_type:  r.data_type.to_string(),
        required:   None,
        default:    None,
        // Builtins carry no §v2 validate rules yet — they attach once
        // field_perms::FieldRow gains a `validate` column (parallel to data_type).
        validate:   Vec::new(),
        editable:   Some(r.is_editable),
        editor:     r.editor.map(str::to_string),
        options:    r.options.iter().map(|s| s.to_string()).collect(),
        render:     None,
        data_full:  None,
        data_trunc: None,
        data_prefix: None,
        perm_class: Some(r.perm_class.as_str().to_string()),
        owner:      Some(r.owner.as_str().to_string()),
        admin:      Some(r.admin.as_str().to_string()),
        member:     Some(r.member.as_str().to_string()),
        viewer:     Some(r.viewer.as_str().to_string()),
        rel:        r.rel.as_ref().map(|rel| FieldRel { to_type: rel.ty.to_string(), multi: rel.multi }),
        requires_admin: None,
    }
}

/// Assemble one builtin TypeDefinition. Cells carry perm_class defaults only —
/// the `/admin/types` handler layers `field_permissions` overrides on top.
pub(crate) fn build_one(m: &TypeMeta, registry: &[FieldRow]) -> TypeDefinition {
    let fields: Vec<FieldDef> = registry
        .iter()
        .filter(|r| r.object == m.type_id)
        .map(field_to_def)
        .collect();
    // Type-level relationships = the rollup of the fields that point elsewhere.
    let relationships: Vec<RelationshipDef> = fields
        .iter()
        .filter_map(|f| {
            f.rel.as_ref().map(|rel| RelationshipDef {
                field: f.key.clone(),
                to:    rel.to_type.clone(),
                multi: rel.multi,
                via:   None,
            })
        })
        .collect();
    TypeDefinition {
        type_id:             m.type_id.to_string(),
        rid_prefix:          m.rid_prefix.to_string(),
        display_name:        m.display_name.to_string(),
        display_name_plural: m.display_name_plural.to_string(),
        is_builtin:          true,
        source_origin:       Some("schema".to_string()),
        fields,
        relationships,
        ui_hints: Some(UIHints {
            rail_icon:       Some(m.rail_icon.to_string()),
            default_columns: m.default_columns.iter().map(|s| s.to_string()).collect(),
            default_sort:    Some(m.default_sort.to_string()),
            list_filters:    Vec::new(),
            chip_render:     Default::default(),
        }),
    }
}
