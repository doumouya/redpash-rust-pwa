---
title: Report — permission catalog
section: Internal
order: 64
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Report — permissions

Permission keys + default grant matrix for the Report object — a
**derived view** over `project_files`: a csv-typed [File](file.md) that
has ≥1 [Chart](chart.md) sourcing it (the `file_stages` view's `design`
rollup IS the report catalog). Derived from
[report metadata](../object-metadata/report.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**View reaches Report supports:** inherited entirely from the source
File — Report has no row, no RID, no scope columns of its own. Reach
flows **User → Project → File → Report**: `@project` (the source CSV's
project) + (transitively) `@own` (the project's owner) + `@company`
(the project's company) + `@all` (platform admin). All four reaches
own/project/company/all apply, exactly as on the source File. A user
sees a report when they can `report.view` (⇐ `file.view`) its source
CSV.

Report carries its **own view + write atoms** (separate from csv
File's) because the operations are report-shaped — the group-by
`preview` reads a `ReportSpec`, `create` saves a chart out of the
report — even though every reach resolves against the source File. It
is a projection view, not its own table (see Notes).

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `report.view` —
the reach decides *which* report-shaped files the list returns.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `report.view` | the report (open the source data + run / preview the group-by spec via `POST /api/group/preview`) | own · project · company · all | ⇐ [`file.view`](file.md) on the source CSV; the `ReportSpec` isn't stored, so preview gates on the source frame's view |
| `report.view.all` | every report | all | platform admin |
| `report.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field of the report shape (the source's columns + the composed `ReportSpec` slicing). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `report.view.field.all` | every field | own · project · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `report.create` | object `report.view` | — (no row yet) | Save a chart out of the report (`POST /api/charts`) — double-gated on `file.view` of the source. Resolves to [`chart.create`](chart.md); there's no Report row, so "create" persists the report's slicing as a CHT_ row |
| `report.delete` | `report.view.field.all` | own · company · all | **N/A on Report itself** — there's no Report row to destroy. Resolves to deleting the attached [charts](chart.md) (`chart.delete`) or the source [File](file.md) (`file.delete`); listed for matrix completeness |

**No atoms for:** the Report has no stored row — `redpash_id`,
`created_at`, `updated_at` don't exist; per-field `*.update` atoms are
**N/A** (edits land on the source CSV's [file](file.md) fields or the
attached [charts](chart.md)' spec, each gated by its own catalog doc).

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `report-mem` —
a bare project membership (no company role) on the source CSV's
project, which resolves at `own` / `project`. Wider reach wins on
union. Reach is inherited from the source File — this matrix mirrors
[File](file.md)'s.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | report-mem |
|---|---|---|---|---|---|---|
| `report.view` | all | company | company | company | company | project |
| `report.view.field.all` | all | company | company | company | company | project |
| `report.create` | all | company | company | company | — | project |
| `report.delete` | all | company | — | — | — | own |

Reading the matrix: a project member (`report-mem`) views every report
in their project (open the source + preview the group-by) and can save
a chart out of one (`report.create` ⇐ `chart.create`), but can only
delete (the attached charts / source file) in a project they *own* —
the `own` reach. A **company member** views every report in their
company but can't delete; a **company viewer** views only.
**Delete** needs `view.field.all` + the delete atom: project-owner /
company-owner / platform-admin only — and even then it resolves to the
parts ([chart](chart.md) / [file](file.md)), never a Report row.

---

## 3. Notes

- **Report is a derived / projection view, not a table.** The object-
  model hard-refresh (`20260601000001_drop_reports.sql`) dropped the
  prior `reports` table; a "Report" is now the conceptual triple
  `(csv-file, attached-charts, group-by-spec)`. The atoms above are the
  report-shaped *verbs*, but every reach resolves against the source
  [File](file.md) and every write resolves to a [Chart](chart.md) /
  File mutation. Report has no row, no RID, no wire contract of its own
  — these atoms are the view-rooted aliases that always derive to
  `file.*` / `chart.*`. They exist so the enforcement sweep has a
  declared Report surface, not because Report carries independent
  policy.

- **`report.view` ⇐ `file.view` on the source CSV.** Opening report
  data and running `POST /api/group/preview` both read the source
  frame; the `ReportSpec` is composed client-side (`scripts/report.js`)
  and never stored. So the view reach is the source File's reach,
  unchanged — see [file](file.md)'s `own`-reach note (no `owner_id`;
  ownership flows User → Project → File → Report).

- **`report.create` is "save a chart out of the report."** It resolves
  to [`chart.create`](chart.md) (`POST /api/charts`) — the report's
  slicing is persisted as a CHT_ row, double-gated on `file.view` of
  the source. The canonical "save my whole report" surface is a
  [dashboard](dashboard.md) composition of those charts. There is no
  Report row to create.

- **No per-field `*.update` atoms.** A report has no editable Report
  fields — edits land on the source CSV ([file](file.md)'s
  `display_name` / `encoding` / `delimiter` updates) or on the attached
  charts ([chart](chart.md)'s `spec.update`), each gated by its own
  catalog doc. `report.delete` is likewise a parts operation
  (`chart.delete` / `file.delete`), listed only so the matrix is
  reach-complete.

- **First-class graduation.** If a future product decision makes Report
  a stored entity (its own table + RID + wire contract), it graduates
  from derived-alias atoms to independent ones at that point. Until
  then this doc records that Report's keys all derive — the enforcement
  layer gates the grouping endpoint on the **source File's**
  `file.view` (`POST /api/group/preview` → `file.view` on
  `source_file_id`), not a standalone Report key.

- **Today everything resolves `all`.** Dev-permissive:
  `resolve_user_rid` yields the dev_user, which the enforcement layer
  will treat as `plat:admin` until real platform roles ship. This
  matrix is the target the enforcement slice checks against — it
  changes no runtime behavior on its own.
