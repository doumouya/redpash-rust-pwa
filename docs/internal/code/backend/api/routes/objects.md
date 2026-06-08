---
title: backend/crates/api/src/routes/objects.rs
source: ../../../../../../backend/crates/api/src/routes/objects.rs
owner: Torv
section: Internal · Code · backend · api · routes
last modified date: 2026-06-07
---

# routes/objects.rs

## Purpose

The **generic object resource** — `/api/objects/:type[/:rid]` CRUD over the
polymorphic `entity_data` (JSONB) store (object-registry Stage 2, CAS_0FBF301F).
ONE handler serves every TypeDefinition-declared **custom** type: declaring a
type (Stage 3 `register_type`) gives it full CRUD + RBAC + audit + field
validation with **zero new code** — the [[disposability-design-principle]]
acceptance criterion (a fake `RealEstateListing` flows end-to-end, verified).

Builtins keep their typed tables (Hybrid-C storage). **Their LIST now also routes
here** (Lane 1, 2026-06-08): `GET /:type` dispatches **builtin → its reach provider**
([list_registry.rs](list_registry.md)) **/ custom → the `entity_data` default**, both
RBAC-reach-scoped + paginated, returning `Page<Value>`. So a user surface lists any
type from one endpoint instead of a platform-admin `/admin/*` route — the
admin-scope fix ([admin-scope-audit](../../tools/audit-suite/admin-scope-audit.md)).
Per the "one engine" design (Em), `GET` does reach **delivery** only; shaping
(filter/search/sort/page) runs in the data-engine wasm on the client under the row
cap, with `page/size/q/sort` as the over-cap server fallback. Create/get/patch/delete
stay `entity_data`-only (custom types).

> **api-doc note:** the `docs/api/objects.md` reference entry is deferred to the
> CAS_701CF65E doc rebuild (the public `docs/api/` tier is frozen). Flagged on the
> broadcast; api-doc-audit may flag `/api/objects` until the rebuild folds it in.

## Routes

| Method | Path | Gate | Notes |
|---|---|---|---|
| `GET`    | `/:type` | reach-filtered, paginated | the caller's reachable rows as `Page<Value>`. Builtin → reach provider (typed table); custom → `entity_data` (now cascade: direct membership OR `scope_parent_id`). `viewer` via `list_viewer` (admin → all). |
| `POST`   | `/:type` | authenticated | create — validates fields, mints `<PREFIX>_…`, one tx: `register_entity` + `entity_data` insert + **auto-grant owner membership**. |
| `GET`    | `/:type/:rid` | `require_view` | one object. 404 leak-free on type-mismatch / no reach. |
| `PATCH`  | `/:type/:rid` | `require_grant` ≥Member + `require_fields` | per-field perm + `validate_value` (merging stored values for cross-field rules) → JSONB merge. |
| `DELETE` | `/:type/:rid` | `require_grant` ≥Admin | deletes the entity (cascades `entity_data`) + memberships, one tx. |

## Reused seams (no new policy)

- Type resolution: `state.type_cache.is_type()` / `rid_prefix()` — 404 unknown.
- RBAC: the type-agnostic `rbac::resolve_grant` via `require_view` / `require_grant`.
- Field perms: `field_perms::require_fields(type, fields)` (cache catalog).
- Validation: `validate_rules::validate_value` off `type_cache.find_default`
  (`data_type` + options; a field not in the catalog is a 400 `unknown_field`).
- Audit: `event::info/warn` with `{type}_{create,update,delete}` kinds.

## Drift-prone / staged

- **Validation rules** — Stage 2 validates `data_type` only; the `type_fields.validate`
  rules aren't carried into the cache's `FieldRow` yet (builtins have none). Wire
  when `register_type` ships rule-carrying custom types (Stage 3).
- **RBAC reach (list)** — the `GET /:type` list applies reach in-query (the provider's
  `principals` predicate; the `entity_data` default now cascades via `scope_parent_id`).
  The per-object `GRANT_SQL`/`EDGES_SQL` `entity_data` arm is still the Stage-3 follow-up
  for the single-object `require_view`/audit path.
- **membership type** — `/api/objects/membership` 404s until a `type_definitions` row
  registers it (its provider is ready; it's an edge, list-only — S3).

## Related

- [object-registry-framework spec](../../../specs/object-registry-framework.md).
- [type_cache.rs](../type_cache.md) — `is_type` / `rid_prefix` / `find_default`.
- Migration `backend/migrations/20260607000002_entity_data.sql`.
