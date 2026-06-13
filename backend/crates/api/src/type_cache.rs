//! Purpose: the runtime type registry — `type_definitions` / `type_fields` /
//! `type_scope_roles` loaded once into an immutable cache on `AppState`. The
//! data-driven replacement for the code-side `field_perms::default_registry` +
//! `type_registry::builtin_meta` + the `admin.rs` role const arrays
//! (object-registry Stage 1, CAS_0FBF301F). Strings are interned to `'static`
//! (the cache lives for the process — the interner lesson: a registry moved
//! from code to DB stays cheap). The per-role cells + editor are RE-DERIVED in
//! Rust (`FieldRow::from_parts`), never stored, so the seed can't drift.
//! Doc: docs/internal/code/backend/api/type_cache.md

use std::collections::{HashMap, HashSet};

use shared::type_def::TypeDefinition;
use sqlx::types::Json;
use sqlx::PgPool;

use crate::field_perms::{FieldRow, PermClass, Rel};
use crate::type_registry::{build_one, TypeMeta};

/// Per-scope role allow-lists + default (replaces the `admin.rs` const arrays).
pub struct ScopeRoles {
    pub roles:         Vec<&'static str>,
    pub context_roles: Vec<&'static str>,
    pub default_role:  &'static str,
}

/// The loaded, immutable type registry. Held as `Arc<TypeDefCache>` on
/// `AppState`; Stage 3 swaps it via `ArcSwap` on `register_type`.
pub struct TypeDefCache {
    /// ALL field rows (every type incl. `connection`), in (type-ordinal,
    /// field-ordinal) order. `require_fields` reads this; `/admin/fields` reads
    /// the grid-served subset (`grid_rows`).
    rows:           Vec<FieldRow>,
    /// grid-served type_ids — the subset shown in `/admin/types` + `/admin/fields`
    /// (excludes the rel-only `user` + the internal `connection`).
    grid:           HashSet<&'static str>,
    /// EVERY type_id → its rid_prefix (incl. non-grid + custom). The generic
    /// `/api/objects/:type` handler resolves + mints rids against this.
    types:          HashMap<&'static str, &'static str>,
    /// Prebuilt TypeDefinitions for the GRID-served types only, in ordinal order
    /// (byte-identical to the legacy `builtin_types()`).
    type_defs:      Vec<TypeDefinition>,
    scope_roles:    HashMap<&'static str, ScopeRoles>,
    /// rid prefix (with trailing `_`, e.g. `"TEM_"`) → type_id, in type-ordinal
    /// order so a shared builtin prefix resolves to its canonical type
    /// (`FIL_` → `file`, lower ordinal than `dashboard`).
    prefix_to_type: Vec<(&'static str, &'static str)>,
}

/// Dedup-interner: an owned string → a `'static` str that lives for the process.
/// Bounded by the registry size; the cache is built once at startup.
#[derive(Default)]
struct Interner {
    seen: HashMap<String, &'static str>,
}
impl Interner {
    fn intern(&mut self, s: &str) -> &'static str {
        if let Some(&v) = self.seen.get(s) {
            return v;
        }
        let leaked: &'static str = Box::leak(s.to_owned().into_boxed_str());
        self.seen.insert(s.to_owned(), leaked);
        leaked
    }
    fn intern_slice(&mut self, ss: &[String]) -> &'static [&'static str] {
        let v: Vec<&'static str> = ss.iter().map(|s| self.intern(s)).collect();
        Box::leak(v.into_boxed_slice())
    }
}

impl TypeDefCache {
    /// Load the registry from the seeded tables. Order: caller runs `migrate!`
    /// (which seeds) BEFORE this.
    pub async fn load(pool: &PgPool) -> sqlx::Result<Self> {
        let mut intr = Interner::default();

        // ── type_fields → FieldRow (authoring order) ──
        let field_rows: Vec<(String, String, String, String, bool, Json<Vec<String>>, Option<String>, bool)> =
            sqlx::query_as(
                "SELECT tf.type_id, tf.field, tf.data_type, tf.perm_class, tf.is_sortable, \
                        tf.options, tf.rel_type, tf.rel_multi \
                   FROM type_fields tf JOIN type_definitions td ON td.type_id = tf.type_id \
                   ORDER BY td.ordinal, tf.ordinal",
            )
            .fetch_all(pool)
            .await?;
        let mut rows = Vec::with_capacity(field_rows.len());
        for (type_id, field, data_type, perm_class, is_sortable, options, rel_type, rel_multi) in field_rows {
            let pc = PermClass::from_str(&perm_class).unwrap_or(PermClass::Readonly);
            let opts: Vec<&'static str> = options.0.iter().map(|s| intr.intern(s)).collect();
            let rel = rel_type.map(|t| Rel { ty: intr.intern(&t), multi: rel_multi });
            rows.push(FieldRow::from_parts(
                intr.intern(&type_id),
                intr.intern(&field),
                intr.intern(&data_type),
                pc,
                is_sortable,
                opts,
                rel,
            ));
        }

        // ── type_definitions → TypeMeta + grid set + prefix map (ordinal order;
        //    `file` (ord 4) precedes `dashboard` (ord 6) so the shared `FIL_`
        //    resolves to `file`) ──
        let def_rows: Vec<(String, String, String, String, Option<String>, Json<Vec<String>>, Option<String>, bool)> =
            sqlx::query_as(
                "SELECT type_id, rid_prefix, display_name, display_name_plural, rail_icon, \
                        default_columns, default_sort, grid_served \
                   FROM type_definitions ORDER BY ordinal",
            )
            .fetch_all(pool)
            .await?;
        let mut metas: Vec<(TypeMeta, bool)> = Vec::with_capacity(def_rows.len());
        let mut grid: HashSet<&'static str> = HashSet::new();
        let mut types: HashMap<&'static str, &'static str> = HashMap::new();
        let mut prefix_to_type: Vec<(&'static str, &'static str)> = Vec::new();
        for (type_id, rid_prefix, display_name, display_name_plural, rail_icon, default_columns, default_sort, grid_served) in def_rows {
            let tid = intr.intern(&type_id);
            let pfx = intr.intern(&rid_prefix);
            types.insert(tid, pfx);
            if !prefix_to_type.iter().any(|(p, _)| *p == pfx) {
                prefix_to_type.push((pfx, tid));
            }
            if grid_served {
                grid.insert(tid);
            }
            metas.push((
                TypeMeta {
                    type_id:             tid,
                    rid_prefix:          pfx,
                    display_name:        intr.intern(&display_name),
                    display_name_plural: intr.intern(&display_name_plural),
                    rail_icon:           intr.intern(rail_icon.as_deref().unwrap_or("")),
                    default_columns:     intr.intern_slice(&default_columns.0),
                    default_sort:        intr.intern(default_sort.as_deref().unwrap_or("")),
                },
                grid_served,
            ));
        }

        // ── prebuild the GRID-served TypeDefinitions (ordinal order; the
        //    /admin/types handler overlays field_permissions overrides on read) ──
        let type_defs: Vec<TypeDefinition> = metas
            .iter()
            .filter(|(_, grid_served)| *grid_served)
            .map(|(m, _)| build_one(m, &rows))
            .collect();

        // ── type_scope_roles → per-scope allow-lists + default ──
        let role_rows: Vec<(String, String, bool, bool)> = sqlx::query_as(
            "SELECT scope, role, is_context, is_default \
               FROM type_scope_roles ORDER BY scope, is_context, ordinal",
        )
        .fetch_all(pool)
        .await?;
        let mut scope_roles: HashMap<&'static str, ScopeRoles> = HashMap::new();
        for (scope, role, is_context, is_default) in role_rows {
            let scope_s = intr.intern(&scope);
            let role_s = intr.intern(&role);
            let entry = scope_roles.entry(scope_s).or_insert(ScopeRoles {
                roles:         Vec::new(),
                context_roles: Vec::new(),
                default_role:  "",
            });
            if is_context {
                entry.context_roles.push(role_s);
            } else {
                entry.roles.push(role_s);
                if is_default {
                    entry.default_role = role_s;
                }
            }
        }

        tracing::info!(
            types  = metas.len(),
            grid   = grid.len(),
            fields = rows.len(),
            scopes = scope_roles.len(),
            "type registry loaded",
        );
        Ok(Self { rows, grid, types, type_defs, scope_roles, prefix_to_type })
    }

    /// The grid-served field rows — the `/admin/fields` subset (excludes the
    /// rel-only `user` + the internal `connection`). Byte-identical to the
    /// legacy `default_registry()` output.
    pub fn grid_rows(&self) -> Vec<FieldRow> {
        self.rows.iter().filter(|r| self.grid.contains(r.object)).cloned().collect()
    }

    /// The catalog row for one `(object, field)` — the `find_default` replacement.
    pub fn find_default(&self, object: &str, field: &str) -> Option<&FieldRow> {
        self.rows.iter().find(|r| r.object == object && r.field == field)
    }

    /// All builtin TypeDefinitions (the `builtin_types()` replacement).
    pub fn type_defs(&self) -> &[TypeDefinition] {
        &self.type_defs
    }

    /// One TypeDefinition by id (the `builtin_type()` replacement).
    pub fn type_def(&self, type_id: &str) -> Option<&TypeDefinition> {
        self.type_defs.iter().find(|t| t.type_id == type_id)
    }

    /// The role allow-lists + default for a membership scope.
    pub fn scope_roles(&self, scope: &str) -> Option<&ScopeRoles> {
        self.scope_roles.get(scope)
    }

    /// Is `type_id` a known type (any — grid, internal, or custom)?
    pub fn is_type(&self, type_id: &str) -> bool {
        self.types.contains_key(type_id)
    }

    /// The rid prefix (with trailing `_`) for a type — for minting object ids.
    pub fn rid_prefix(&self, type_id: &str) -> Option<&'static str> {
        self.types.get(type_id).copied()
    }

    /// Canonical object type from a rid prefix (the registry-driven
    /// `rbac::object_kind` — `TEM_`→team, `CON_`→connection fixed; `FIL_`→file
    /// canonical; unknown prefix → `"unknown"`, default-denied).
    pub fn object_kind(&self, rid: &str) -> &'static str {
        let Some(i) = rid.find('_') else { return "unknown" };
        let prefix = &rid[..=i];
        self.prefix_to_type
            .iter()
            .find(|(p, _)| *p == prefix)
            .map(|(_, t)| *t)
            .unwrap_or("unknown")
    }
}

// Test-only: an empty registry, for tests in OTHER modules (e.g.
// rbac::neuter_tests) that must build an AppState without a live DB. Crate-
// visible (the module-local `cache_with_prefixes` below is private). Gated to
// `cfg(test)` so it never reaches a release build. (Tester-owned test infra,
// CAS_C8A9A3EC0935498880A468625FE3F490 — leaves the file's Doc: breadcrumb intact.)
#[cfg(test)]
impl TypeDefCache {
    pub(crate) fn empty() -> Self {
        TypeDefCache {
            rows:           Vec::new(),
            grid:           std::collections::HashSet::new(),
            types:          std::collections::HashMap::new(),
            type_defs:      Vec::new(),
            scope_roles:    std::collections::HashMap::new(),
            prefix_to_type: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_with_prefixes(pairs: &[(&'static str, &'static str)]) -> TypeDefCache {
        TypeDefCache {
            rows:           Vec::new(),
            grid:           HashSet::new(),
            types:          HashMap::new(),
            type_defs:      Vec::new(),
            scope_roles:    HashMap::new(),
            prefix_to_type: pairs.to_vec(),
        }
    }

    /// object_kind is registry-driven (CAS_0FBF301F Stage 1). Pins the FIXED
    /// behaviour vs the legacy hardcoded `rbac::object_kind`: teams mint `TEM_`
    /// (legacy matched `"TEAM"` → "unknown"); connectors `CON_` now dispatch;
    /// `FIL_` resolves to `file` (dashboards share it). Unknown → default-denied.
    #[test]
    fn object_kind_is_registry_driven() {
        let c = cache_with_prefixes(&[
            ("CAS_", "case"), ("USR_", "user"), ("TEM_", "team"),
            ("CON_", "connection"), ("FIL_", "file"), ("CMP_", "company"),
        ]);
        assert_eq!(c.object_kind("CAS_x"), "case");
        assert_eq!(c.object_kind("USR_x"), "user");
        assert_eq!(c.object_kind("TEM_x"), "team");        // FIXED (was "unknown")
        assert_eq!(c.object_kind("CON_x"), "connection");  // FIXED (was "unknown")
        assert_eq!(c.object_kind("FIL_x"), "file");        // dashboards share FIL_
        assert_eq!(c.object_kind("ZZZ_x"), "unknown");
        assert_eq!(c.object_kind("nounderscore"), "unknown");
    }
}
