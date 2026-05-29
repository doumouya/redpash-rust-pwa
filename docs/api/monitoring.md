---
title: Monitoring
section: API
order: 12
last modified date: 2026-05-29
---

# `/api/monitoring/*`

The read surface for the `/monitoring` page. Every endpoint returns
`Page<T>` (the same envelope as [`GET /api/files/:rid/page`](files.md#get-apifilesridpage)) — the
redtable on each monitoring tab reuses the existing reader. Window
parameters mirror [`/api/metrics`](metrics.md): `1h`, `24h`, `7d`,
`30d`.

> **Access.** Open today (solo / localhost) — same posture as
> [events.md](events.md). Gate behind the company-admin role when RBAC
> lands. The data is admin-facing; the read-only nature limits blast
> radius but the rows include PII (request paths with user RIDs,
> activity feeds).

**Route file:** [`crates/api/src/routes/monitoring.rs`](../../backend/crates/api/src/routes/monitoring.rs)
**DTOs:** [`shared::monitoring`](../../backend/crates/shared/src/monitoring.rs) — `EventSummary`, `AuditRunSummary`, `AuditFindingSummary`, `RequestSummary`, `RequestDetail`, `DbQuerySummary`, `ActivityRow`, plus the `*Stats` aggregates
**Wire contract:** [`docs/internal/admin-monitoring-surfaces.md §6`](../internal/admin-monitoring-surfaces.md)

---

## Endpoint map

| Route | Returns | Filters (query string) |
|---|---|---|
| `GET /api/monitoring/events` | `Page<EventSummary>` | `window` · `level` · `kind` · `q` · `page` · `size` |
| `GET /api/monitoring/events/stats` | `EventsStats` | `window` |
| `GET /api/monitoring/audit-runs` | `Page<AuditRunSummary>` | `tool` · `q` (tool / git_branch / partial sha) · `page` · `size` |
| `GET /api/monitoring/audit-runs/stats` | `AuditRunsStats` | — |
| `GET /api/monitoring/audit-findings` | `Page<AuditFindingSummary>` | `run` · `tool` · `kind` · `q` (tool / kind / finding_key) · `page` · `size` |
| `GET /api/monitoring/audit-findings/stats` | `AuditFindingsStats` | — |
| `GET /api/monitoring/requests` | `Page<RequestSummary>` | `window` · `route` · `status` · `method` · `page` · `size` |
| `GET /api/monitoring/requests/stats` | `RequestsStats` | `window` |
| `GET /api/monitoring/queries` | `Page<DbQuerySummary>` | per-query `db_query_log` capture; `window` · `q` · `page` · `size` |
| `GET /api/monitoring/request/:request_id` | `RequestDetail` | per-request drill-down (M-1 slice E). Singular path to avoid collision with `/requests/stats` |
| `GET /api/monitoring/users/:user_rid/activity` | `Page<ActivityRow>` | per-user investigation feed (M-2 slice E) — events + requests interleaved chronologically |
| `GET /api/monitoring/optimization-points` | `Page<OptimizationPoint>` | `subsystem` · `status` · `page` · `size` |
| `PATCH /api/monitoring/optimization-points/:rid` | `OptimizationPoint` | flip the row's `status` (e.g. `open` → `resolved`) |

---

## Page envelope

Every list endpoint returns the standard `Page<T>`:

```jsonc
{
  "rows":        [ /* T[] */ ],
  "total":       137,
  "all_count":   137,        // same as total — monitoring has no underlying-frame distinction
  "page":        1,
  "size":        25,
  "pages":       6,
  "ms":          12,
  "row_indices": [0, 1, 2, …] // index per page row, for FE virtualization
}
```

Stats endpoints (no pagination, no rows) return a single object —
shape per DTO in `shared::monitoring`.

---

## Window resolution

`?window=` resolves to a UTC cutoff (`now() - window`). Accepted
values: `1h` · `24h` · `7d` · `30d`. Missing window = no time filter
("all of history"). An unknown value returns `400 bad_request` — same
shape as [`/api/metrics`](metrics.md).

---

## Free-text search (`q`)

`events`, `audit-runs`, `audit-findings`, `queries` all accept a `q`
parameter — ILIKE-substring match against the columns called out in the
route's docstring. Empty / whitespace-only `q` is dropped server-side.

---

## Optimization points

The `optimization-points` table records observed performance / quality
follow-ups (slow query, N+1, oversized index, missing constraint, …).
`PATCH /:rid` flips the row's `status` so the monitoring page can mark
items resolved or wont-fix from the UI; the body is a minimal `{ status
}` patch (validated against the column's enum-like CHECK).

```jsonc
PATCH /api/monitoring/optimization-points/OPT_…
{ "status": "resolved" }
```

---

## Per-request drill-down

`GET /api/monitoring/request/:request_id` returns the full
`RequestDetail` for one `request_log` row — the originating event, the
captured `db_query_log` rows fanned out by that request, the response
status / size / duration. Driven by clicking a row in the Requests
tab.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | `request_id` not in `request_log` |

---

## Per-user activity feed

`GET /api/monitoring/users/:user_rid/activity` returns a
chronologically interleaved feed of that user's `events` + `requests`,
paginated. Drives the M-2 slice E investigation view — "what did this
user do" across the audit + request planes in one timeline.

---

## Related

- [events.md](events.md) — the audit log itself + how rows get into
  `events` (every monitoring `EventSummary` is a projection of one
  `events` row).
- [db/schema.md](../db/schema.md) — `events`, `request_log`,
  `db_query_log`, `audit.run`, `audit.run_diff`, `optimization_points`.
- [admin.md](admin.md) — adjacent admin-facing read surface (users,
  companies, memberships, steps — vs monitoring's audit / request /
  query planes).
- [`docs/internal/admin-monitoring-surfaces.md`](../internal/admin-monitoring-surfaces.md)
  — wire contract + per-tab acceptance criteria.
