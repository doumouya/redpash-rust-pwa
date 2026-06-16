//! Purpose: GET /api/types — the TypeDefinition contract: every registered
//! type + its field catalog, per-role cells DERIVED from perm_class then
//! overlaid with field_permissions overrides. Any authed caller — the FE
//! builds grids/editors off this payload; the backend gates stay the boundary.
//!
//! Choice (noted per S7): this reads LIVE from the DB instead of extending
//! TypeDefCache. Custom types are "a row, not a migration" and an admin
//! override must show up on the next GET — a startup cache would need
//! invalidation wiring on PUT /api/admin/fields for zero read-path win at
//! this scale. TypeDefCache keeps its single job (the generated RBAC SQL).

use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    error::AppError,
    field_perms::{self, Perm, PermClass},
    rbac::Caller,
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(list_types))
}

/// GET /api/types — { types: [...] }, types by ordinal, fields by ordinal.
async fn list_types(
    State(state): State<AppState>,
    _caller: Caller, // any authed caller; extraction IS the gate
) -> Result<Json<Value>, AppError> {
    Ok(Json(payload(&state.db).await?))
}

/// The assembled wire payload — pub so the live-DB test exercises the exact
/// shape without booting an HTTP server.
pub async fn payload(pool: &PgPool) -> Result<Value, AppError> {
    let defs: Vec<(String, String, String, String, bool, bool)> = sqlx::query_as(
        "SELECT type_id, display_name, display_name_plural, rid_prefix, grid_served, is_builtin
         FROM type_definitions ORDER BY ordinal",
    )
    .fetch_all(pool)
    .await?;
    let fields: Vec<(String, String, String, i32, String, String, String, String, String, Option<Value>)> =
        sqlx::query_as(
            "SELECT type_id, field, label, ordinal, data_type, perm_class, data_class, field_group, scope, options
             FROM type_fields ORDER BY type_id, ordinal",
        )
        .fetch_all(pool)
        .await?;
    let overrides: Vec<(String, String, String, bool, bool)> = sqlx::query_as(
        "SELECT type_id, field, role, can_read, can_write FROM field_permissions",
    )
    .fetch_all(pool)
    .await?;

    let mut types: Vec<Value> = Vec::with_capacity(defs.len());
    for (type_id, display_name, display_name_plural, rid_prefix, grid_served, is_builtin) in defs {
        let mut fs: Vec<Value> = fields
            .iter()
            .filter(|f| f.0 == type_id)
            .map(|(_, key, label, ordinal, data_type, perm_class, data_class, field_group, scope, options)| {
                // derived from perm_class (unknown class → default-deny) …
                let mut cells = PermClass::parse(perm_class)
                    .map(PermClass::cells)
                    .unwrap_or([Perm::None; 4]);
                // … ⊕ the sparse overrides.
                for (ot, of, role, r, w) in &overrides {
                    if ot == &type_id && of == key {
                        if let Some(i) = field_perms::tier_index(role) {
                            cells[i] = Perm::from_flags(*r, *w);
                        }
                    }
                }
                let label = if label.is_empty() { title_case(key) } else { label.clone() };
                let mut f = json!({
                    "key": key,
                    "label": label,
                    "data_type": data_type,
                    "perm_class": perm_class,
                    "data_class": data_class,
                    "field_group": field_group,
                    "scope": scope,
                    "ordinal": ordinal,
                    "cells": {
                        "owner":  cells[0].wire(),
                        "admin":  cells[1].wire(),
                        "member": cells[2].wire(),
                        "viewer": cells[3].wire(),
                    },
                });
                if let Some(opts) = options {
                    f["options"] = opts.clone();
                }
                f
            })
            .collect();

        // DERIVE the rest: every real table column with no type_fields row becomes a
        // READONLY display field, so the registry shows the whole object without a
        // per-column migration ("derive, don't store"). Mirrors objects::
        // registry_display_fields (the row data), so the FE's column⋂row-keys
        // intersection keeps them; HIDDEN_COLUMNS (server secrets/paths) stay out, and
        // readonly + absence from field_permissions means they're display-only — the
        // write gate (objects::validate_payload over type_fields) is unaffected.
        if let Some(disp) = crate::objects::registry_display_fields(pool, &type_id).await? {
            let have: std::collections::HashSet<String> =
                fs.iter().filter_map(|f| f["key"].as_str().map(str::to_string)).collect();
            let mut next_ord =
                fs.iter().filter_map(|f| f["ordinal"].as_i64()).max().unwrap_or(0) + 10;
            let cells = PermClass::parse("readonly").map(PermClass::cells).unwrap_or([Perm::None; 4]);
            for (field, cataloged) in disp {
                if cataloged || have.contains(&field) {
                    continue;
                }
                fs.push(json!({
                    "key": field,
                    "label": title_case(&field),
                    "data_type": "string",
                    "perm_class": "readonly",
                    "field_group": "",
                    "scope": "",
                    "ordinal": next_ord,
                    "cells": {
                        "owner":  cells[0].wire(),
                        "admin":  cells[1].wire(),
                        "member": cells[2].wire(),
                        "viewer": cells[3].wire(),
                    },
                }));
                next_ord += 10;
            }
        }

        types.push(json!({
            "type_id": type_id,
            "display_name": display_name,
            "display_name_plural": display_name_plural,
            "rid_prefix": rid_prefix,
            "grid_served": grid_served,
            "is_builtin": is_builtin,
            "fields": fs,
        }));
    }

    Ok(json!({ "types": types }))
}

/// Fallback label for catalog rows seeded without one (e.g. future custom
/// types): "display_name" → "Display Name"; an "id" segment keeps its
/// initialism. Stored labels always win.
fn title_case(field: &str) -> String {
    field
        .split('_')
        .map(|w| {
            if w == "id" {
                "ID".to_string()
            } else {
                let mut c = w.chars();
                match c.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    #[test]
    fn title_case_fallback() {
        assert_eq!(super::title_case("display_name"), "Display Name");
        assert_eq!(super::title_case("company_id"), "Company ID");
        assert_eq!(super::title_case("kind"), "Kind");
    }
}
