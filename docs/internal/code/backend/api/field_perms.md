---
title: backend/crates/api/src/field_perms.rs
source: ../../../../../backend/crates/api/src/field_perms.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-05-31
---

# field_perms.rs

## Purpose

The **field registry** — every object field as a row, with its properties
(`is_editable`, `is_sortable`) and the per-role permission state
(`owner`/`admin`/`member`/`viewer`) as columns. A **redtable of fields**, the
same shape the cleaner gives columns (Em's framing, CAS_C4219F2B). Backs
`GET /api/admin/fields` ([routes/admin.md](routes/admin.md)), which the Admin
Console renders through the standard redtable reader (`Page<FieldRow>`).

Authored from the [specs/rbac](../../specs/rbac/index.md) per-field atoms +
reaches + the shared DTO shapes.

- **slice 1** (done): the static `default_registry`.
- **slice 2** (done): the sparse `field_permissions` override table (migration
  `20260531000003`); `GET /api/admin/fields` serves `defaults ⊕ overrides` and
  flags `is_overridden`; `PUT /api/admin/fields` sets a cell (reverting to the
  catalog default deletes the row, keeping the table sparse).
- **slice 3** (in progress): `require_fields(state, caller, object_rid, object_type, &fields)`
  — the field-level write gate. After the coarse object gate admits the caller,
  it maps the caller's effective tier to a matrix column and 403s
  (`field_forbidden`) the first written field that isn't `Write` (defaults ⊕
  overrides). Platform admins bypass. Wired into `cases.rs::patch`; the other
  sparse-PATCH handlers (company/file/chart/dashboard, + project owner-grade
  reconciliation) follow the same pattern.

## Public surface

- `pub enum Perm` — `None < Read < Write` (Ord; `Write` implies `Read`).
  `as_str` / `from_str` for the SQL/wire round-trip; serializes lowercase.
- `pub struct FieldRow` — one registry row: `object`, `field`, `is_editable`,
  `is_sortable`, the four per-role cells, and `is_overridden` (set during the
  GET merge). `apply_override(role, perm)` overlays a cell; `default_for(role)`
  reads the pre-override default (for the PUT revert check).
- `pub fn default_registry` — the full static catalog (60 rows across the 7
  membership-bearing object types).
- `pub fn find_default(object, field)` — the catalog row for one field, for the
  PUT handler's validation + revert check.
- `pub async fn require_fields(state, caller, object_rid, object_type, &fields)`
  — the field-level write gate (slice 3); see above.

## Default perm rules (overridable in a later slice)

- **standard** updatable field → `W W R R` (owner/admin write, member/viewer read)
- **owner-grade** (ownership transfer, re-parent, personal default) → `W R R R`
- **case content** (participant-editable, the `is_member` write reach) → `W W W R`
- **personal pin** (`dashboard.is_favorite`) → `W N N N`
- **read-only / computed** (`is_editable=false`) → `R R R R`

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
