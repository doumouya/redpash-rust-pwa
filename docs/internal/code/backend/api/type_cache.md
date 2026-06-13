---
title: backend/crates/api/src/type_cache.rs
source: ../../../../../backend/crates/api/src/type_cache.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-13
---

# type_cache.rs

## Purpose

The **runtime type registry** — `type_definitions` / `type_fields` /
`type_scope_roles` (migration `20260607000000`) loaded once into an immutable
`TypeDefCache` held as `Arc<TypeDefCache>` on `AppState`. The data-driven
replacement for the three code-side registries (object-registry Stage 1,
CAS_0FBF301F): `field_perms::default_registry` (field catalog),
`type_registry::builtin_meta` (type identity/ui-hints), and the `admin.rs` role
const arrays (`PROJECT_ROLES`/…).

Strategic frame: [[decades-of-innovation]] / [[data-format-open-ended]] — a new
entity type is a row in these tables, not a code edit. The cache is the seam the
Stage-2 generic handler and Stage-3 `register_type` read.

## Shape

- `load(pool)` — runs after `migrate!` (which seeds): 3 ordered SELECTs →
  interned `Vec<FieldRow>` + prebuilt `Vec<TypeDefinition>` + the scope-role and
  rid-prefix maps. Logs `types/fields/scopes` counts.
- **Interning** — every DB string is `Box::leak`ed to `&'static str` via a
  dedup `Interner`, so `FieldRow` keeps its `&'static str` fields **unchanged**
  (the interner lesson: a registry moved from code to DB stays cheap; the cache
  lives for the process). Stage 3's `register_type` re-leaks the few custom
  strings.
- **Re-derivation** — `type_fields` stores INPUTS only (`data_type` /
  `perm_class` / `is_sortable` / `options` / `rel`). The per-role cells +
  default editor + `is_editable` are re-derived in Rust via
  `FieldRow::from_parts` (the same logic as `field_perms::fld`), so the seed
  can't drift from the derivation.
- Field order preserved by `ORDER BY type_id, ordinal` (the `/admin/types` +
  `/admin/fields` wire is order-sensitive).

## Public surface (read methods, wired at C3)

- `find_default(object, field)` — the field catalog lookup (replaces
  `default_registry` + `find_default`; consumed by the cases-PATCH status
  validation). (`rows()` — the full catalog — was removed in the lean slim
  CAS_C8A9 when its only reader `require_fields` was neutered; `grid_rows()`
  serves `/admin/fields`.)
- `type_defs()` / `type_def(id)` — builtin TypeDefinitions (replaces
  `builtin_types` / `builtin_type`; consumed by `/admin/types`). Built via the
  reused `type_registry::build_one`.
- `scope_roles(scope)` — system + context role allow-lists + the per-scope
  default (replaces the `admin.rs` const arrays; consumed by
  `create_membership` / `put_field`).
- `object_kind(rid)` — rid-prefix → type_id (replaces `rbac::object_kind`).
  Registry-driven, so it **fixes** the legacy `TEM_`/`TEAM` mis-dispatch and
  adds `CON_`→connection; the shared `FIL_` resolves to `file` (canonical).
- `is_type(id)` / `rid_prefix(id)` — existence + rid prefix for ANY type
  (grid/internal/custom); the generic `/api/objects` handler resolves + mints
  rids against these (Stage 2).

## Grid vs internal types

`type_definitions` holds 9 rows but only **7 are grid-served** (ordinal 0–6:
company/project/case/team/file/chart/dashboard). `user` (rel-only subject) and
`connection` (the Stage-2 generic-handler proof catalog) exist for the
`entities.type` FK but are NOT grid-served — `type_defs()` / `grid_rows()` exclude
them, so `/admin/types` + `/admin/fields` stay byte-identical to the legacy
output. `object_kind` uses every prefix.

## Staged state

C2: cache loads + held on `AppState`. **C3 (done):** consumers redirected
(`/admin/fields` → `grid_rows`; `/admin/types` → `type_defs`;
`create_membership` / `put_field` → `scope_roles`; `rbac::object_kind` →
`object_kind`), the code-side registries (`default_registry` / `builtin_meta` /
`builtin_types` / `builtin_type` / the admin role const arrays) DELETED, and
`/admin/types` + `/admin/fields` proven byte-identical (code-driven vs
cache-driven diff). Migration `20260607000001` adds `ordinal` + `grid_served`.

## Related

- [object-registry-framework spec](../../../specs/object-registry-framework.md) — the arc.
- [field_perms.rs](field_perms.md) — `FieldRow` / `from_parts` / `PermClass`.
- [type_registry.rs](type_registry.md) — `build_one` / `TypeMeta` (reused here).
- Migration `backend/migrations/20260607000000_type_registry_tables.sql`.
