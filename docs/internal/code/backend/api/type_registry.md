---
title: backend/crates/api/src/type_registry.rs
source: ../../../../../backend/crates/api/src/type_registry.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-05-31
---

# type_registry.rs

## Purpose

Assembles the **builtin object types as TypeDefinitions** — the source for
`GET /api/admin/types` ([routes/admin.md](routes/admin.md)). Combines three
inputs per type:

1. **identity + ui_hints** — code-defined here (rid prefix, display names, rail
   icon, default columns/sort). Everything that ISN'T a field.
2. **fields** — pulled from the [field_perms](field_perms.md) registry and
   mapped to the spec's [FieldDef](../shared/type_def.md) (storage + presentation
   + perm_class-default cells).
3. **relationships** — derived from the fields that carry a `rel` (no separate
   hand-authored list).

Builtins are "built-in custom objects" (Em Q5): a future custom type from the
type-registry table will produce the same `TypeDefinition` shape through the
same serializer. The `/admin/types` handler layers `field_permissions` overrides
onto the per-role cells; this module produces perm_class-DEFAULT cells only.

Spec: [specs/type-definition](../../specs/type-definition.md) §4.1 (CAS_0FBF301F).

## Public surface

After CAS_0FBF301F Stage 1 this module is the TypeDefinition **assembler only** —
the data moved to `type_definitions` and loads via [type_cache](type_cache.md).
`builtin_types()` / `builtin_type()` / `builtin_meta()` were DELETED.

- `pub(crate) fn build_one(meta: &TypeMeta, registry: &[FieldRow]) ->
  TypeDefinition` — assemble one TypeDefinition (identity + ui_hints + fields +
  relationships). **Reused by the cache** to build the grid TypeDefinitions from
  the seeded rows, so the wire shape is identical whether a type is a builtin or
  a future custom type.
- `pub(crate) struct TypeMeta` — code shape for one type's identity/ui-hints; the
  cache fills it from `type_definitions` rows.

Private: `humanize()` (key → label), `field_to_def()` (FieldRow → FieldDef).

## Drift-prone areas

- **`rid_prefix` is reported as actually minted** (verified against the live
  DB): `dashboard` shares `FIL_` with `file` — both are `project_files` rows;
  only `chart` got a distinct `CHT_`. A collision against the spec's
  "unique-per-type" intent (Q4); reported truthfully so the shape is visible.
- **Scope = the 7 types the field registry grids.** `user` is a subject
  referenced by `rel` (e.g. `case.assignee → user`) but not itself grid-served
  in v1 — same boundary [field_perms](field_perms.md) draws. If `user` gains a
  field grid, add it to both.
- **`ui_hints` are seeded** (rail icon, default columns/sort) in
  `type_definitions`. When a type gains/loses a field that's a default column,
  ship a migration updating the seeded row.
- **`label` is humanized from the key** (`redpash_id` → "Redpash ID"). A custom
  type can carry an explicit label instead; builtins derive it.
- `render` / `data_*` render-rules are left `None` for builtins in v1 — the FE
  keeps its current hardcoded rendering until it migrates to consume them.

## Related

- [shared/type_def.rs](../shared/type_def.md) — the DTOs this produces.
- [field_perms.rs](field_perms.md) — the field registry + perm_class derivation.
- [routes/admin.rs](routes/admin.md) — `GET /api/admin/types` (gating + override merge).
- [specs/type-definition](../../specs/type-definition.md) — the contract.
