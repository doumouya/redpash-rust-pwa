---
title: Event — permission catalog
section: Internal
order: 60
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Event (EVT_) — permissions

Permission keys + default grant matrix for the Event object — the
append-only runtime observability log. Derived from
[event metadata](../object-metadata/event.md); scheme in the
[catalog template](index.md).

**Append-only — no update/delete.** Events are immutable post-INSERT;
retention is a future DB-layer prune, never a user-facing delete. So
Event has no mutate keys at all — only create (mostly system) + read.

**Scope columns Event carries:** `user_redpash_id` → `@own` (events
about you — the per-user activity feed). Events have no company/project
column, so there's no `@company`/`@project` scope; the cross-user
firehose (the Monitoring Events / Requests tabs) is `@all` —
platform-admin observability. `@own` is the user's own activity trail.

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `event.create` | `POST /api/events` (frontend) | — | FE error/telemetry report. Server stamps origin/user/session — body-supplied identity never trusted. Backend + middleware emits are non-HTTP (`crate::event::record`), no caller grant. |
| `event.read` | `GET /api/events/:rid` + drill-downs | own · all | Single event + the request-replay drill-down. Own activity, or platform-admin all. |
| `event.list` | `GET /api/events` + user feed | own · all | The Monitoring Events tab (`@all`) + the per-user activity feed (`@own`, `/monitoring/users/:rid/activity`). |

**No keys for:** `update` / `delete` — **not supported** (append-only;
the metadata states events are immutable + retention is DB-layer).
No field-update keys (nothing settable post-INSERT). **No keys for:**
`redpash_id`, `occurred_at`, and every other column (all server-set at
emit).

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | @own |
|---|---|---|---|---|---|
| `event.create` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `event.read` | all | — | — | — | own |
| `event.list` | all | — | — | — | own |

Reading it: any authenticated client can POST a frontend event
(error/telemetry — that's how the FE error funnel works); a user reads
their **own** activity trail (`@own` — the User-Activity feed scoped to
their `user_redpash_id`); the cross-user firehose (every event, every
user — the Monitoring Events/Requests tabs) is platform-admin only.
Company roles get **no** event grants — events aren't company-scoped
(no `company_id` column), so there's no coherent `@company` slice.

---

## 3. Notes

- **No `@company` scope — events lack the column.** Unlike Case/File,
  Event has no `company_id`, so "see my company's events" isn't
  expressible against the current schema. The firehose is `@all`
  (platform admin) and the personal trail is `@own`. If company-scoped
  observability is wanted later, it needs an `events.company_id` (or a
  join through `user_redpash_id → memberships`) — a schema change, not
  a catalog change.

- **`event.create` is broad but identity-safe.** Anyone can POST a
  frontend event (the FE error funnel must work for every session),
  but the server stamps `origin='frontend'` + `user`/`session` from
  the cookie — the body can't forge identity. So the grant is wide;
  the trust boundary is server-side stamping, not the permission.

- **Append-only → the catalog is read-shaped.** No mutate keys exist.
  This is the canonical append-only object (Step is the other);
  contrast with mutable objects that carry a full CRUD key set.

- **The activity feed is `event.list@own`.** `/monitoring/users/:rid/activity`
  is one user's events ∪ request_log — gated by `event.list@own` (your
  own) or `@all` (an admin investigating another user). The
  comment/pref/step activity surfaced there are all `events` rows, so
  they ride this one key — no per-source activity keys.
