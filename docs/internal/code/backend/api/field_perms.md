---
title: backend/crates/api/src/field_perms.rs
source: ../../../../../backend/crates/api/src/field_perms.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-05-31
---

# field_perms.rs

## Purpose

The **field registry** — every object field as a row carrying its identity
(`object`/`field`), storage (`data_type`), presentation (`editor`/`options`/
`rel`), permission (`perm_class` → per-role cells), and `is_editable`/
`is_sortable`. A **redtable of fields**, the same shape the cleaner gives
columns (Em's framing, CAS_C4219F2B). Backs `GET /api/admin/fields`
([routes/admin.md](routes/admin.md)), which the Admin Console renders through
the standard redtable reader (`Page<FieldRow>`), **and** the per-type field
catalog the TypeDefinition contract serves (`GET /api/admin/types`,
[specs/type-definition](../../specs/type-definition.md), CAS_0FBF301F): a
`FieldRow` *is* the spec's FieldDef.

Per-role cells (`owner`/`admin`/`member`/`viewer`) **derive** from `perm_class`
(spec §3.1) — not hand-authored per field — so a custom object's fields resolve
without source-code defaults (the disposability requirement). The
`field_permissions` override table layers on top.

Authored from the [specs/rbac](../../specs/rbac/index.md) per-field atoms +
reaches + the shared DTO shapes.

- **slice 1** (done): the static `default_registry`.
- **slice 2** (done): the sparse `field_permissions` override table (migration
  `20260531000003`); `GET /api/admin/fields` serves `defaults ⊕ overrides` and
  flags `is_overridden`; `PUT /api/admin/fields` sets a cell (reverting to the
  catalog default deletes the row, keeping the table sparse).
- **TypeDefinition expansion** (done, CAS_0FBF301F): `FieldRow` gains
  `data_type` / `editor` / `options` / `perm_class` / `rel`; per-role cells now
  derive from `perm_class` (5 classes — see below); `/admin/fields` cell output
  is byte-identical (regression guard). Feeds `GET /api/admin/types`.
- **slice 3** (done): `require_fields(state, caller, object_rid, object_type, &fields)`
  — the field-level write gate. After the coarse object gate admits the caller,
  it maps the caller's effective tier to a matrix column and 403s
  (`field_forbidden`) the first written field that isn't `Write` (defaults ⊕
  overrides). Platform admins bypass. Wired into the patch handlers for
  **case · company · file · chart · dashboard**. **Project stays on its bespoke
  owner-grade guard**: that guard is *direct*-owner (`db::project_owner ==
  caller`), correct for `is_default` (a per-user personal flag) — the matrix's
  `owner` column is *effective* owner (incl. a company owner via scope), too
  broad for it. So the matrix doesn't govern project's owner-grade fields.

## Public surface

- `pub enum Perm` — `None < Read < Write` (Ord; `Write` implies `Read`).
  `as_str` / `from_str` for the SQL/wire round-trip; serializes lowercase.
- `pub enum PermClass` — `Standard` (`WWRR`) / `Collaborative` (`WWWR`) /
  `OwnerGrade` (`WRRR`) / `Personal` (`WNNN`) / `Readonly` (`RRRR`); serializes
  snake_case (`as_str()` gives the same wire string for the type registry). The
  per-role cells derive from it (`cells() -> [owner,admin,member,viewer]`).
- `pub struct Rel` — a relationship field's target: `type` (the related object
  type, serde-renamed from `ty`) + `multi`. Drives pickers + rid write-validation.
- `pub struct FieldRow` — one registry row (= the spec's FieldDef): `object`,
  `field`, `is_editable`, `is_sortable`, `data_type`, `editor` (opaque/FE),
  `options`, `perm_class`, `rel`, the four derived per-role cells, and
  `is_overridden` (set during the GET merge). `apply_override(role, perm)`
  overlays a cell; `default_for(role)` reads the pre-override default (PUT revert
  check). `editor` / `options` / `rel` are omitted from JSON when empty.
- `pub fn default_registry` — the full static catalog (60 rows across the 7
  membership-bearing object types), built via the `fld(object, field, data_type,
  perm_class)` builder (chains `.nosort()` / `.opts()` / `.rel()`); cells +
  default editor derive from `data_type` + `perm_class`.
- `pub fn find_default(object, field)` — the catalog row for one field, for the
  PUT handler's validation + revert check.
- `pub async fn require_fields(state, caller, object_rid, object_type, &fields)`
  — the field-level write gate (slice 3); see above.

## perm_class → per-role cells (the derivation)

The cells aren't authored per field — they derive from the row's `perm_class`
(spec §3.1). Five classes cover every builtin field; the `field_permissions`
override table layers on top:

- **`standard`** updatable field → `W W R R` (owner/admin write, member/viewer read)
- **`collaborative`** case content (participant-editable, the `is_member` write
  reach) → `W W W R`
- **`owner_grade`** (ownership transfer, re-parent, personal default) → `W R R R`
- **`personal`** pin (`dashboard.is_favorite`) → `W N N N`
- **`readonly`** / computed (`is_editable=false`) → `R R R R`

## Drift-prone areas

- Scope is the **membership-bearing** objects (company / project / case / team /
  file / chart / dashboard) where the resolver's `effective()` tier maps onto
  these columns. `user` (a subject) and `comment` (author-gated) are out of the
  grid by design — note it if that changes.
- Authored from the [specs/rbac](../../specs/rbac/index.md) per-field atoms;
  when an object gains/loses an editable field (a new `*.update` atom), add/drop
  its row here. `is_sortable` should track the list endpoints' `?sort=` allowlists.
- Defaults here are the seed; once the `field_permissions` override table lands,
  the served matrix is `defaults ⊕ overrides` and enforcement reads it.

## Related

- [routes/admin.rs](routes/admin.md) — `GET /api/admin/fields` serves this.
- [rbac.rs](rbac.md) — the resolver that yields the caller's tier (the column);
  this registry says what that tier may do per field.
- [RBAC catalog](../../specs/rbac/index.md) — the prose atoms this encodes.
