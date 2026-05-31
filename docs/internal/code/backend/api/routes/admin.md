---
title: backend/crates/api/src/routes/admin.rs
source: ../../../../../../backend/crates/api/src/routes/admin.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-05-31
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

## Public surface

- `pub fn routes` — function

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **`DELETE /api/admin/users/:rid` is scrub-retain**, not hard delete. Self-delete guard (`rid == caller`) remains; sole-owner blocker enforced via `db::user_sole_owner_objects` → 409; otherwise scrub_user_tx runs and returns 204. Mirrors `routes/users.rs::delete_one`. See [runbook CAS_46BA…](../../../../runbooks/CAS_46BA67713EC84871991D3E7475598B47-scrub-retain-user-deletion.md).
- **`list_companies` + `list_teams_admin` my_role subqueries are precedence-ordered (LIMIT 1)** — after the migration 20260531000001 widened the membership PK to `(object, member, role, context_role)`, a plain `(SELECT m.role …)` returns >1 row when the caller holds multiple roles on one object → 500. Both endpoints rank `owner > admin > member > viewer` and `LIMIT 1`. Apply the same shape to any new admin-list endpoint that exposes `my_role`.
- **`POST /api/admin/memberships` validator is double-keyed**: `(scope ⇒ role_allow, ctx_allow, role_default)` and `context_role` is checked against the per-scope `*_CONTEXT_ROLES` allow-list (Reporter/Case Owner/Watcher/Assignee for cases, CEO/CTO/… for companies, Project Owner/Data Analyst/… for projects, Team Manager/Lead/Member for teams). Empty context_role is allowed at every scope — it normalizes to `""` at the DB layer (`memberships.context_role` is NOT NULL with default `''`). FE allow-lists in [home.js memberships createSpec](../../../frontend/scripts/pages/home.md) are kept in sync — drift = 400 from this validator.

## Related

- [Backend pillar landing](../../index.md)
