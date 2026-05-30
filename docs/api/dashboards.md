---
title: Dashboards
section: API
order: 8
last modified date: 2026-05-30
---

# `/api/dashboards/*`

CRUD + favourite toggle. A dashboard is a **dashboard-typed `project_files`
row** (`file_type='dashboard'`; new dashboards mint a `FIL_…` rid, pre-fold
rows kept their `DSH_…`); the standalone `dashboards` table was retired in
the object-model fold. The persisted spec is a layout of widgets; each
widget points at a saved chart (`CHT_…` — see [charts.md](charts.md)) and
the data fetch happens widget-by-widget in the browser, where each chart
re-aggregates via `POST /api/group/preview`. There is no backend
dashboard-data endpoint — the API stays out of the chart-rendering loop.

**Route file:** [`crates/api/src/routes/dashboards.rs`](../../backend/crates/api/src/routes/dashboards.rs)
**Object reference:** [objects/dashboard.md](../objects/dashboard.md)
**Feature reference:** [features/dashboards.md](../features/dashboards.md)

---

## `GET /api/dashboards`

List the session user's dashboards. Sort: `folder ASC NULLS LAST,
is_favorite DESC, updated_at DESC`. Server-side filter: `project_files
WHERE file_type = 'dashboard'`.

```jsonc
200 OK
{ "items": [ /* Dashboard[] */ ] }
```

**Owner join.** Owner is resolved via the **owner-membership LATERAL**
on the dashboard row's project (`memberships WHERE object_redpash_id =
projects.redpash_id AND role = 'owner' ORDER BY joined_at LIMIT 1`,
then `users JOIN`) — same shape as charts. Each row carries
`owner_id` / `owner_display_name` / `owner_username` for the Objects-
page **Owner** / **Username** columns. DTO fields are `Option<String>`
with `#[sqlx(default)]` + `#[serde(default)]`.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 500    | `db`              | Postgres unreachable |

---

## `POST /api/dashboards` — create

Body: `DashboardRequest`.

```jsonc
{
  "project_redpash_id": "PRJ_…",
  "title":              "Ops weekly",
  "spec":               { /* DashboardSpec — see objects/dashboard.md */ },
  "description":        "Open cases × region × week",
  "folder":             "Operations"     // optional
}
```

Returns the saved `Dashboard`. RID minted server-side.

### Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 401    | `unauthenticated` | OAuth enabled, no session |
| 404    | `not_found`       | `project_redpash_id` missing or owned by another user |
| 500    | `db`              | INSERT failed |

`project_redpash_id` is gated against the session user — the client
can't drop a dashboard into someone else's workspace.

---

## `GET /api/dashboards/:rid`

Fetch one.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | RID missing |

---

## `PUT /api/dashboards/:rid` — update

Same body as `POST`. Returns the updated `Dashboard`.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | RID missing |

---

## `PATCH /api/dashboards/:rid` — sparse metadata edit

Same shape as charts — `PatchDashboardBody` with `title`,
`description`, `is_favorite`, `is_public`, `folder`, all optional (`COALESCE`).
Drives the Objects-page inline-edit columns and the star toggle;
keeps the spec out of scope so the Objects page doesn't need to round-
trip it. Owner mismatch returns `404 not_found` (same shape as miss).

```jsonc
PATCH /api/dashboards/DSH_…
{ "is_favorite": true }
```

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | RID missing |

---

## `DELETE /api/dashboards/:rid`

```
204 No Content     ← removed
404 Not Found      ← RID missing
```

---

## `POST /api/dashboards/:rid/favorite`

```jsonc
POST /api/dashboards/:rid/favorite
{ "value": true }
```

```jsonc
200 OK
{ /* Dashboard, with new is_favorite */ }
```

---

## How widgets get their data

The widget spec doesn't carry rows — it carries a pointer to a saved
chart:

```jsonc
{
  "slot": "a",
  "kind": "chart",
  "spec": {
    "chart_id":       "CHT_…",      // chart-typed project_files row
    "title_override": null
  }
}
```

At render time the frontend:
1. Fetches each chart by id — `GET /api/charts/:chart_id` (in parallel).
2. Re-aggregates the chart's grouping spec via `POST /api/group/preview`
   and draws it with `buildOption` (`charts/build.js`).

So a dashboard fetch fan-out is N chart fetches + N group-previews, not N
widget-specific endpoints. There's no `/api/dashboards/:rid/run` and no
`/api/charts/:rid/run` — the backend stays out of the chart-rendering loop.

`text` widgets carry their markdown inline in `spec.markdown` and need
no fetch.

> **Legacy widgets.** Widgets saved before the chart-ref refactor
> referenced `report_id` + `chart_index`; the designer no longer
> understands that shape. On load it keeps only `kind === "chart"`
> widgets and prunes any whose `chart_id` 404s, self-healing the spec
> with a `PUT` — see [features/dashboards.md](../features/dashboards.md).

---

## Notes & gotchas

- **Ownership gate.** Every detail endpoint resolves the session user and
  calls `db::dashboard_owner` via `routes::ensure_owner` — 404 on miss
  *or* on owner mismatch (same `kind`/message so existence isn't leaked).
- **No template grid.** Tiles lay out on a fixed 12-column CSS grid
  (`.ds-grid`); `DashboardSpec.template_id` is persisted but unused.
  There is no named-template registry or `grid-template-areas` markup.

---

## Related

- [objects/dashboard.md](../objects/dashboard.md) — `Dashboard`, `DashboardSpec`, `Widget` DTOs.
- [features/dashboards.md](../features/dashboards.md) — chart-ref widgets, the designer + the render path.
- [charts.md](charts.md) — where widgets actually get their data.
- [files.md](files.md) — dashboards share the `project_files` row lifecycle (delete cascades via `entities`).
