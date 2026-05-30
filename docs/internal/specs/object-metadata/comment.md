---
title: Comment — object metadata
section: Internal
order: 47
last modified date: 2026-05-30
owner: Torv
status: draft — per the object-metadata sweep ([index](index.md))
---

# Comment (CMT_)

One reply on a Case. Comments are the agent-to-agent + agent-to-
human conversation surface — the replacement for cross-channel
slack pings now that Cases is live (per the MCP-Cases bridge work,
2026-05-28). Body is Markdown (rendered as plain text in v1; the
parser is v2 polish). Threaded replies + attachments are v2/v3.

**Backing table:** `comments` (migration `20260610000001_cases.sql`,
landed alongside the `cases` table).
**DTO:** `backend/crates/shared/src/case.rs`
(`Comment` + `CommentRequest`).
**Routes:** `backend/crates/api/src/routes/cases.rs` — comments are
mounted under the case path (`/api/cases/:rid/comments`) rather than
a top-level `/api/comments` resource. Every comment is scoped to
exactly one case; no standalone-comment surface exists.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/cases/:rid/comments` | Body: `CommentRequest { body }`. Server assigns `CMT_<32hex>`; `author_id` always resolved from the session (never client-settable); `case_id` from the path. Returns the created `Comment` with `author_display_name` hydrated. Emits `case_comment_post`. |
| `read (single)` | — | **Not supported.** Comments are surfaced only as the `comments[]` array on `CaseDetail` (the GET /api/cases/:rid response). No `/api/cases/:rid/comments/:cmt_rid` GET. |
| `read (thread)` | `GET /api/cases/:rid` | The case's full comment thread comes back on the `comments[]` array of `CaseDetail`, ASC by created_at (oldest first — matches the github / slack convention). |
| `update` | `PATCH /api/cases/:rid/comments/:cmt_rid` | Body: `CommentRequest { body }`. Only the comment's own author can edit (server-side gate). Bumps `updated_at` + flips `is_edited = true`. Returns the updated comment. Emits `case_comment_edit`. |
| `delete` | `DELETE /api/cases/:rid/comments/:cmt_rid` | Hard delete. Author-only (server-side gate, mirroring update). Emits `case_comment_delete`. |
| `list` | — | **Not as a standalone call.** The thread is the `comments[]` array on the parent case's detail response. |
| `search` | — | **Not supported.** No `q=` over comment bodies. Activity-feed search on the Case detail page filters by activity-event kind, not by free-text over comment text. |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format CMT_<32 uppercase hex>
  Properties:  (none — internal)
  Description: Primary key. Server-assigned via id::new("CMT").
               Surfaced on the Comment DTO but not on any direct
               LIST_VIEWS layout (comments aren't a top-level
               rail target).
```

```
case_id
  Type:        TEXT NOT NULL / String — FK to cases.redpash_id
  Properties:  (none — internal)
  Description: Owning case. NOT a Create-property — the case rid
               comes from the path on POST /api/cases/:rid/comments.
               ON DELETE CASCADE: deleting a case drops its
               comment thread (the audit history survives via
               events.context.comment + events.context.case
               references, which don't enforce FK).
```

```
author_id
  Type:        TEXT / Option<String> — FK to users.redpash_id
  Properties:  Nillable
  Description: Who wrote the comment. NOT a Create-property —
               always set server-side to the session user; NOT
               an Update-property. Nullable only because the
               column FK is ON DELETE SET NULL: a deleted user's
               comments outlive them (the case + thread
               survive — "<deleted user> wrote: …"). Same rule
               as Case.reporter_id / Case.assignee_id.
```

```
body
  Type:        TEXT NOT NULL / String
  Properties:  Create, Update
  Description: Comment text. Markdown source — rendered as plain
               text in v1; the markdown parser ships in v2 polish
               (per `docs/internal/subsystems/cases.md` open
               lanes). Required on Create. No length cap today.
```

```
is_edited
  Type:        BOOLEAN NOT NULL DEFAULT FALSE / bool
  Properties:  (none — internal flag)
  Description: UI indicator surfaced as the "edited" pill next to
               the timestamp. NOT a Create-property; NOT a
               directly-Update-property — flipped server-side to
               true on every PATCH (could be derived from
               created_at != updated_at, but the explicit flag
               avoids floating-point timestamp comparisons in the
               read path).
```

```
created_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  (none — internal)
  Description: Auto-set on INSERT. Comment thread orders by this
               ASC (oldest first). Never client-settable.
```

```
updated_at
  Type:        TIMESTAMPTZ NOT NULL DEFAULT now() / chrono::DateTime<Utc>
  Properties:  (none — internal)
  Description: Auto-bumped on every PATCH by the route handler.
               Together with `is_edited` drives the "edited X ago"
               affordance on the thread render.
```

### Hydrated read-only fields

```
author_display_name
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: users.display_name JOINed on author_id. NULL when
               the author is null (deleted user). The FE thread
               render (.rp-cases-comment-author) reads
               `display_name || rid || "—"` so the user sees a
               readable name instead of `USR_abc123…`.
```

---

## Enum constraints

None. Comment has no enum columns — body is free-text, is_edited is
a boolean. All variation lives in the body content + the timestamps.

The conversational pattern (markdown bodies, threaded replies in
v2/v3, attachments) is documented in
`docs/internal/subsystems/cases.md` (subsystem doc) — not surfaced
as enum constraints because there are none on the row.

---

## Relationships

```
case_id → Case (CAS_)
  Cardinality:  N:1 (a Case has many Comments)
  On delete:    CASCADE (deleting a case drops its comment thread)
  Hydrated as:  — (the comment surfaces on the case's CaseDetail,
                not the other way around)
```

```
author_id → User (USR_)
  Cardinality:  N:1
  On delete:    SET NULL (comment outlives the deleted author;
                same rule as Case.reporter_id / Case.assignee_id)
  Hydrated as:  author_display_name
```

### Inverse relationships

```
Comment is referenced by activity-feed Events
  Backing:       events.context.comment (JSONB, soft ref)
  Cardinality:   N:N (each case_comment_* event references one
                 comment + one case in its context)
  On delete:     No FK; events survive a comment delete for audit
  Surfaced as:   the activity[] array on CaseDetail — see [event](event.md).
```

---

## Audit events

| `kind` | Emitted on | Context shape |
|---|---|---|
| `case_comment_post` | `POST /api/cases/:rid/comments` | `{ case, comment }` |
| `case_comment_edit` | `PATCH /api/cases/:rid/comments/:cmt_rid` | `{ case, comment }` |
| `case_comment_delete` | `DELETE /api/cases/:rid/comments/:cmt_rid` | `{ case, comment }` |

All three kinds carry both the `case` rid AND the `comment` rid in
their context — the case rid drives the activity-feed scoping
(`context->>'case' = $1`) while the
comment rid lets the feed link directly to the comment if it's
still alive (404'd into a tombstone if the comment was deleted —
the events outlive the row).

The split between `case_comment_post` / `_edit` / `_delete`
(distinct kinds) and the per-field bundling on Case
(`case_metadata_change`) is deliberate: comment lifecycle is
high-signal — every reply matters to the thread — so the per-action
events stay discrete. Case metadata changes are bundled because
title / description / project edits are quieter signals worth
collapsing.
