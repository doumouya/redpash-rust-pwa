//! Purpose: the data-driven type registry, loaded once after migrate.
//!
//! Two jobs beyond the predecessor's cache:
//!   1. `object_kind(rid)` — prefix → type via a plain HashMap (day-one #1:
//!      prefixes are unique, so no ordinal disambiguation dance).
//!   2. **The generated cascade** (day-one #6): `type_definitions.scope_parents`
//!      rows are compiled into ONE `parent-edge` SQL fragment that every RBAC
//!      consumer shares — the grant resolver, the admin edge introspection,
//!      and company-of all reuse the same recursive CTE. There is exactly one
//!      copy of the cascade knowledge in the process, and it came from the DB.
//!
//! HashMap-indexed lookups from day one (the predecessor's linear scans were
//! the generic handler's hot path).

use std::collections::HashMap;

use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct TypeDef {
    pub type_id: String,
    pub rid_prefix: String,
    pub is_builtin: bool,
    pub grid_served: bool,
    /// Column names whose values are parent entity ids (the cascade arms).
    pub scope_parents: Vec<String>,
}

#[derive(Debug)]
pub struct TypeDefCache {
    by_type: HashMap<String, TypeDef>,
    by_prefix: HashMap<String, String>,
    /// The generated parent-edge relation: `(id, parent)` pairs unioned over
    /// every declared scope arm. Consumed inside a recursive `scopes` CTE.
    parent_edges_sql: String,
}

/// Where each BUILTIN type's rows live: (table, pk column). This is the ONE
/// place that knowledge exists; custom (non-builtin) types all live in
/// entity_data and need no entry. Extending the schema = extending this map
/// in the same commit as the migration.
fn builtin_table(type_id: &str) -> Option<(&'static str, &'static str)> {
    Some(match type_id {
        "user" => ("users", "redpash_id"),
        "company" => ("companies", "redpash_id"),
        "team" => ("teams", "redpash_id"),
        "project" => ("projects", "redpash_id"),
        // file/chart/dashboard are all project_files rows (File-is-a-File).
        "file" | "chart" | "dashboard" => ("project_files", "redpash_id"),
        "case" => ("cases", "redpash_id"),
        "connection" => ("connectors", "redpash_id"),
        // messaging: channel = its own membership gate; message cascades to channel.
        "channel" => ("channels", "redpash_id"),
        "message" => ("messages", "redpash_id"),
        _ => return None,
    })
}

impl TypeDefCache {
    pub async fn load(pool: &PgPool) -> sqlx::Result<Self> {
        let rows: Vec<(String, String, bool, bool, serde_json::Value)> = sqlx::query_as(
            "SELECT type_id, rid_prefix, is_builtin, grid_served, scope_parents
             FROM type_definitions ORDER BY ordinal",
        )
        .fetch_all(pool)
        .await?;

        let mut by_type = HashMap::new();
        let mut by_prefix = HashMap::new();
        // (table, pk, parent_col) → dedup so file/chart/dashboard (one table)
        // contribute each arm once.
        let mut arms: Vec<(String, String, String)> = Vec::new();

        for (type_id, rid_prefix, is_builtin, grid_served, sp) in rows {
            let scope_parents: Vec<String> = serde_json::from_value(sp).unwrap_or_default();
            if is_builtin {
                if let Some((table, pk)) = builtin_table(&type_id) {
                    for col in &scope_parents {
                        let arm = (table.to_string(), pk.to_string(), col.clone());
                        if !arms.contains(&arm) {
                            arms.push(arm);
                        }
                    }
                }
            }
            by_prefix.insert(rid_prefix.clone(), type_id.clone());
            by_type.insert(
                type_id.clone(),
                TypeDef { type_id, rid_prefix, is_builtin, grid_served, scope_parents },
            );
        }

        // Custom types: one arm covers them all (entity_data.scope_parent_id,
        // FK-backed per day-one #3).
        arms.push(("entity_data".into(), "object_id".into(), "scope_parent_id".into()));

        // Column names come from OUR seed rows (is_builtin only) and our own
        // entity_data arm — never user input — but belt-and-braces: refuse
        // anything that isn't a bare lowercase identifier before it reaches
        // SQL text.
        for (t, pk, col) in &arms {
            for ident in [t, pk, col] {
                assert!(
                    ident.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                    "unsafe identifier in scope_parents: {ident:?}"
                );
            }
        }

        let parent_edges_sql = arms
            .iter()
            .map(|(table, pk, col)| format!("SELECT {pk} AS id, {col} AS parent FROM {table}"))
            .collect::<Vec<_>>()
            .join("\n        UNION ALL ");

        Ok(Self { by_type, by_prefix, parent_edges_sql })
    }

    pub fn get(&self, type_id: &str) -> Option<&TypeDef> {
        self.by_type.get(type_id)
    }

    /// Is `type_id` a registered type? (Leak-free 404s key off this.)
    pub fn is_type(&self, type_id: &str) -> bool {
        self.by_type.contains_key(type_id)
    }

    /// The RID prefix to mint for a type (e.g. "CON" for connection).
    pub fn rid_prefix(&self, type_id: &str) -> Option<&str> {
        self.by_type.get(type_id).map(|t| t.rid_prefix.as_str())
    }

    /// Canonical type for a RedPash-ID, by its (unique) prefix.
    /// Unknown prefix → "unknown" → default-denied downstream.
    pub fn object_kind<'a>(&'a self, rid: &str) -> &'a str {
        rid.split_once('_')
            .and_then(|(prefix, _)| self.by_prefix.get(prefix))
            .map(|s| s.as_str())
            .unwrap_or("unknown")
    }

    /// The shared recursive-scope CTE prefix every RBAC query reuses.
    /// `$1` = caller, `$2` = object. Depth-capped (cycle guard).
    pub fn rbac_with_clause(&self) -> String {
        format!(
            "WITH RECURSIVE principals(pid) AS (
        SELECT $1::text
    UNION
        SELECT m.object_redpash_id
        FROM memberships m
        JOIN principals p ON p.pid = m.member_redpash_id
        JOIN entities  e ON e.id  = m.object_redpash_id AND e.type = 'team'
),
scopes(oid, depth) AS (
        SELECT $2::text, 0
    UNION
        SELECT pe.parent, s.depth + 1
        FROM (
        {edges}
        ) pe
        JOIN scopes s ON s.oid = pe.id
        WHERE pe.parent IS NOT NULL AND s.depth < 8
)",
            edges = self.parent_edges_sql
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn builtin_tables_dedupe_the_file_family() {
        // file/chart/dashboard share project_files — the generator must emit
        // the project_id arm once, not three times. Pure-logic mirror of the
        // dedup in load(); the live shape is asserted by the rbac matrix test.
        let mut arms: Vec<(String, String, String)> = Vec::new();
        for t in ["file", "chart", "dashboard"] {
            let (table, pk) = super::builtin_table(t).unwrap();
            let arm = (table.to_string(), pk.to_string(), "project_id".to_string());
            if !arms.contains(&arm) {
                arms.push(arm);
            }
        }
        assert_eq!(arms.len(), 1);
    }
}
