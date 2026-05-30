---
title: Event — object metadata
section: Internal
order: 50
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Event (EVT_)

One row in the runtime observability log. **Append-only** by design
— Event is the audit-everything spine the rest of RedPash leans on.
Backend emits via `crate::event::record` / `info` / `warn` / `error`
(fire-and-forget, never blocks request handling). Frontend posts to
`/api/events` for JS errors / promise rejections / transport
failures. Activity feeds (Case detail, per-user activity, monitoring
drill-downs) all query this table.

**Backing table:** `events` (baseline migration `20260529000000_init.sql`).
**DTO:** `backend/crates/shared/src/event.rs` (`Event` + `EventReport`).
**Routes:** `backend/crates/api/src/routes/events.rs` (capture +
read API), `backend/crates/api/src/routes/monitoring.rs` (paginated
admin read + per-resource drill-downs). The middleware in
`routes::mod` (`capture_mw`) emits the auto-captured 4xx/5xx events
on every HTTP request that errored.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create (frontend)` | `POST /api/events` | Body: `EventReport { level, kind, message, source?, request_id?, context? }`. Server stamps `origin = 'frontend'`, `user_redpash_id` (from session), `session_id` (from cookie) — never trusted from the body. Server assigns `EVT_<32hex>` + `occurred_at`. Returns 204 No Content. Errors here are themselves not logged (would recurse). |
| `create (backend)` | — | **Not an HTTP path.** Backend events emit via `crate::event::record(&db, EventDraft)` or the ergonomic builders `event::info / warn / error(pool, kind, msg).user(u).context(c).send()`. Fire-and-forget: the INSERT spawns on a detached task; a logging failure never blocks or fails the request. |
| `create (middleware)` | — | Auto-captured by `capture_mw` in `routes::mod` — every 4xx / 5xx response on `/api/*` becomes one event with kind = `http_error` (default) or whatever the handler stashed via the `EventInfo` extension. Responses with no extension (Axum's own 404/405, 413, extractor 400s) get logged by status alone. |
| `read (single)` | `GET /api/events/:rid` | Returns the full `Event` row. |
| `read (list)` | `GET /api/events?level=&kind=&limit=` | Filter by `level=` (debug / info / warn / error) + `kind=` (exact match on the kind string), capped by `limit=`. Newest first. Lightweight wrapper used by the dev Events panel; the admin paginated list lives at `/api/monitoring/events`. |
| `update` | — | **Not supported.** Events are immutable post-INSERT. |
| `delete` | — | **Not supported via the API.** Retention is handled at the DB layer (no automated prune today — the table grows unboundedly until a future ops-rotation task; not user-facing). |
| `list (admin)` | `GET /api/monitoring/events?page&size&window&level&kind&q` | Paginated `Page<EventSummary>` for the Monitoring Events tab. `window=` is the time-window chip (1h / 24h / 7d / 30d); the rest mirror the dev-list filters. |
| `read (drill-downs)` | `GET /api/monitoring/request/:request_id` | Per-request activity — every event sharing this `request_id`, frontend + backend. Powers the click-to-replay modal on the Monitoring Requests tab. |
| `read (user feed)` | `GET /api/monitoring/users/:rid/activity` | Per-user activity feed — UNIONs `events` + `request_log` on the server side into a single `Page<ActivityRow>` time-ordered stream. |
| `search` | `GET /api/monitoring/events?q=…` | ILIKE substring on `message` + `kind` (admin endpoint only). |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format EVT_<32 uppercase hex>
  Properties:  Sort, Layout
  Description: Primary key. Server-assigned via id::new("EVT").
               Hidden by default in the Monitoring Events tab.
```

```
occurred_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: When the event was captured. Server-assigned (NOT
               client-settable, even from frontend posts — the
               server timestamp is the source of truth so clock-
               skewed clients can't backdate). Default sort key
               (DESC) on every list endpoint. Indexed on
               `(occurred_at DESC)` for the default newest-first
               queries.
```

```
origin
  Type:        TEXT NOT NULL DEFAULT 'backend' / String — enum (see "Enum constraints")
  Properties:  Sort, Layout
  Description: Where the event was captured. Forced to 'frontend'
               for `POST /api/events`; 'backend' for every other
               emit path. Never client-settable from the report
               body. DB-side CHECK constrained.
```

```
level
  Type:        TEXT NOT NULL DEFAULT 'info' / String — enum (see "Enum constraints")
  Properties:  Sort, Search, Layout
  Description: Severity. Client-settable from `EventReport`; the
               server validates against the CHECK constraint. The
               admin list endpoint filters by `?level=`. Indexed
               on `(level, occurred_at DESC)`.
```

```
kind
  Type:        TEXT NOT NULL / String
  Properties:  Sort, Search, Layout
  Description: Machine type — drives the activity-feed filter chips
               + the audit-trail queries. No DB CHECK constraint
               (free-text); the application defines the canonical
               set per object (see each object's "Audit events"
               section). Indexed on `(kind, occurred_at DESC)`.
```

```
message
  Type:        TEXT NOT NULL / String
  Properties:  Search, Layout
  Description: Human-readable message. Used by the dev Events
               panel + the activity-feed render when context
               doesn't carry enough fields for a structured
               render.
```

```
source
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: Emitting site — `routes::files::upload`,
               `cleaner.js#applyStep`, etc. Free-text;
               investigation-only. Null when not supplied (most
               backend emits set it; frontend posts may omit).
```

```
user_redpash_id
  Type:        TEXT / Option<String> — FK to users.redpash_id
  Properties:  Nillable, Sort, Layout
  Description: Who triggered the event. Server-resolved from the
               session cookie on every emit; the frontend post
               body's `user` field (if present) is ignored. **SET
               NULL** on user delete (NOT CASCADE — the audit
               history outlives the deletion of the user it's
               about; "ghost user" rows survive for forensic
               investigation). Indexed on `(user_redpash_id,
               occurred_at DESC)` for the per-user activity feed.
```

```
session_id
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: The `rp_session` RID at the time of the emit —
               groups a login-to-logout span. Plain TEXT, not an
               FK (sessions expire; the event survives expiration).
               Server-resolved from the cookie.
```

```
request_id
  Type:        TEXT / Option<String>
  Properties:  Nillable, Layout
  Description: Per-request correlation id (`req_<uuid>`). Echoed
               back as the `X-Request-Id` response header. Lets
               the activity-feed correlate every event from one
               request, frontend + backend. Indexed on
               `(request_id)`.
```

```
http_method, http_path, http_status, duration_ms
  Type:        TEXT / Option<String>  (status / duration: Option<i32>)
  Properties:  Nillable, Sort (status / duration), Layout
  Description: HTTP-call metadata, populated by `capture_mw` on
               auto-captured events. NULL for explicit emits where
               the request context isn't carried through. Surfaced
               on the Monitoring Requests tab + the
               per-request drill-down modal.
```

```
context
  Type:        JSONB NOT NULL DEFAULT '{}' / serde_json::Value
  Properties:  (none — free-form payload)
  Description: Structured event-specific payload. Soft FK
               references travel through here (`context->>'case'`,
               `context->>'file'`, `context->>'project'`, …) —
               activity-feed queries do
               `WHERE context->>'<entity>' = $1` to scope to one
               entity's history. Shape varies per kind; canonical
               shapes are documented on each object's "Audit
               events" section.
```

---

## Enum constraints

`origin ∈ { backend, frontend }` — DB-side CHECK in migration 013
line 18. Server forces the value per emit path (backend on
implicit + middleware emits; frontend on POST /api/events). No
client path to write a third value.

`level ∈ { debug, info, warn, error }` — DB-side CHECK in
migration 013 line 20. Validated at the route handler boundary
(EventReport's level field) so a bad value returns 400 rather
than CHECK violation.

`kind` is **free-text** by design. Each object's "Audit events"
section is the canonical registry of what kinds it emits + the
context shape — the metadata sweep IS the way to discover the
full kind vocabulary. No DB CHECK; an unknown kind in a POST
body lands in the table and surfaces in the dev Events panel
under the value the caller supplied (forgiving by default;
trace-easier-than-validate).

---

## Relationships

```
user_redpash_id → User (USR_)
  Cardinality:  N:1 (a User triggers many Events)
  On delete:    SET NULL (audit outlives the user delete)
  Hydrated as:  — (no `user_display_name` JOIN on Event today;
                consumers either resolve via a second User
                fetch or render the rid directly. Activity feed
                on the Case page passes through the message
                text which usually carries human context;
                operational consumers don't need the join.)
```

```
session_id → (session rid, no FK)
  Cardinality:  N:1 in spirit (a Session's lifetime spans many
                events) but no FK — sessions expire + their rows
                get cleaned up; the events outlive that.
```

```
context.* → various (soft refs via JSONB)
  Cardinality:   N:1 per soft ref (an Event references at most
                 one of each entity kind)
  On delete:     No FK — entity-delete leaves event rows in
                 place for audit. Cases / Files / Projects /
                 Comments / Charts / Dashboards all carry their
                 rid in `context.<entity>` when the event is
                 about them.
```

### Inverse relationships

```
Event has no sub-rows.
```

---

## Audit events

Events are the audit log; they don't themselves emit audit events
(would be recursive). The metadata table on every other object's
"Audit events" section IS the kind registry — each object names
which `events.kind` rows it generates + the context shape per
kind.

The complete kind set today (cross-reference; non-exhaustive on
purpose, since new kinds are added by future object specs as
they roll through):

- **Auth/Identity**: `auth_login`, `auth_logout`, `unauthenticated`,
  `forbidden`, `oauth_disabled`, `dev_login_disabled`,
  `user_create`, `user_update`, `me_update`, `user_delete`.
- **Files**: `file_upload`, `file_patch`, `file_delete`,
  `file_re_encode`, `file_snapshot`, `step_apply`.
- **Projects**: `project_create`, `project_patch`.
- **Charts**: `chart_create`, `chart_update`, `chart_delete`.
- **Dashboards**: `dashboard_update`, `dashboard_patch`,
  `dashboard_delete`.
- **Companies / Memberships**: `company_create`, `company_update`,
  `company_delete`, `company_member_add`,
  `company_member_role_change`, `company_member_leave`,
  `company_member_remove`.
- **Cases**: `case_create`, `case_delete`, `case_status_change`,
  `case_priority_change`, `case_type_change`,
  `case_assignee_change`, `case_category_change`,
  `case_metadata_change`, `case_comment_post`,
  `case_comment_edit`, `case_comment_delete`.
- **System**: `http_error`, `panic`, `avatar_fetch_failed`, `db`,
  `io`, `internal`.
- **Audit findings (FE side)**: `selector_conflict`,
  `class_divergence`, `component_candidate`.
