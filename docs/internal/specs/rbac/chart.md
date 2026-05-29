---
title: Chart — permission catalog
section: Internal
order: 62
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Chart (FIL_ kind=chart) — permissions

Permission keys + default grant matrix for the Chart object — a
`project_files` row with `file_type='chart'`, `spec = {option, svg}`,
sourcing a csv File. Derived from [chart metadata](../object-metadata/chart.md);
scheme in the [catalog template](index.md).

**Scope columns Chart carries:** `project_redpash_id` → the same
File-style scope chain (`@own` = the project's owner, `@project`,
`@company`, `@all`). A chart inherits its scope from its project,
exactly like a csv File — it's the same table. `source_file_id` is a
data dependency (the chart reads that File's frame to render), not a
scope.

Charts get their **own action keys** (separate from csv File's) because
the wire contract differs — `POST /api/charts` takes a `spec`, not a
multipart upload; `PUT /api/charts/:rid` writes the spec. Same scope
columns, different verbs.

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `chart.create` | `POST /api/charts` | — | Body `{ project_id, source_file_id, spec }`. Caller must be able to read `source_file_id` (enforcement checks the source). |
| `chart.read` | `GET /api/charts/:rid` | own · project · company · all | |
| `chart.update` | `PUT /api/charts/:rid` | own · project · company · all | Writes the spec (option + svg). |
| `chart.delete` | `DELETE /api/charts/:rid` | own · company · all | Removes the CHT_ row. Not project-viewers. |
| `chart.list` | `GET /api/charts` + admin | own · project · company · all | Chart-typed files the caller can see. |
| `chart.search` | `?q=` | own · project · company · all | Granted with `list`. |

### Field-update keys

| Key | Field | Scopes | Notes |
|---|---|---|---|
| `chart.source_file_id.update` | `source_file_id` | own · company · all | Re-point the chart at a different source File — needs read on the new source too. |
| `chart.title.update` | `title` | own · project · company · all | |
| `chart.spec.update` | `spec` | own · project · company · all | The option + svg payload — the chart-builder's output. |

**No keys for:** `redpash_id`, `file_type` (fixed `chart`),
`project_redpash_id` (charts don't move projects in v1 — re-create in
the target), computed fields, `created_at` / `updated_at`.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | proj:collab | proj:viewer | @own |
|---|---|---|---|---|---|---|---|
| `chart.create` | all | company | company | company | project | — | — |
| `chart.read` | all | company | company | company | project | project | own |
| `chart.list` | all | company | company | company | project | project | own |
| `chart.search` | all | company | company | company | project | project | own |
| `chart.update` | all | company | company | — | project | — | own |
| `chart.delete` | all | company | — | — | — | — | own |
| `chart.source_file_id.update` | all | company | company | — | — | — | own |
| `chart.title.update` | all | company | company | — | project | — | own |
| `chart.spec.update` | all | company | company | — | project | — | own |

Mirrors [File](file.md)'s matrix — a chart is a File-kind, scoped the
same. Project collaborators build + edit charts; viewers read; delete
is owner / company-owner / platform-admin.

---

## 3. Notes

- **Chart = File-scope, Chart-verbs.** The scope chain is identical to
  csv File (project-rooted ownership); only the action keys differ
  because the wire is spec-based, not multipart. Re-using File's scope
  columns is deliberate — one place defines "who can see this
  project's stuff."

- **Create is double-gated on the source.** `chart.create` needs read
  on `source_file_id` (you can't chart data you can't see) — the
  enforcement checks the source File's `file.read` alongside the
  create grant. Same double-gate as File's cross-project move.

- **No project-move key in v1.** Unlike csv File, charts don't carry a
  `project_redpash_id.update` key — the v1 flow is re-create in the
  target project. Add the move key if/when the chart-builder grows a
  "move to project" affordance.

- **Spec edits = the chart builder.** `chart.spec.update` is what the
  Workspace designer / the Settings chart-picker writes. A project
  collaborator holds it (`@project`); a viewer doesn't.
