---
title: Reports
section: API
order: 7
---

# `/api/reports/*`

CRUD + live preview for the Reports page. The same response shape
(`ReportPage`) drives both the builder's preview and the dashboard
widget's data fetch.

**Route file:** [`crates/api/src/routes/reports.rs`](../../backend/crates/api/src/routes/reports.rs)
**Object reference:** [objects/report.md](../objects/report.md)
**Pipeline reference:** [features/reports.md](../features/reports.md)

---

## Response shape — `ReportPage`

Used by both `POST /preview` and `POST /:rid/run`. Each section is
independent so the frontend can render or skip them.

```jsonc
{
  "details":   { "columns": [...], "rows": [[...]], "total": 87 } | null,
  "subtotals": { "columns": [...], "rows": [[...]], "total": 12 } | null,
  "total":     [null, null, 17] | null,    // grand-total row aligned to subtotals columns
  "ms":        23
}
```

| Section     | When present | Notes |
|-------------|--------------|-------|
| `details`   | When `spec.show_details = true` | Filtered source rows, optionally sorted by group_by cols. Capped at **1000 rows**. |
| `subtotals` | When the spec has *any* grouping or aggregations | Always materialized regardless of `show_subtotals` — the flag is display-only on the viewer. |
| `total`     | When `subtotals` is present | Single row aligned to `subtotals.columns` with leading nulls for the group-by cells. |
| `ms`        | Always | Server-side wall-clock for the spec run. |

> **The "always materialized" rule:** dashboards reading from
> `/:rid/run` always see `subtotals` + `total` so a viewer that
> happens to toggle them off doesn't break charts that reference them.

---

## `GET /api/reports`

List the session user's reports. Sort order:
`folder ASC NULLS LAST, is_favorite DESC, updated_at DESC`.

```jsonc
200 OK
{ "items": [ /* Report[] — see objects/report.md */ ] }
```

**Owner join.** The list query LEFT JOINs `users u ON u.redpash_id =
p.owner_id`, so every row carries `owner_id` / `owner_display_name` /
`owner_username` for the Objects-page **Owner** / **Username**
columns. The DTO fields are `Option<String>` with `#[sqlx(default)]` +
`#[serde(default)]` so old clients reading the new payload — and rows
where the owner has been deleted — both stay backward-compatible.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 500    | `db`              | Postgres unreachable |

---

## `POST /api/reports` — create

Body: `ReportRequest` from `shared::report`.

```jsonc
{
  "source_file_id": "FIL_…",
  "title":          "Cases by region",
  "spec":           { /* ReportSpec — see objects/report.md */ },
  "description":    null,
  "folder":         "Operations"     // optional; empty → null
}
```

The handler resolves the project from the source file (`db::find_file`)
so the client doesn't get to pick it. RID generated server-side. The
source file's owner is also checked against the session user — so a
user can't author a report against someone else's data.

```jsonc
200 OK
{ /* Report — saved row */ }
```

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | `source_file_id` missing or owned by another user |
| 500    | `db`              | INSERT failed |

---

## `GET /api/reports/:rid`

Fetch one.

```jsonc
200 OK
{ /* Report */ }
```

| Status | `kind`      | When |
|--------|-------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found` | RID missing **or** the report's owner doesn't match the session user — same `kind` / message both ways so existence isn't leaked |

---

## `PUT /api/reports/:rid` — update

Same body as `POST /api/reports`. Returns the updated `Report`.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | RID missing |

---

## `PATCH /api/reports/:rid` — sparse metadata edit

The Objects-page inline-edit / star-toggle path. Body is
`PatchReportBody` — every field optional, only the present ones change
(`COALESCE` in the SQL):

```jsonc
PATCH /api/reports/RPT_…
{
  "title":        "Cases by region — 2026",
  "description":  null,
  "is_favorite":  true,        // also fired by the star toggle
  "folder":       "Operations"
}
```

The spec / source-file pairing belongs to `PUT` (a full
ReportRequest); PATCH is **metadata only** so the Objects page can
flip a star or rename a row without re-sending the spec it doesn't
have in scope. Returns the updated `Report`.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | RID missing |

---

## `DELETE /api/reports/:rid`

```
204 No Content     ← removed
404 Not Found      ← RID missing
```

No body either way.

---

## `POST /api/reports/preview` — run without saving

The builder's live preview. The spec runs against either a raw source
file **or** a saved report's subtotals output.

### Body

```jsonc
{
  "source_file_id":   "FIL_…",   // exactly one of these…
  "source_report_id": "RPT_…",   // …must be set
  "spec":             { /* ReportSpec */ }
}
```

**Polymorphic source resolution:**
- `source_file_id` → hydrate the raw CSV (with applied cleaner steps replayed).
- `source_report_id` → hydrate the report's source file, run the
  report's saved spec, then run the caller's spec **on top of** the
  resulting subtotals frame. This is what lets a dashboard widget chart
  already-aggregated data without re-doing the report's
  group/filter work.

Whichever id is supplied is gated on ownership — a 404
`not_found` comes back if it belongs to another user.

Returns the `ReportPage` shape above.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `missing_source`  | Neither `source_file_id` nor `source_report_id` was set |
| 400    | `invalid_spec`    | Spec references a column that doesn't exist |
| 400    | `invalid_csv`     | Polars couldn't process the underlying frame |
| 404    | `not_found`       | Source file or report RID missing |

---

## `POST /api/reports/:rid/run`

Run the saved spec — same response shape as `/preview`, no body
required. Handy for the viewer page and for dashboard widgets that
just want the report's output.

```jsonc
200 OK
{ /* ReportPage */ }
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Report RID missing |

---

## `POST /api/reports/:rid/favorite`

Toggle the report's `is_favorite` flag. Drives the home-page sort.

```jsonc
POST /api/reports/:rid/favorite
{ "value": true }
```

```jsonc
200 OK
{ /* Report, with the new is_favorite */ }
```

---

## Notes & gotchas

- **Grand-total sort handling.** The grand-total frame only has agg
  columns — no group-by columns to sort by. The handler strips
  `spec.sort` before running the total query, otherwise the user's
  sort references would fail with "column not found".
- **Eager Polars sort.** The pipeline uses `DataFrame::sort` after
  `group_by().agg()`. The lazy sort path silently drops in some 0.43
  edge cases; do not switch it back.
- **Detail row cap = 1000.** Hard-coded `DETAIL_ROW_LIMIT`. The
  frontend's redtable paginates from the subset; users drill down via
  filters for the full picture.

---

## Related

- [objects/report.md](../objects/report.md) — `Report`, `ReportSpec`, `Aggregation`, `SortSpec`, `WindowSpec`, `TopNFilter`.
- [features/reports.md](../features/reports.md) — pipeline (filter → group/agg → sort → windows → top-N).
- [features/charts.md](../features/charts.md) — chart specs live on reports.
- [dashboards.md](dashboards.md) — chart-ref widgets that consume `/run`.
