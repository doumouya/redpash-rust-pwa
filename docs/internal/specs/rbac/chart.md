---
title: Chart — permission catalog
section: Internal
order: 62
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — object-level gate live: view=require_view; update/delete=require_grant(effective>=Admin) (owner via project scope); create gates on viewing the source file. The per-field atoms below are the v3 custom-role target. RBAC catalog sweep ([index](index.md))
---

# Chart (FIL_ kind=chart) — permissions

Permission keys + default grant matrix for the Chart object — a
`project_files` row with `file_type='chart'`, `spec = {option, svg}`,
sourcing a csv File. A derived-view of [File](file.md): it inherits
File's view reaches but carries its own atoms because the wire contract
differs. Derived from [chart metadata](../object-metadata/chart.md);
see the [catalog template](index.md) for the key scheme + role tiers.

**View reaches Chart supports:** `project_redpash_id` → the same
File-style reach chain — `@project` + (transitively) `@own` (the
project's owner) + `@company` (the project's company); `@all` = platform
admin. A chart inherits its scope from its project, exactly like a csv
File — it's the same table. `source_file_id` is a data dependency (the
chart reads that File's frame to render), not a reach. All four reaches
own/project/company/all apply.

Charts get their **own atoms** (separate from csv File's) because the
wire contract differs — `POST /api/charts` takes a `spec`, not a
multipart upload; `PUT /api/charts/:rid` writes the spec. Same scope
columns, different verbs.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `chart.view` — the
reach decides *which* charts the list returns.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `chart.view` | the chart (detail / list / search; `GET /api/charts/:rid`, `GET /api/charts`, `?q=`) | own · project · company · all | `own` = the caller owns (holds a membership on) the chart's project; one key covers read + list + search |
| `chart.view.all` | every chart | all | platform admin |
| `chart.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per editable field: `title` · `spec` · `source_file_id` (+ read-only `filename`, computed fields, `created_at`, …). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `chart.view.field.all` | every field | own · project · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `chart.create` | object `chart.view` | — (no row yet) | `POST /api/charts`, body `{ project_id, source_file_id, spec }`. Caller must be able to view `source_file_id` (enforcement checks the source). `file_type` (chart) set server-side |
| `chart.title.update` | `chart.view.field.title` | own · project · company · all | Rename the chart |
| `chart.spec.update` | `…field.spec` | own · project · company · all | Writes the spec (option + svg) — the chart-builder's output |
| `chart.source_file_id.update` | `…field.source_file_id` | own · company · all | Re-point the chart at a different source File — needs view on the new source too |
| `chart.delete` | `chart.view.field.all` | own · company · all | `DELETE /api/charts/:rid` — removes the CHT_ row. Not project-viewers |

**No atoms for:** `redpash_id`, `file_type` (fixed `chart`),
`project_redpash_id` (charts don't move projects in v1 — re-create in
the target), computed fields, `created_at` / `updated_at`.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `chart-mem` —
a bare project membership (no company role), which resolves at `own` /
`project`. Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | chart-mem |
|---|---|---|---|---|---|---|
| `chart.view` | all | company | company | company | company | project |
| `chart.view.field.all` | all | company | company | company | company | project |
| `chart.create` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `chart.title.update` | all | company | company | — | — | project |
| `chart.spec.update` | all | company | company | — | — | project |
| `chart.source_file_id.update` | all | company | company | — | — | own |
| `chart.delete` | all | company | — | — | — | own |

Mirrors [File](file.md)'s matrix — a chart is a File-kind, scoped the
same. A project member (`chart-mem`) views every chart in their project
(whole records), can create, and edit title/spec (the chart-builder) at
the `project` reach — but can only re-point the source or delete charts
in a project they *own* (the `own` reach). A **company member** views
every chart in their company (whole records) but can't mutate; a
**company viewer** views only. A **company admin** has full field
control over company-project charts except deletion. **Delete** needs
`view.field.all` + the delete atom: project-owner / company-owner /
platform-admin only.

---

## 3. Notes

- **Chart = File-reach, Chart-atoms.** The reach chain is identical to
  csv File (project-rooted ownership); only the atoms differ because the
  wire is spec-based, not multipart. Re-using File's scope columns is
  deliberate — one place defines "who can see this project's stuff."

- **Chart is a FIL_ kind row.** A `project_files` row with
  `file_type='chart'` (spec = option + svg) — the same table as csv
  File. It inherits File's view reaches but carries its own atoms since
  the wire contract differs per kind (see the [index](index.md)
  derived-view convention; the kind split is noted in
  [file](file.md)'s Notes).

- **Create is double-gated on the source.** `chart.create` needs view
  on `source_file_id` (you can't chart data you can't see) — the
  enforcement checks the source File's `file.view` alongside the create
  grant. Same double-gate as File's cross-project move.

- **No project-move atom in v1.** Unlike csv File, charts don't carry a
  `chart.project.update` atom — the v1 flow is re-create in the target
  project. Add the move atom if/when the chart-builder grows a "move to
  project" affordance.

- **Spec edits = the chart builder.** `chart.spec.update` is what the
  Workspace designer / the Settings chart-picker writes. A project
  member holds it (`project`); a viewer doesn't.

- **Today everything resolves `all`.** Dev-permissive:
  `resolve_user_rid` yields the dev_user, which the enforcement layer
  will treat as `plat:admin` until real platform roles ship. This matrix
  is the target the enforcement slice checks against — it changes no
  runtime behavior on its own.
</content>
</invoke>
