---
title: Project — permission catalog
section: Internal
order: 54
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Project (PRJ_) — permissions

Permission keys + default grant matrix for the Project object. Derived
from [project metadata](../object-metadata/project.md); scheme in the
[catalog template](index.md).

**Scope columns Project carries:** `owner_id` → `@own`; `company_id` →
`@company`; the project's own `redpash_id` is the `@project`-scope root
for its children (Files, Cases). `@all` = platform admin. Project is
the **project-role source** (`project_memberships.role`, v3 — schema
exists, inert until RBAC v3 wires it).

The `owner_id` column is the live ownership gate today (`ensure_owner`
keys off it); `project_memberships.role = owner` is its v3 mirror
(auto-inserted alongside `owner_id` when the table activates).

---

## 1. Keys

### Object-action keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `project.create` | `POST /api/projects` (+ ensure_default/named) | — | Any authenticated user; creator is `owner_id`. |
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

- **`owner_id` is the live gate.** Today `ensure_owner` checks
  `projects.owner_id == caller` directly; that's the `@own` predicate.
  The `project_memberships` tier (collab/viewer columns) is declared
  here but inert until RBAC v3 wires the table — when it does, an
  `owner`-role membership row is auto-inserted alongside `owner_id` so
  there's one code path.

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
