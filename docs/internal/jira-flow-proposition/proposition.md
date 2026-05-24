# Cases workstream — issue tracking + agent + customer coordination

**Status:** workstream spec (v1 scope locked 2026-05-25 by Em).
**Lane:** product-management / customer-support foundation.
**Sequencing:** after slice E of audit-everything (Torv's current
queue). Em's framing: *"agent slack works when we are just 3, but
in real production scenario we need the workflow for managing
customer tickets already tested, so we have to start the switch."*

The strategic call: **migrate the team's coordination from
`/Internal-Slack/*.md` files to a Cases system NOW**, so the
workflow is battle-tested by the time the first customer files a
bug report.

---

## Why now

Today's team (Em + Torv + Gus + Woz) coordinates via per-agent
markdown channels. The /Internal-Slack/ shape works for 3 agents +
1 director — fast iteration, low overhead. It doesn't survive:

- **A 4th agent joining** — slack channels are flat append-only
  logs without queryable structure. "What's Gus working on?"
  becomes a manual scan.
- **Multi-session work** — today's conversation is lost when the
  process exits. A workstream that spans a week needs persistent
  state, not session memory.
- **Customer tickets** — when a user lands on the "report a bug"
  form, the report needs to enter a real triage queue with
  assignment, status, comments, and an audit trail. Building
  that path the day customers arrive is too late.

Cases is the same forcing function as cat-3 audit-trail and the
type-shape lane: pre-market is when we crystallize the discipline,
so the foundation is locked when load arrives.

---

## v1 scope (ship first)

| Item | v1 | Reason |
|---|---|---|
| `cases` table | ✓ | minimum viable ticketing |
| `comments` table | ✓ | distinct lifecycle from cases + history |
| `events` extended with `case_*` kinds | ✓ | reuse audit-trail, don't build a parallel log |
| Kanban board UI | ✓ | the actual consumer (backlog → todo → in_progress → in_review → done) |
| Case detail page | ✓ | comments thread + history feed + assignment |
| Agent migration from /Internal-Slack/ to Cases | ✓ | eat the dogfood |
| `sprints` table | ✗ (v2) | meaningful when ≥2 humans + a velocity history |
| `story_points` | ✗ (v2) | needs velocity to be useful; noise on every form today |
| Customer-facing reporter path | ✗ (v3) | requires anonymous-reporter flow + RBAC visibility |

---

## Schema

### `cases`

```
column            type        nullable  default        constraints                                description
─────────────────────────────────────────────────────────────────────────────────────────────────────────────
id                uuid        NO        gen_random()   PK
redpash_id        text        NO        —              UNIQUE                                     Format CAS_<32 hex> — matches existing RID convention
type              text        NO        'task'         CHECK (bug|feature|task|epic)              Differentiates work
title             text        NO        —              —                                          Short ticket title
description       text        YES       —              —                                          Full description (markdown)
status            text        NO        'backlog'      CHECK (backlog|todo|in_progress|in_review|done)   Agile-canonical states
priority          text        NO        'medium'       CHECK (low|medium|high|critical)           `critical` reserved for outages
reporter_id       text        YES       —              FK → users.redpash_id ON DELETE SET NULL   Who filed it (null when user is deleted; preserves ticket)
assignee_id       text        YES       —              FK → users.redpash_id ON DELETE SET NULL   Who's working on it
project_id        text        YES       —              FK → projects.redpash_id ON DELETE SET NULL    Optional project context
company_id        text        YES       —              FK → companies.redpash_id ON DELETE SET NULL   Optional company context
created_at        timestamptz NO        now()          —
updated_at        timestamptz NO        now()          —

INDEX cases_status_idx     ON (status, updated_at DESC)
INDEX cases_assignee_idx   ON (assignee_id, status) WHERE assignee_id IS NOT NULL
INDEX cases_project_idx    ON (project_id, updated_at DESC) WHERE project_id IS NOT NULL
```

**Key choices** (vs the original proposition):

- **RID format `CAS_<32 hex>`** — matches `USR_`, `PRJ_`, `FIL_`,
  `CHT_`, `CMP_`, `EVT_`, `req_`. No Crockford-with-checksum
  divergence. `id::new("CAS")` slots into the existing convention.
- **All FKs `ON DELETE SET NULL`, not CASCADE** — preserves the
  ticket when a user/project/company is deleted. The audit trail
  outlives the actors.
- **No `story_points` column** — v2 add.
- **No `sprint_id` column** — v2 add.

### `comments`

```
column         type        nullable  default        constraints                                description
──────────────────────────────────────────────────────────────────────────────────────────────────────────
id             uuid        NO        gen_random()   PK
redpash_id     text        NO        —              UNIQUE                                     Format CMT_<32 hex>
case_id        text        NO        —              FK → cases.redpash_id ON DELETE CASCADE    Comments die with the case
author_id      text        YES       —              FK → users.redpash_id ON DELETE SET NULL   Null when author is deleted; preserves the comment
body           text        NO        —              —                                          Markdown
is_edited      boolean     NO        false          —                                          UI indicator
created_at     timestamptz NO        now()          —
updated_at     timestamptz NO        now()          —

INDEX comments_case_idx ON (case_id, created_at ASC)
```

Comments cascade-delete with the case (unlike users) because
they're meaningless without their parent ticket.

### History → REUSE `events` table

**Do not build a `case_history` table.** The audit-everything
workstream already shipped 36 `event::record` call sites with the
correlation backbone (request_id, user_redpash_id, session_id,
context JSONB). Case lifecycle changes ARE audit-trail events:

```rust
// Status flip
event::record(&pool, EventDraft {
    origin:  "backend",
    level:   "info",
    kind:    "case_status_change".into(),
    message: format!("case {rid}: {old} -> {new}"),
    user:    Some(actor_rid),
    context: serde_json::json!({
        "case":  rid,
        "field": "status",
        "old":   old,
        "new":   new,
    }),
    ..Default::default()
});

// Assignee change
kind: "case_assignee_change"   context: { case, field: "assignee_id", old, new }

// Priority change
kind: "case_priority_change"   context: { case, field: "priority", old, new }

// Comment posted
kind: "case_comment_post"      context: { case, comment }

// Comment edited
kind: "case_comment_edit"      context: { case, comment }
```

**Why this is the right move:**

1. **One audit log to query**, not two. The Monitoring page's
   investigation console (slice E, `4d22cda`) already drills
   request_id → events. Case events join that drill-down naturally.
2. **Cases inherit the request_id correlation for free.** A case
   created during a request carries the same `request_id` as the
   request_log row + the http_error event + any sqlx queries in
   the JSON log stream. The whole story stitches via `jq '.span.request_id'`.
3. **One discipline lane.** The cat-3 audit-trail audit catches
   case mutations that skip `event::record` mechanically — same
   regression net we just built.
4. **One redactor.** The `redact` module (slice E) handles any
   user-supplied content that lands in events.context. Comments
   pass through the same gate.

The case detail page's "Activity" tab is a query: `SELECT * FROM
events WHERE context->>'case' = $1 ORDER BY occurred_at ASC`. The
GIN index on events.context (already in place) makes it fast.

---

## API surface (v1)

```
GET    /api/cases?status=&assignee=&project=&q=&page=&size=
POST   /api/cases                                     create
GET    /api/cases/:rid                                detail (case + comments + activity feed)
PATCH  /api/cases/:rid                                sparse update (status, priority, assignee, etc.)
DELETE /api/cases/:rid                                soft-delete? Decision: hard-delete v1, soft-delete v2
POST   /api/cases/:rid/comments                       new comment
PATCH  /api/cases/:rid/comments/:cmt_rid              edit comment
DELETE /api/cases/:rid/comments/:cmt_rid              delete comment
```

Every mutation handler emits the corresponding `case_*` event
per the cat-3 discipline. AppError airlock applies — eyre::Report
chain to Channel A on 5xx, sanitized message to wire + events
table per the redact module.

---

## Agent migration from /Internal-Slack/

This is the strategic part — the agents (Torv, Gus, Woz) move
their coordination from per-agent markdown channels to the Cases
API. The slack channels stay for ephemeral in-flight chatter; the
**Cases API becomes the persistent workstream tracker.**

### What the agents do

```
Today                              v1 Cases
─────────────────────────────────────────────────────────────────────
"Slice E backend shipped at        POST /api/cases/:rid status=in_review
4d22cda" → posted in Torv.md       comment="Backend at 4d22cda; FE handoff"
                                   assignee_id=USR_TORV

Em assigns Torv to FE work →       POST /api/cases   type=task
text in slack channel              title="Slice E FE: investigation console"
                                   assignee=USR_TORV

Torv finishes M-1 modal →          PATCH /api/cases/:rid status=in_review
git commit + slack ping            comment="M-1 modal shipped at <commit>"

Em reviews + greenlights →         PATCH /api/cases/:rid status=done
```

### What this requires

- **A `track(case, ...)` helper in each agent's tooling** — when
  the slack `cat >> Torv.md` shape we use today becomes
  `track('case_status_change', { case: 'CAS_...', new: 'done' })`.
- **A queryable "what's on my plate" view** — `GET /api/cases?assignee=USR_GUS&status=todo,in_progress`.
  Each agent reads this at session start.
- **Em's PM dashboard** — kanban board view of every active case,
  filterable by assignee / project / status. Powers the
  director-perspective overview the slack channels don't give.

### The migration sequence

| Phase | Slack | Cases | Trigger |
|---|---|---|---|
| 1 | primary | not built | today (pre-v1) |
| 2 | primary | built but optional | v1 ships; agents experiment |
| 3 | secondary | primary | Em flips when the UI is ergonomic |
| 4 | retired (for tasks) | exclusive | Cases is the source of truth |
| 5 | retired (entirely) | + customer-facing path | v3 — customers file tickets |

Slack stays useful through phase 4 for ephemeral chatter ("checking
ping", "his fix landed at f31facc"). Phase 5 is when customers
land and the same Cases system handles their reports.

---

## v2 — sprints + story points

Adds when the team grows past 1 human director. Both columns are
purely additive to v1; no v1 schema gets reshaped to support them.

```
sprints (NEW)
─────────────
redpash_id     text        UNIQUE          Format SPR_<32 hex>
name           text
goal           text        nullable        Optional overarching sprint goal
status         text        CHECK (planned|active|completed)
start_date     timestamptz nullable
end_date       timestamptz nullable
created_at     timestamptz now()
updated_at     timestamptz now()

cases (ALTER)
─────────────
sprint_id      text        FK → sprints.redpash_id ON DELETE SET NULL
story_points   integer     CHECK (story_points >= 0)
```

**Sprint scope is global, not per-project** — today's work spans
projects in the data sense (observability-audit touches
`backend/` + `frontend/` + `tools/`). A sprint groups work
across the codebase, not within a single project.

**Rollover handling** falls out of the events table for free:
when a sprint goes `completed`, the application updates
`cases.sprint_id` to the next sprint and emits
`kind="case_sprint_change"` for each rolled-over case. The
events row is the audit; no separate rollover table needed.

---

## v3 — customer-facing reporter path

Adds when the first external user files a ticket. Requires:

- **Anonymous reporter flow** — `reporter_id` becomes optional
  (already nullable in v1) + a `reporter_email TEXT NULL` column
  for un-logged-in submissions
- **Visibility / access control** — RBAC integration. Customers
  see only their own tickets; internal staff sees all. Today
  `assignee_id`/`reporter_id` are the only owner hints; RBAC
  layer overlays company + role gates.
- **`is_public` flag** — separates customer-facing tickets from
  internal coordination (which migrated from slack)
- **Customer notification path** — email on status change. Wire
  to a queue (deferred infra slice).

V3 is post-RBAC. V1 + V2 ship before then.

---

## Integration with the audit-everything lane

This workstream is the next layer on top of audit-everything, not
parallel to it.

| Audit-everything provides | Cases consumes |
|---|---|
| `events` table with kind + actor + context | `case_*` event kinds |
| request_id correlation through spans | Cases created during a request inherit it |
| `AppError` airlock + redact module | Case CRUD errors get the same Channel-A treatment |
| Monitoring page as investigation console | Case detail page is a sibling view |
| cat-3 audit-trail audit (mechanical regression net) | Every case mutation handler scanned |

The cat-3 audit gains five new expected `event::record` sites
(one per `case_*` kind). The audit-everything lane's regression
net naturally extends to cover the new mutations — no new tool
needed.

---

## First milestones (recommended order)

1. **Migration 028** — `cases` + `comments` tables, indexes, FKs.
2. **`shared::case::*` DTOs** — Case, Comment, CaseDetail (case
   + comments + activity-feed events).
3. **`routes::cases`** — CRUD handlers. Every mutation emits the
   corresponding `case_*` event via the existing `event::record`
   path. AppError airlock applies (5xx through eyre::Report).
4. **`routes::cases::comments`** — sub-router for comment CRUD.
5. **observability-audit catalog extensions** — surfaces for the
   new endpoints + `case_*` event-kind coverage (live counters,
   same pattern as the existing event::record surface).
6. **`/cases` page** — kanban board (5 columns matching status
   enum), card-style rows, drag-drop status flips, per-card
   click-through to detail page.
7. **`/cases/:rid` detail page** — title, description, metadata
   sidebar (assignee, priority, project, company), tabbed
   comments thread + activity feed (events query).
8. **Agent migration tooling** — each agent gets a small
   helper module (`agent.case_track(...)`) that wraps the API
   calls. Slack stays for chatter; cases for state.

Milestones 1–5 are backend (Gus). 6–7 are frontend (Torv). 8 is
shared (each agent integrates into their workflow tooling).

---

## Open questions

1. **`status` flow strictness** — should `done` be terminal
   (no reopen), or allow `done → todo` (reopen)? Lean: allow,
   with an `event` row for the reopen.
2. **Comment threading** — flat list v1; threaded replies v2 if
   the volume justifies it.
3. **Labels / tags** — useful for cross-cutting categorization
   ("frontend", "backend", "tech-debt"). Defer to v2; add as a
   `labels TEXT[]` column or a separate `case_labels` table when
   the query pattern emerges.
4. **Attachments** — defer to v3 alongside customer-facing path.
5. **Notifications** — defer to v3.

---

## Why this is the right time

Em's framing: *"in real production scenario we need the workflow
for managing customer tickets already tested, so we have to start
the switch."*

The discipline lanes we've built this session (auth-audit cat-1,
cat-3 audit-trail, type-shape correctness, observability surfaces)
all share the same shape: **build the regression net before the
load arrives.** Cases extends that to coordination + customer
support. By the time the first customer ticket lands, the workflow
has been battle-tested by the team for weeks or months. No "ah,
we should have built ticket triage" emergencies.

The slack-to-cases migration is the dogfooding. We move our own
coordination to the system we're going to ask customers to use.
Eat what we cook.
