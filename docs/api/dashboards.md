---
title: Dashboards
section: API
order: 8
---

# `/api/dashboards/*`

CRUD + favourite toggle. Dashboards persist a layout of widgets; the
data fetch happens widget-by-widget in the browser via
[`POST /api/reports/preview`](reports.md) (or `/run`).

**Route file:** [`crates/api/src/routes/dashboards.rs`](../../backend/crates/api/src/routes/dashboards.rs)
**Object reference:** [objects/dashboard.md](../objects/dashboard.md)
**Feature reference:** [features/dashboards.md](../features/dashboards.md)

---

## `GET /api/dashboards`

List the session user's dashboards. Same sort as reports:
`folder ASC NULLS LAST, is_favorite DESC, updated_at DESC`.

```jsonc
200 OK
{ "items": [ /* Dashboard[] */ ] }
```

**Owner join.** Same LEFT JOIN treatment as reports — each row carries
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

Same shape as reports — `PatchDashboardBody` with `title`,
`description`, `is_favorite`, `folder`, all optional (`COALESCE`).
Drives the Objects-page inline-edit columns and the star toggle;
keeps the spec out of scope so the Objects page doesn't need to round-
trip it.

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

The widget spec doesn't carry rows — it carries a pointer:

```jsonc
{
  "slot": "a",
  "kind": "chart",
  "spec": {
    "report_id":      "RPT_…",
    "chart_index":    0,
    "title_override": null
  }
}
```

At render time the frontend:
1. Calls [`POST /api/reports/:report_id/run`](reports.md) (cached per
   `(report_id)` for the dashboard view).
2. Pulls the `ChartSpec` at `report.spec.charts[chart_index]`.
3. Routes the resulting `ReportPage` through `chart-render.js` based on
   the spec's `kind`.

So a dashboard fetch fan-out is N report runs, not N widget-specific
endpoints. There's no `/api/dashboards/:rid/run` — the backend stays
out of the chart-rendering loop.

`text` widgets carry their markdown inline in `spec.markdown` and need
no fetch.

---

## Notes & gotchas

- **Ownership gate.** Every detail endpoint resolves the session user and
  calls `db::dashboard_owner` via `routes::ensure_owner` — 404 on miss
  *or* on owner mismatch (same `kind`/message so existence isn't leaked).
- **Legacy widgets.** Dashboards saved before the chart-ref refactor
  used inline source pickers; on open the builder runs
  `rebuildStaleWidgets()` to migrate them — but the persisted layout
  is only re-saved when the user hits save.
- **Inline grid styles use single quotes.** When a widget renders into
  a CSS grid template area, the inline `style` attribute uses single
  quotes (`style='grid-template-areas: "a b" "c d"'`) so the inner
  quoted strings parse. Don't switch them.

---

## Related

- [objects/dashboard.md](../objects/dashboard.md) — `Dashboard`, `DashboardSpec`, `Widget` DTOs.
- [features/dashboards.md](../features/dashboards.md) — templates + slot model + chart-ref refactor.
- [reports.md](reports.md) — where widgets actually get their data.
