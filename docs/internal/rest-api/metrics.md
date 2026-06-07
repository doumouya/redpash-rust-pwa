---
title: Metrics
section: API
order: 13
last modified date: 2026-06-03
---

# `/api/metrics`

The performance read surface over `request_log` — total count, error rate, and
p50/p95/p99 latency over a time window, plus the same five numbers per
`(method, route)` ordered by traffic. "How long does a table refresh take" —
measured, not felt. Self-observation (`/metrics` rows) is filtered out so
viewing the dashboard doesn't pollute its own data.

**Route file:** [`crates/api/src/routes/metrics.rs`](../../backend/crates/api/src/routes/metrics.rs)

> **Platform-admin only** (2026-06-03). `request_log` is tenant-less (global
> error rates, latency, full route inventory) — platform-wide system
> observability, not tenant data. The `/metrics` nest is gated by
> `require_platform_admin_mw` (a `from_fn_with_state` layer in `routes/mod.rs`,
> mirroring `/monitoring`); a non-admin gets a leak-free **404** before the
> handler runs. It was anonymously readable before the gate
> (runbook `CAS_CBA057EE…-metrics-anon-leak`).

---

## `GET /api/metrics`

| Param | Type | Default | Notes |
|---|---|---|---|
| `window` | string | `1h` | One of `1h` / `24h` / `7d` / `30d`. Anything else → `400 metrics`. |

```jsonc
200 OK
{
  "window":  { "label": "1h", "since": "2026-06-03T21:00:00Z", "until": "2026-06-03T22:00:00Z" },
  "overall": {
    "count":      1240,
    "errors":     7,
    "error_rate": 0.0056,        // errors / count (status >= 400), 0 on empty window
    "p50_ms":     12,
    "p95_ms":     89,
    "p99_ms":     210
  },
  "by_route": [
    {
      "method":     "GET",
      "route":      "/files/:rid/page",
      "count":      420,
      "errors":     0,
      "error_rate": 0.0,
      "p50_ms":     18,
      "p95_ms":     140,
      "p99_ms":     260
    }
  ]
}
```

`by_route` is ordered by `count` descending. Routes are stored post-`/api`
strip (so `route` reads `/files/:rid/page`, not `/api/files/:rid/page`).

---

## Errors

| Status | `kind`            | When |
|--------|-------------------|------|
| 400    | `metrics`         | `window` not one of 1h / 24h / 7d / 30d |
| 404    | (no body)         | Caller is not a platform admin (leak-free nest gate) |
| 500    | `db`              | Postgres unreachable |

---

## Related

- [monitoring.md](monitoring.md) — the richer request-log / events / audit read surface (also platform-admin).
- [db/schema.md](../db/schema.md) — `request_log` (migration 020).
