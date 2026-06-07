---
title: backend/crates/api/src/type_cache.rs
source: ../../../../../backend/crates/api/src/type_cache.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-07
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

- `rows()` / `find_default(object, field)` — the field catalog (replaces
  `default_registry` + `find_default`; consumed by `require_fields`,
  `/admin/fields`, the cases-PATCH status gate).
- `type_defs()` / `type_def(id)` — builtin TypeDefinitions (replaces
  `builtin_types` / `builtin_type`; consumed by `/admin/types`). Built via the
  reused `type_registry::build_one`.
- `scope_roles(scope)` — system + context role allow-lists + the per-scope
  default (replaces the `admin.rs` const arrays; consumed by
  `create_membership` / `put_field`).
- `object_kind(rid)` — rid-prefix → type_id (replaces `rbac::object_kind`).
  Registry-driven, so it **fixes** the legacy `TEM_`/`TEAM` mis-dispatch and
  adds `CON_`→connection; the shared `FIL_` resolves to `file` (canonical).

## Staged state

C2 (this slice): the cache loads + is held on `AppState`, `#![allow(dead_code)]`
on the read methods. C3 redirects the consumers (removing the allow) + deletes
the code-side registries; C4/parity proves `/admin/types` + `/admin/fields` stay
byte-identical.

## Related

- [object-registry-framework spec](../../../specs/object-registry-framework.md) — the arc.
- [field_perms.rs](field_perms.md) — `FieldRow` / `from_parts` / `PermClass`.
- [type_registry.rs](type_registry.md) — `build_one` / `TypeMeta` (reused here).
- Migration `backend/migrations/20260607000000_type_registry_tables.sql`.
