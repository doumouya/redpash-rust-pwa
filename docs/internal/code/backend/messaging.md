# Messaging — chat on the registry substrate

The in-app chat (channels + DMs, the global-chat POC, P1). Its point isn't the feature —
it's that **a whole collaboration surface ships with no new RBAC**: a channel is just a
scoped entity, a DM is a 2-member channel, and message-reach cascades through channel
membership. `backend/crates/api/src/messaging.rs` (+ migration
`20260618000000_messaging.sql`).

## The substrate-reuse story (why there is no per-type RBAC)

A `channel` and a `message` are **builtin registry types** (`type_definitions`, `CHN`/`MSG`,
`is_builtin`), so they inherit the entity + membership + RBAC + events spine for free:

- **A channel is a scoped entity** — *membership = who's in*. `channel.scope_parents = '[]'`:
  direct channel-membership is the gate (like a project's own membership), so a **DM stays
  private to its two users** — even a platform admin sees only the channels they belong to.
- **A message is an entity scoped to its channel** — `message.scope_parents = '["channel_id"]'`,
  so message-reach **cascades** to channel-membership. `type_cache::builtin_table` maps
  `channel→channels` / `message→messages` and the generated RBAC cascade wires the whole
  thing — `require_action` gates reads (`View`) and posts (`Edit`) with no messaging-specific
  authorization code. Denials are leak-free `404`.

**Bodies are raw Markdown TEXT.** The FE renders them through a safe `md→html` (never raw
HTML), so — exactly like `case_comments` — there is **no server-side sanitizer**. `author_id`
is a workflow ref (`ON DELETE SET NULL` on user scrub), not an access edge; reach flows
through the channel, never the author.

## Tables (`20260618000000_messaging.sql`)

| Table | Shape | Notes |
|---|---|---|
| `channels` | `redpash_id` PK → `entities` · `name` · `kind CHECK ('channel','dm')` · `created_at` | a DM carries no name of its own — the list derives it from the *other* member's `display_name` |
| `messages` | `redpash_id` PK → `entities` · `channel_id` → `channels` · `author_id` → `users` (SET NULL) · `body` (raw md) · `created_at` | `messages_channel_time_idx (channel_id, created_at)` = the polling-cursor index |
| `channel_reads` | PK `(channel_id, user_id)` · `last_read_at` | unread = messages newer than `last_read_at` |

## HTTP surface (`/api/channels`, `/api/messages`)

| Method | Path | Body / Query | Reach | Response |
|---|---|---|---|---|
| GET | `/channels` | — | membership | `{ items:[{ rid, name (DM ⇒ other member), kind, last_message, last_at, unread }] }` — the caller's channels only |
| POST | `/channels` | `{ name?, kind, member_ids[] }` | any authed | the channel; `kind:"dm"` is **GET-or-create** by member set; emits `channel_create` |
| POST | `/channels/:rid/read` | `{ at? }` (default now) | `View` | `204`-ish; upserts `channel_reads` (the unread baseline) |
| GET | `/messages` | `?channel=<rid>&after=<ISO cursor?>` | `View` on channel | `{ items }` ascending; a bad `after` ⇒ clean `400`, never a cast `500` |
| POST | `/messages` | `{ channel_id, body }` | `Edit` on channel | the message; empty body ⇒ `400`; emits `message_create` |

**Near-real-time is polling**, not push: `GET /messages?after=<cursor>` with the
`(channel_id, created_at)` index. SSE + Web Push are a later phase. The `type_fields`
catalog for both types is `readonly` so `/api/types` stays complete (a future `/objects`
browse can render the columns) — but the live surface is `/api/channels` + `/api/messages`,
not the generic object handler.

The frontend (the Messaging app, thread view, safe Markdown) is in
[`../frontend/components.md`](../frontend/components.md).
