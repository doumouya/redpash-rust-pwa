---
title: Project — permission catalog
section: Internal
order: 54
last modified date: 2026-05-30
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Project (PRJ_) — permissions

Permission keys + default grant matrix for the Project object. Derived
from [project metadata](../object-metadata/project.md); scheme in the
[catalog template](index.md).

**Scope qualifiers Project carries:** owner-membership (`memberships`
`role='owner'`) → `@own`; `company_id` → `@company`; the project's own
`redpash_id` is the `@project`-scope root for its children (Files,
Cases). `@all` = platform admin. Project is the **project-role source**
(`memberships.role` on project-typed rows — the owner row is live now;
the additive admin/member/viewer grants land with project RBAC).

Ownership is a `memberships` row (`role='owner'`), live today:
`ensure_owner` resolves it via `db::project_owner` (which queries
`memberships`). There is NO `projects.owner_id` column — membership
ownership is the live gate, not a v3 plan. (The PATCH body still
accepts an `owner_id` *field* as input, but it transfers the
owner-membership; it isn't a column.)

---

## 1. Keys

### Object-action keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `project.create` | `POST /api/projects` (+ ensure_default/named) | — | Any authenticated user; creator is seated as `owner` (a `memberships` row, `role='owner'`). |
| `project.read` | `GET /api/projects/:rid` | own · project · company · all | |
| `project.update` | `PATCH /api/projects/:rid` | own · project · company · all | Coarse; fields below. |
| `project.delete` | `DELETE /api/projects/:rid` | own · company · all | CASCADEs files+steps+reports+dashboards. Default project is 400. NOT grantable to project-viewers. |
| `project.list` | `GET /api/projects` | own · company · all | The caller's projects (today owner-scoped). |
| `project.search` | `GET /api/projects?q=…` | own · company · all | Granted with `list`. |

### Field-update keys

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `project.owner_id.update` | `owner_id` | own · all | **Ownership transfer.** Owner hands off, or platform admin reassigns. Never company-admin (transferring is an owner act). |
| `project.name.update` | `name` | own · project · company · all | |
| `project.description.update` | `description` | own · project · company · all | |
| `project.is_default.update` | `is_default` | own · all | Which project is the user's default upload target — a per-owner choice. |
| `project.status.update` | `status` | own · project · company · all | Lifecycle (active/archived/…). |
| `project.company_id.update` | `company_id` | own · all | Re-scoping a project to a company — owner-level (gives the project to a company). |

**No keys for:** `redpash_id`, computed `stage` (derived via
`file_stages` view, never settable), `created_at`, `updated_at`.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | proj:collab | proj:viewer | @own |
|---|---|---|---|---|---|---|---|
| `project.create` | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `project.read` | all | company | company | company | project | project | own |
| `project.list` | all | company | company | company | project | project | own |
| `project.search` | all | company | company | company | project | project | own |
| `project.update` | all | company | company | — | project | — | own |
| `project.delete` | all | company | — | — | — | — | own |
| `project.owner_id.update` | all | — | — | — | — | — | own |
| `project.name.update` | all | company | company | — | project | — | own |
| `project.description.update` | all | company | company | — | project | — | own |
| `project.is_default.update` | all | — | — | — | — | — | own |
| `project.status.update` | all | company | company | — | project | — | own |
| `project.company_id.update` | all | — | — | — | — | — | own |

Reading it: the owner has full control of their own project (`@own`);
a project collaborator (v3) can read + edit name/description/status but
not delete, transfer, or re-scope; a viewer reads only; company
admins manage company-scoped projects but can't transfer ownership or
flip another user's default; `is_default` is strictly the owner's
per-account choice.

---

## 3. Notes

- **Owner-membership is the live gate.** Today `ensure_owner` resolves
  the project's owner via `db::project_owner` (a `memberships` row with
  `role='owner'`) and checks it `== caller`; that's the `@own`
  predicate. There's no `projects.owner_id` column — membership
  ownership is live now, not a v3 plan. The additive admin/member/viewer
  grants (the rows below `owner`) are declared here but not yet wired by
  any project member route; they fill in as project RBAC lands, reusing
  the same `memberships` table.

- **`project.delete` excludes viewers + members.** Cascade is
  destructive (files + steps + reports + dashboards). Only the owner,
  a company owner (for company projects), or platform admin.

- **Default-project delete is blocked structurally.** `DELETE` on an
  `is_default` project returns 400 regardless of grant — a guard, not
  a permission (every user keeps a default workspace).

- **Ownership transfer (`project.owner_id.update`) is owner-only.**
  Company admins manage but don't reassign ownership; that's the
  owner's or platform admin's call.

- **`@project` scope is forward-looking.** It bounds grants to the
  project's own children (Files/Cases scoped by `project_id`); for the
  Project row itself, `@project` collab/viewer act on the project they
  belong to.
