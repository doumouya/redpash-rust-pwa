---
title: Event — permission catalog
section: Internal
order: 60
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Event (EVT_) — permissions

Permission keys + default grant matrix for the Event object — the
append-only runtime observability log. Derived from
[event metadata](../object-metadata/event.md); scheme in the
[catalog template](index.md).

**Append-only, read-only to users — view atoms only.** Events are
written fire-and-forget by the backend (`crate::event::record`), never
by a user; they're immutable post-INSERT and retention is a future
DB-layer prune, never a user-facing delete. So Event has **no
create/update/delete atoms at all** — *only* `view` atoms. `view` is
the root and the whole catalog: there are no writes to derive.

**View reaches Event supports:** `user_redpash_id` → `own` (events
whose `user_redpash_id == caller` — your own activity trail). Events
have no company/project column, so there's no `company`/`project`
reach; the cross-user firehose (the Monitoring Events / Requests tabs)
is `all` — platform-admin observability.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root.
For Event it's also the *only* atom family — there are no writes,
because users never create, update, or delete events (see header).
`read`/`list`/`search` are all `event.view` — the reach decides *which*
events the list returns (your own trail vs. the cross-user firehose).

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `event.view` | the event (detail / list / search) — `GET /api/events/:rid` + the request-replay drill-down, `GET /api/events`, and the per-user activity feed | own · all | `own` = events whose `user_redpash_id == caller` (the `/monitoring/users/:rid/activity` trail); `all` = the cross-user firehose (Monitoring Events / Requests tabs) |
| `event.view.all` | every event | all | platform admin — the cross-user observability firehose |
| `event.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field (`kind` · `origin` · `user` · `session` · `payload` · …). Standard bundles hold `view.field.all` |
| `event.view.field.all` | every field | own · all | the "see the whole event" atom |

### No write atoms

Event is **append-only and read-only to users**, so there are **no
`create`, `update`, or `delete` atoms** — and therefore none to derive
from view. Events are emitted fire-and-forget by the backend
(`crate::event::record`) and by middleware; the FE error funnel
(`POST /api/events`) is an *unauthenticated, identity-stamped* ingest
path, not a user permission — the server stamps `origin='frontend'` +
`user`/`session` from the cookie, so the body can't forge identity and
no caller grant gates it. **No keys for:** `redpash_id`, `occurred_at`,
and every other column (all server-set at emit).

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the company membership
bundles `owner`/`admin`/`member`/`viewer`; and `<obj>-mem` — a bare
membership resolving at `own` (here, your own `user_redpash_id` trail).
View-only catalog — no write rows exist.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | <obj>-mem |
|---|---|---|---|---|---|---|
| `event.view` | all | — | — | — | — | own |
| `event.view.field.all` | all | — | — | — | — | own |

Reading it: a user views their **own** activity trail (the `own` reach
— the User-Activity feed scoped to their `user_redpash_id`); the
cross-user firehose (every event, every user — the Monitoring
Events/Requests tabs) is platform-admin only (`all`). Company roles get
**no** event grants — events aren't company-scoped (no `company_id`
column), so there's no coherent `company` slice. No write atoms exist,
so there are no write rows to grant.

---

## 3. Notes

- **No `company` reach — events lack the column.** Unlike Case/File,
  Event has no `company_id`, so "see my company's events" isn't
  expressible against the current schema. The firehose is `all`
  (platform admin) and the personal trail is `own`. If company-scoped
  observability is wanted later, it needs an `events.company_id` (or a
  join through `user_redpash_id → memberships`) — a schema change, not
  a catalog change.

- **Append-only + read-only → the catalog is view-only.** Users never
  create, update, or delete events; the only atoms are `event.view`
  family. Events are emitted fire-and-forget by the backend. This is
  the canonical append-only object (Step is the other); contrast with
  mutable objects that carry view *and* derived write atoms.

- **The FE error funnel is an ingest path, not a permission.** Anyone
  can `POST /api/events` (the funnel must work for every session), but
  the server stamps `origin='frontend'` + `user`/`session` from the
  cookie — the body can't forge identity. So there's no `event.create`
  atom: ingest is unauthenticated-but-identity-stamped, and the trust
  boundary is server-side stamping, not an RBAC grant.

- **The activity feed is `event.view@own`.** `/monitoring/users/:rid/activity`
  is one user's events ∪ request_log — gated by `event.view` at the
  `own` reach (your own `user_redpash_id`) or `all` (an admin
  investigating another user). The comment/pref/step activity surfaced
  there are all `events` rows, so they ride this one view atom — no
  per-source activity atoms.
