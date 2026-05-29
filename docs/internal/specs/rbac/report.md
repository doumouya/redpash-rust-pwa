---
title: Report — permission catalog
section: Internal
order: 64
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Report — permissions

**Report is not a stored entity — it has no permission keys of its
own.** Per [report metadata](../object-metadata/report.md), the object-
model hard-refresh dissolved the `reports` table; a "Report" is a
*derived view*: a csv-typed File that has ≥1 Chart sourcing it (the
`file_stages` view's `design` rollup IS the report catalog).

So Report access is **fully composed from the keys of its parts** —
there's nothing Report-specific to gate:

| What the user does | Key it actually checks |
|---|---|
| Open the report's data (the source CSV) | [`file.read`](file.md) on the source File |
| Run / preview the report spec (`POST /api/reports/preview`) | [`file.read`](file.md) — preview reads the source frame; the ReportSpec isn't stored |
| Save a chart out of the report (`POST /api/charts`) | [`chart.create`](chart.md) (+ `file.read` on the source) |
| Edit / delete | **N/A** — edits land on the source CSV ([file](file.md)) or the attached [charts](chart.md); there's no Report row to mutate |
| "List reports" | derived — the set of Files with `stage=design`; gated by [`file.list`](file.md) |

---

## Why no keys

The [catalog index](index.md) flagged this: a derived view doesn't get
its own permission keys because there's no row, no wire contract, and
no mutation surface unique to it. Everything a user can do "to a
report" is an operation on a **File** (the source CSV) or a **Chart**
(the saved viz) — both of which have full catalog docs. Minting
`report.*` keys would be aliases that always resolve to `file.*` /
`chart.*`, adding a layer with no policy of its own.

**Scope:** inherited entirely from the source File — `@own` /
`@project` / `@company` / `@all` per [file](file.md). A user sees a
report exactly when they can `file.read` its source CSV; they can
modify it exactly when they can `file.update` the source or
`chart.create`/`chart.update` its charts.

## Note for the enforcement layer

When route-gating ships, the `/api/reports/*` endpoints gate on the
**source File's** keys, not a Report key:
- `POST /api/reports/preview` → `file.read` on `source_file_id` (or
  `source_report_id`'s underlying File).
- `POST /api/reports/:rid/run` → same.

If a future product decision makes Report a first-class saved entity
(its own table + RID), it graduates to a full catalog doc at that
point. Until then, this doc exists to **explicitly record that Report
has no keys** — so the enforcement sweep doesn't go looking for a
`report.*` set that shouldn't exist.
