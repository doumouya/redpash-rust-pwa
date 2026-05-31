---
title: Project — permission catalog
section: Internal
order: 54
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Project (PRJ_) — permissions

Permission keys + default grant matrix for the Project object. Derived
from [project metadata](../object-metadata/project.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches Project carries:** owner-membership (`memberships`
`role='owner'`) → `own`; `company_id` → `company`; platform admin →
`all`. Project is itself the `project`-scope root for its children
(Files, Cases), so it has no self-referential `project` reach — its own
reaches are `own` · `company` · `all`. Project is the **project-role
source** (`memberships.role` on project-typed rows — the owner row is
live now; the additive collaborator/viewer grants land with project
RBAC).

Ownership is a `memberships` row (`role='owner'`), live today:
`ensure_owner` resolves it via `db::project_owner` (which queries
`memberships`). There is NO `projects.owner_id` column — membership
ownership is the live gate, not a v3 plan. (The PATCH body still
accepts an `owner_id` *field* as input, but it transfers the
owner-membership; it isn't a column.)

**`own` predicate for Project:** a row is "own" when the caller holds
the project's `role='owner'` membership. Project-role tiers are
`owner` / `collaborator` (= `member`) / `viewer`, all rows of the
polymorphic `memberships` table scoped to the project.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `project.view` —
the reach decides *which* projects the list returns.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `project.view` | the project (detail / list / search) | own · company · all | `own` = the caller holds the project's `role='owner'` membership |
| `project.view.all` | every project | all | platform admin |
| `project.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `name` · `description` · `status` · `is_default` · `owner` · `company`. Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `project.view.field.all` | every field | own · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `project.create` | object `project.view` | — (no row yet) | any authenticated user; creator is seated as `owner` (a `memberships` row, `role='owner'`) |
| `project.name.update` | `project.view.field.name` | own · company · all | |
| `project.description.update` | `…field.description` | own · company · all | |
| `project.status.update` | `…field.status` | own · company · all | lifecycle (active/archived/…) |
| `project.is_default.update` | `…field.is_default` | own · all | which project is the user's default upload target — a per-owner choice |
| `project.owner.update` | `…field.owner` | own · all (**owner-only**) | **ownership transfer** — owner hands off, or platform admin reassigns; transfers the owner-membership. Never company-admin — see Notes |
| `project.company.update` | `…field.company` | own · all (**owner-only**) | re-scoping a project to a company (gives the project to a company) — see Notes |
| `project.delete` | `project.view.field.all` | own · company · all (**owner-only at company tier**) | CASCADEs files+steps+reports+dashboards. Default project is 400. Never project-collaborator/viewer — see Notes |

**No atoms for:** `redpash_id`, computed `stage` (derived via
`file_stages` view, never settable), `created_at`, `updated_at`.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `proj-mem` —
a bare project membership (owner / collaborator / viewer, no company
role), which resolves at `own` / `project`. Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | proj-mem |
|---|---|---|---|---|---|---|
| `project.view` | all | company | company | company | company | own |
| `project.view.field.all` | all | company | company | company | company | own |
| `project.create` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `project.name.update` | all | company | company | — | — | own |
| `project.description.update` | all | company | company | — | — | own |
| `project.status.update` | all | company | company | — | — | own |
| `project.is_default.update` | all | — | — | — | — | own |
| `project.owner.update` | all | — | — | — | — | own |
| `project.company.update` | all | — | — | — | — | own |
| `project.delete` | all | company | — | — | — | own |

Reading the matrix: the **owner** has full control of their own project
(the `own` reach, granted by the `role='owner'` membership) — edit
name/description/status, flip its default, transfer ownership, re-scope,
and delete. A **project collaborator** (v3) views the project and edits
name/description/status but can't transfer, re-scope, flip default, or
delete; a **viewer** reads only. **Company admins** manage company-scoped
projects (name/description/status) but can't transfer ownership, flip
another user's default, re-scope, or delete — those stay `co:owner` /
`plat:admin`. **Delete** needs `view.field.all` + the delete atom and is
owner-only at the company tier (admins manage but don't destroy).

---

## 3. Notes

- **Owner-membership is the live gate.** Today `ensure_owner` resolves
  the project's owner via `db::project_owner` (a `memberships` row with
  `role='owner'`) and checks it `== caller`; that's the `own`
  predicate. There's no `projects.owner_id` column — membership
  ownership is live now, not a v3 plan. The additive
  collaborator/viewer grants (the rungs below `owner`) are declared here
  but not yet wired by any project member route; they fill in as project
  RBAC lands, reusing the same `memberships` table.

- **`project.delete` excludes collaborators + viewers.** Cascade is
  destructive (files + steps + reports + dashboards). Only the owner
  (`own`), a company owner (for company projects), or platform admin —
  never `co:admin` and never project-collaborator/viewer.

- **Default-project delete is blocked structurally.** `DELETE` on an
  `is_default` project returns 400 regardless of grant — a guard, not
  a permission (every user keeps a default workspace).

- **Ownership transfer (`project.owner.update`) is owner-only.** Company
  admins manage but don't reassign ownership; that's the owner's
  (`own`) or platform admin's (`all`) call. It transfers the
  owner-membership, not a column.

- **`project.company.update` is owner-only.** Re-scoping a project to a
  company is effectively giving it away — gated to the owner (`own`) and
  platform admin (`all`), never company-admin.

- **`is_default` is strictly the owner's per-account choice.** Which
  project is the default upload target is set only by its owner (`own`)
  or platform admin (`all`) — no company tier flips another user's
  default.

- **Project is the `project`-scope root.** For the Project row itself,
  there is no self-referential `project` reach; `project` as a reach
  bounds grants on the project's *children* (Files/Cases scoped by
  `project_id`). A project-membership resolves at `own` for the project
  row and at `project` for those children.

- **Today everything resolves `@all`.** Dev-permissive:
  `resolve_user_rid` yields the dev_user, which the enforcement layer
  will treat as `plat:admin` until real platform roles ship. This matrix
  is the target the enforcement slice checks against — it changes no
  runtime behavior on its own.
