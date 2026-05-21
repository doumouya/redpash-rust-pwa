---
title: Events
section: API
order: 10
last modified date: 2026-05-21
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
3. **Frontend — `POST /api/events`.** Client-side JS errors and failed
   user actions (see below).

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

---

## Access

The two `GET` endpoints are the internal monitoring read surface —
**open today** (solo / localhost). When the company-admin role lands
(RBAC), gate them behind it; `events` is an admin-facing object.
`POST /api/events` stays open — the frontend needs it, and it's
session-cookied.

---

## Retention

`events` is append-only and grows unbounded. A retention prune (delete
rows past a cutoff) is planned; the period is not yet set. When the
`cases` table lands (user support tickets — the reserved `CAS` prefix),
events pinned to a case will be exempt from the prune so an open case
can't lose its troubleshooting evidence.

---

## Related

- [db/schema.md](../db/schema.md#events) — the `events` table + indexes.
- [REDMAP](../REDMAP.md) — Objects › Event, Systems › Event capture.
