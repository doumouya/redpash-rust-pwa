---
title: Events
section: API
order: 10
last modified date: 2026-05-29
---

# `/api/events`

The runtime observability log — an append-only record of failures and
lifecycle actions, captured from both the backend and the frontend.
Powers the internal monitoring tool.

**Route file:** [`crates/api/src/routes/events.rs`](../../backend/crates/api/src/routes/events.rs)
**Capture helper:** [`crates/api/src/event.rs`](../../backend/crates/api/src/event.rs)
**DTOs:** [`shared::event`](../../backend/crates/shared/src/event.rs) — `Event`, `EventReport`
**Table:** `events` ([db/schema.md](../db/schema.md#events)) · **Migration:** 013

---

## How events are captured

Three paths feed the `events` table:

1. **Automatic — every API failure.** A `capture_mw` middleware wraps
   `/api/*`. After a handler runs, any 4xx/5xx response is persisted as
   an event (`kind = "http_error"`, 5xx → `error`, 4xx → `warn`).
   `AppError::into_response` stashes an `EventInfo` extension carrying
   the error's `kind` + `message`; responses without it (Axum's own
   404/405, the 413 body-limit, `Json`-extractor 400s) are recorded by
   status alone. **No per-handler code** — every failure is logged.
2. **Explicit — lifecycle actions.** `event::record(&db, EventDraft { … })`
   at notable success points. Wired today: `auth_login`, `auth_logout`,
   `file_upload`, `file_delete`, `step_apply` (all `level = "info"`).
3. **Frontend — `POST /api/events`.** A capture module
   ([`scripts/events.js`](../../frontend/scripts/events.js)) logs what
   the backend structurally can't see — uncaught JS exceptions,
   unhandled promise rejections, transport failures (a `fetch` that
   never reached the server), and page-module load/mount failures. HTTP
   error *responses* are **not** re-reported client-side: path 1 above
   already owns them, and re-logging would double every failure. See
   [`POST /api/events`](#post-apievents) for the body and the kinds.

**Fire-and-forget.** `event::record` clones the pool and spawns the
INSERT on a detached task — the request path never blocks on, or fails
because of, event logging. A failed insert is `warn!`-logged and
dropped. An observability layer must never break what it observes.

**Correlation.** `request_id_mw` mints a per-request id, returned as the
`X-Request-Id` response header — the frontend echoes it on its own
events so a client action stitches to the backend request it triggered.
`session_id` (the `rp_session` RID) groups a login-to-logout span.

---

## `GET /api/events`

Recent events, newest first.

### Query parameters

| Param   | Type   | Default | Notes |
|---------|--------|---------|-------|
| `level` | string | —       | Exact-match filter — `debug` / `info` / `warn` / `error` |
| `kind`  | string | —       | Exact-match filter — `http_error`, `auth_login`, `step_apply`, … |
| `limit` | int    | 100     | Clamped to `[1, 1000]` |

### Response

```jsonc
200 OK
{
  "items": [
    {
      "redpash_id":      "EVT_5F3C…",
      "occurred_at":     "2026-05-21T09:14:02Z",
      "origin":          "backend",          // backend | frontend
      "level":           "error",            // debug | info | warn | error
      "kind":            "http_error",
      "message":         "file FIL_… not found",
      "source":          null,
      "user_redpash_id": "USR_…",            // null when unauthenticated
      "session_id":      "SES_…",
      "request_id":      "req_a1b2c3…",
      "http_method":     "GET",
      "http_path":       "/api/files/FIL_…",
      "http_status":     404,
      "duration_ms":     7,
      "context":         { "error_kind": "not_found" }
    }
  ]
}
```

---

## `GET /api/events/:rid`

A single event by RID.

| Status | `kind`      | When |
|--------|-------------|------|
| 404    | `not_found` | Event RID missing |

---

## `POST /api/events`

The frontend reports a client-side event (a JS error, a failed action
such as a rejected cleaner edit). Always answers **`204 No Content`** —
a logging endpoint must never make the caller retry — and the insert is
fire-and-forget, so even a later failure is invisible to the client.

### Body (`EventReport`)

```jsonc
{
  "level":      "error",                 // debug | info | warn | error
  "kind":       "js_error",
  "message":    "Cannot read properties of undefined",
  "source":     "cleaner.js#applyStep",  // optional
  "request_id": "req_a1b2c3…",           // optional — from the X-Request-Id header
  "context":    { "step": "fill_nulls" } // optional
}
```

- **`origin` is forced to `frontend`** server-side — the client can't set it.
- **`user_redpash_id` and `session_id` are resolved server-side** from
  the `rp_session` cookie. The client never asserts its own identity.
- An unrecognised `level` is coerced to `error` so a mislabelled event
  isn't silently dropped.

### Frontend event kinds

The capture module emits these `kind`s automatically — no per-feature
instrumentation:

| `kind`                | Level   | Captured from |
|-----------------------|---------|---------------|
| `js_error`            | `error` | window `error` — an uncaught exception |
| `unhandled_rejection` | `error` | window `unhandledrejection` — a promise with no `.catch()` |
| `network_error`       | `error` | `api.js` — a `fetch` that threw (offline, DNS, connection refused) |
| `page_script_error`   | `error` | a route's JS module 404s or fails to parse |
| `page_mount_error`    | `error` | a route's module threw while mounting |

Every event's `context` carries `url` + `route` — the page the user
was on. Safeguards: a repeat of the same `kind|message` is de-duplicated
within a 10-second window, and one page-session is capped at 100 events,
so a render loop that throws every frame can't flood the table.

---

## Access

The two `GET` endpoints are the internal monitoring read surface —
**open today** (solo / localhost). When the company-admin role lands
(RBAC), gate them behind it; `events` is an admin-facing object.
`POST /api/events` stays open — the frontend needs it, and it's
session-cookied.

---

## Planned — Logs monitoring Dashboard

`GET /api/events` returns a flat, newest-first feed today. Once the
Dashboard feature is production-ready, a **Logs monitoring Dashboard**
will sit on top of it — error rate, level / kind breakdowns, recent
failures at a glance. That surface will likely need aggregation
endpoints (counts grouped by `level` / `kind`, binned over time) rather
than the flat list, and should be gated behind the company-admin role
once RBAC lands.

---

## Retention

`events` is append-only and grows unbounded. A retention prune (delete
rows past a cutoff) is planned; the period is not yet set. The `cases`
table shipped in mig 015 (see [cases.md](cases.md)); events pinned to a
case will be exempt from the prune so an open case can't lose its
troubleshooting evidence.

---

## Related

- [db/schema.md](../db/schema.md#events) — the `events` table + indexes.
- [REDMAP](../REDMAP.md) — Objects › Event, Systems › Event capture.
