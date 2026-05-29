---
title: Charts
section: API
order: 7
last modified date: 2026-05-29
---

# `/api/charts/*`

CRUD for **saved charts**. A chart is a chart-typed `project_files` row
(`file_type = 'chart'`, RID prefix `CHT_…`) that stores an opaque JSON
spec (ECharts option + SVG snapshot + group / aggregation). The backend
never runs queries against a chart's spec — Reports authors the spec,
the cleaner / page builder fetches the rows the chart references, the
saved spec is the visualisation contract. This resource replaces the
saved-chart slice of the retired `/api/reports/*` surface (mig 016).

**Route file:** [`crates/api/src/routes/charts.rs`](../../backend/crates/api/src/routes/charts.rs)
**DTO:** [`shared::chart`](../../backend/crates/shared/src/chart.rs) — `Chart`, `ChartRequest`
**Object reference:** [objects/chart.md](../objects/chart.md)

---

## `GET /api/charts`

List the session user's charts (chart-typed `project_files` rows owned
by the caller). Sort: `folder ASC NULLS LAST, is_favorite DESC,
updated_at DESC` — same shape as dashboards. Owner is resolved via the
project's owner-membership LATERAL.

```jsonc
200 OK
{ "items": [ /* Chart[] — see objects/chart.md */ ] }
```

**Owner join.** Each row carries `owner_id` / `owner_display_name` /
`owner_username` for the Objects-page **Owner** / **Username** columns.
`source_file_id` is the csv-typed `FIL_…` the chart was built against
(set on create, not editable on update — see below).

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 500    | `db`              | Postgres unreachable |

---

## `POST /api/charts` — create

```jsonc
POST /api/charts
{
  "source_file_id": "FIL_…",     // required — the csv-typed file the chart reads from
  "title":          "Cases by region",
  "spec":           { /* ChartSpec — opaque ECharts option + SVG snapshot + aggregations */ }
}
```

The handler resolves the **source file's owner** (not the caller's
projects directly) — a chart can only be built against a csv the caller
owns. The chart inherits the source file's `project_redpash_id` server-
side (`project_redpash_id` is **not** read from the body, so a client
can't drop a chart into someone else's project). The freshly-minted RID
is `CHT_…`. The chart-typed `project_files` insert is preceded by the
entity-registry handshake (`register_entity('file', rid)`) so the
membership cascade is consistent across object types.

Returns the saved `Chart`. An `chart_create` event is logged.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | `source_file_id` missing or owned by another user |
| 500    | `db`              | INSERT failed |

---

## `GET /api/charts/:rid`

Fetch one. 404 on miss / owner-mismatch.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Chart RID missing or owned by another user |

---

## `PUT /api/charts/:rid` — re-save

Replaces `title` + `spec` in place. The body is the same `ChartRequest`
as `POST`, but `source_file_id` is **ignored** — a chart's source file
is locked at creation. To re-source a chart, create a new one against
the new file and delete the old. A `chart_update` event is logged.

```jsonc
PUT /api/charts/CHT_…
{
  "source_file_id": "FIL_…",        // ignored on update — kept for body shape symmetry
  "title":          "Cases by region (Q4)",
  "spec":           { /* fresh ChartSpec */ }
}
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Chart RID missing or owned by another user |

---

## `DELETE /api/charts/:rid`

Hard-delete the chart-typed `project_files` row via `delete_entity`
(`DELETE FROM entities WHERE id = $1`). The registry cascade takes out
the row + any `memberships` keyed on it. A `chart_delete` event is logged.

**Dashboards referencing this chart degrade gracefully** — widget specs
point at `chart_id` by RID; a vanished `CHT_…` renders as a "missing
chart" placeholder rather than failing the whole dashboard render.

```
204 No Content
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Chart RID missing or owned by another user |

---

## Sparse metadata edit (planned)

There is no `PATCH /api/charts/:rid` today — the Objects-page inline
edit-mode for charts (title / folder / is_favorite) is part of the
next workspace polish slice. The intended shape mirrors `PATCH
/api/dashboards/:rid` (`title`, `description`, `is_favorite`, `folder`,
all optional, COALESCE).

---

## Related

- [objects/chart.md](../objects/chart.md) — `Chart` + `ChartSpec` DTOs.
- [dashboards.md](dashboards.md) — widgets point at `CHT_…` rids.
- [files.md](files.md) — the csv source files charts read from; the
  `source_file_id` FK is `ON DELETE CASCADE`, so deleting a csv removes
  every chart built against it.
- [reports.md](reports.md) — the retired predecessor (mig 016).
