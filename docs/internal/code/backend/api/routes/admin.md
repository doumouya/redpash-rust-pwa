---
title: backend/crates/api/src/routes/admin.rs
source: ../../../../../../backend/crates/api/src/routes/admin.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-13
---

# admin.rs

## Purpose

`/api/admin` — org-wide read surface for the `/home` rail tabs.

GET /api/admin/users        ← Users tab
GET /api/admin/companies    ← Companies tab
GET /api/admin/memberships  ← Memberships tab    (?scope=project|company|case|team)
POST /api/admin/memberships ← create a (object, member, role, context_role) edge
GET /api/admin/teams        ← Teams tab          (org-wide team list)
GET /api/admin/teams/stats  ← Teams KPI strip
GET /api/admin/files        ← Files tab          (org-wide, not per-project)
GET /api/admin/charts       ← Charts tab         (project_files where file_type='chart')
GET /api/admin/steps        ← Steps tab          (every project_step across all files)
PATCH /api/admin/users/:rid ← platform role {admin|user} + org_role + org_id (set/swap company) — GATED (see below)
GET /api/admin/rbac         ← RBAC introspection ?subject=&object= — GATED (see below)
GET /api/admin/audit-catalog ← per-tool latest run + severity counts + diff-vs-prev — GATED
GET·PUT /api/admin/fields    ← field registry redtable (props + per-role perms) + set a cell — GATED
GET /api/admin/types         ← builtin object types as TypeDefinitions (identity+fields+rels+ui_hints) — GATED
GET /api/admin/types/:type   ← one TypeDefinition by `type` id (404 if unknown) — GATED

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **`DELETE /api/admin/users/:rid` is scrub-retain**, not hard delete. Self-delete guard (`rid == caller`) remains; sole-owner blocker enforced via `db::user_sole_owner_objects` → 409; otherwise scrub_user_tx runs and returns 204. Mirrors `routes/users.rs::delete_one`. See [runbook CAS_46BA…](../../../../runbooks/CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md).
- **`list_companies` + `list_teams_admin` my_role subqueries are precedence-ordered (LIMIT 1)** — after the migration 20260531000001 widened the membership PK to `(object, member, role, context_role)`, a plain `(SELECT m.role …)` returns >1 row when the caller holds multiple roles on one object → 500. Both endpoints rank `owner > admin > member > viewer` and `LIMIT 1`. Apply the same shape to any new admin-list endpoint that exposes `my_role`.
- **`PATCH /api/admin/users/:rid` (`patch_user_role`) is GATED** — unlike the
  dev-permissive read/delete siblings, every field here is an org-management
  mutation, so it requires `rbac::is_platform_admin(caller)` (leak-free 404
  otherwise). Body `PatchUserBody {role?, org_role?, org_id?}` — all optional,
  each present field applied independently (the Users tab edits one cell at a
  time):
  - **`role`** → platform role; validates `role ∈ {admin,user}` (400), refuses
    to demote the **last** platform admin (→ 409 `last_admin`), emits
    `user_role_change`. CAS_D78667D1 option (b), the UI path to admin (sibling to
    the `REDPASH_BOOTSTRAP_ADMINS` env allowlist, [bootstrap.md](../bootstrap.md)).
  - **`org_role`** → the user's role in their PRIMARY company membership
    (`COMPANY_ROLES` = owner/admin/member; 400 otherwise). Targets the top
    membership via the SAME precedence pick as `list_users` (owner>admin>member,
    then most-recent). role is part of the membership PK, so the UPDATE can 409
    (`conflict`) on a collision; 404 if the user has no company membership.
    Emits `user_org_role_change`.
  - **`org_id`** → set / swap the user's primary company (`CMP_…`; 400 on a
    non-CMP prefix, 404 if the company doesn't exist). No membership → INSERT
    (role `member`); existing → re-point in a tx (DELETE old + INSERT new, role
    preserved), 409 on collision; same company → no-op. Emits `user_org_set` /
    `user_org_change`. Backs the Users-tab Org entity-picker.

  The editable Role + Org cells on the Home Users tab PATCH here via the
  cell-editor's per-column `editEndpoint`. Helpers: `top_company_membership`
  (the shared precedence pick), `is_unique_violation` (PK collision → 409).
- **`GET /api/admin/fields` (`list_fields`) is GATED** — the field registry as
  a redtable (CAS_C4219F2B): one `Page<FieldRow>` row per object field with
  `is_editable` / `is_sortable` + per-role permission cells
  (`owner`/`admin`/`member`/`viewer`). Served as `defaults ⊕ overrides` from
  [field_perms.rs](../field_perms.md) + the `field_permissions` table; merged
  rows flag `is_overridden`. Renders through the standard redtable reader.
  **`PUT`** sets one `{object, field, role, permission}` cell — validates against
  the catalog (unknown field → 404; a read-only field can't be granted `write`
  → 400); reverting to the catalog default deletes the override row (keeps the
  table sparse); emits `field_permission_set`. Both require `is_platform_admin`.
  Enforcement of the matrix on field writes is the next slice.
- **`GET /api/admin/types` + `/types/:type` (`list_types` / `get_type`) are GATED**
  — the TypeDefinition contract (CAS_0FBF301F, spec [type-definition](../../../specs/type-definition.md)):
  each builtin object type as a runtime-typed shape (identity + `fields[]` +
  derived `relationships[]` + `ui_hints`) that the framework layer consumes
  instead of hardcoding object types. Each `fields[]` entry is a FieldDef
  carrying storage (`data_type`), presentation (`editor`/`options`/`rel`,
  FE-opaque), and the resolved per-role cells (`perm_class` default ⊕
  `field_permissions` overrides — the SAME merge as `/admin/fields`, stamped onto
  the FieldDef via `overlay_overrides`). Assembled by
  [type_registry.rs](../type_registry.md) from the [field_perms](../field_perms.md)
  registry; `:type` 404s on a non-builtin id. Both require `is_platform_admin`.
  `rid_prefix` is reported as actually minted — `dashboard` shares `FIL_` with
  `file`. `user` is referenced via `rel` but not itself grid-served in v1.
- **`GET /api/admin/audit-catalog` (`audit_catalog`) is GATED** — the static-audit
  half of the Admin Console audit frame (CAS_274EDF3B). One row per tool: latest
  `audit.run` (id / ran_at / git sha+branch), finding counts bucketed
  `low ≤5 · med 6-15 · high >15` (same as `/monitoring/audit-findings/stats`),
  and the **diff vs the previous run** via `audit.run_diff` —
  `new`/`regressed`/`improved`/`fixed`/`unchanged` counts. The flat run/finding
  lists are on `/monitoring/audit-*`; this adds the "what changed since last
  run" axis (nothing else exposes `run_diff`) + the catalog overview. Runtime
  half of the frame = `/monitoring/events`. Requires `is_platform_admin`
  (leak-free 404). NOTE: a tool that stores a value-hash in `severity` (e.g.
  `ui-snapshot`) buckets as `high` — that's the tool's data semantics, mirrored
  here for consistency, not a bug in this endpoint.
- **`GET /api/admin/rbac` (`rbac_resolve`) is GATED — NEUTERED (lean, CAS_C8A9)** —
  RBAC introspection (CAS_274EDF3B). `?subject=<rid>&object=<rid>`. The
  multi-tenant resolver it was built on (`resolve_grant`/`principals`/`grant_edges`)
  was deleted in the lean slim, so it now reports the degenerate single-user
  result: `subject_is_platform_admin` (still real, via `is_platform_admin`),
  `effective="all"` for an admin else null, and empty `principals`/`edges`/
  `direct`/`scope`. Requires `rbac::is_platform_admin(caller)` (leak-free 404);
  400 on missing params. Response shape unchanged for the FE. The full reach
  introspection is in the `full-app-pre-slim` snapshot. ([rbac.md](../rbac.md))
- **`POST /api/admin/memberships` validator is double-keyed**: `(scope ⇒ role_allow, ctx_allow, role_default)` and `context_role` is checked against the per-scope `*_CONTEXT_ROLES` allow-list (Reporter/Case Owner/Watcher/Assignee for cases, CEO/CTO/… for companies, Project Owner/Data Analyst/… for projects, Team Manager/Lead/Member for teams). Empty context_role is allowed at every scope — it normalizes to `""` at the DB layer (`memberships.context_role` is NOT NULL with default `''`). FE allow-lists in [home.js memberships createSpec](../../../frontend/scripts/pages/home.md) are kept in sync — drift = 400 from this validator.

## Related

- [Backend pillar landing](../../index.md)
