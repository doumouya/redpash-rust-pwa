---
title: backend/crates/shared/src/type_def.rs
source: ../../../../../backend/crates/shared/src/type_def.rs
owner: Torv
section: Internal · Code · backend · shared
last modified date: 2026-05-31
---

# type_def.rs

## Purpose

The **TypeDefinition wire contract** — the runtime-typed object shape every
framework module (cell-editor, chip-render, list-page, filter-builder…)
consumes instead of hardcoding the builtin object types. Served by
`GET /api/admin/types` ([routes/admin.md](../api/routes/admin.md)); the spec is
[specs/type-definition](../../specs/type-definition.md) §2 (CAS_0FBF301F). The
point is disposability: a customer's custom object ships as a TypeDefinition and
flows through the same primitives as the 5 builtin types — zero framework source
changes.

These are pure wire DTOs (serialize-only); the assembly that produces them from
the field registry lives in [type_registry.rs](../api/type_registry.md) (api
crate), and the override-merge + gating in the `/admin/types` handler.

## Public surface

- `pub struct TypeList` — the list envelope `{ "types": [...] }`.
- `pub struct TypeDefinition` — one object type: identity (`type` (serde-renamed
  from `type_id`) / `rid_prefix` / `display_name` / `display_name_plural` /
  `is_builtin` / `source_origin`), `fields: Vec<FieldDef>`, `relationships:
  Vec<RelationshipDef>`, `ui_hints: Option<UIHints>`.
- `pub struct FieldDef` — one field: identity (`key`/`label`), storage
  (`data_type` + `required`/`default`), presentation (`editable`/`editor`/
  `options`/`render`/`data_full`/`data_trunc`/`data_prefix`), permission
  (`perm_class` + the server-resolved `owner`/`admin`/`member`/`viewer` cells),
  and `rel: Option<FieldRel>` / `requires_admin`.
- `pub struct FieldRel` — a field's relationship target: `type` (serde-renamed
  from `to_type`) + `multi`.
- `pub struct RelationshipDef` — a type-level edge: `field` / `to` / `multi` /
  `via` (the rollup of the fields' rels).
- `pub struct UIHints` — `rail_icon` / `default_columns` / `default_sort` /
  `list_filters` / `chip_render`.

All optional/empty fields are `skip_serializing_if`'d, so the JSON stays lean.

## Drift-prone areas

- The shape mirrors the spec §2 TS interface verbatim. If the spec's
  TypeDefinition / FieldDef changes, this and the spec move together.
- `data_type` is the BACKEND-owned storage vocabulary (§4); `editor` is the
  FE-owned, backend-opaque presentation id (§5) — served verbatim, never
  validated against an FE list. Keep that split: validating editor ids here
  would couple `/admin/types` to the FE editor inventory.
- The server-resolved per-role cells (`owner`…`viewer`) are set on READ only
  (perm_class default ⊕ overrides). A client must never send them on a write.

## Related

- [type_registry.rs](../api/type_registry.md) — assembles builtin TypeDefinitions from the field registry.
- [routes/admin.rs](../api/routes/admin.md) — `GET /api/admin/types` serves these (+ the override merge).
- [field_perms.rs](../api/field_perms.md) — the field registry a FieldDef is mapped from; `perm_class` derivation.
- [specs/type-definition](../../specs/type-definition.md) — the contract this encodes.
