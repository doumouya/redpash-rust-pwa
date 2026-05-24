# Agent cookbook — cases API

**Purpose.** Recipes for the team's agents (Torv, Gus, Woz, Em) to
interact with the cases system via direct HTTP. The slack channels
at `/Internal-Slack/*.md` have been the coordination spine for the
3-agent setup; this cookbook is the migration path to the Cases API
as that spine for the rest of the workstream lifecycle (phases 2-5
of the migration sequence in [proposition.md](../jira-flow-proposition/proposition.md)).

**Scope.** v1 + the local dev environment (pre-RBAC, pre-GCP). When
the app deploys to GCP and auth lands, the curl shapes below will
gain an `Authorization: Bearer …` header per request. The endpoint
paths + bodies + response shapes won't change.

**Long-term direction:** human-operator agents (Claude Code instances
collaborating with Em) will eventually call cases via an MCP server
that wraps these same HTTP endpoints. Automated agents (Cloud Run
jobs, scheduled audits, ticket triagers) will keep direct-HTTP
forever. The MCP layer is post-RBAC infrastructure; today everyone
uses curl.

---

## Setup

The local backend listens on `localhost:8080`. Set this once per
shell session:

```bash
export RP_API=http://localhost:8080/api
```

All examples below use `$RP_API` so they survive a future host
change.

**Auth (dev).** OAuth is wired in dev — every endpoint that resolves
the caller (and that's nearly all mutating endpoints) requires a
session cookie. Two ways to get one:

1. **Mint a dev session** (preferred for agents) — gated behind
   `REDPASH_DEV_LOGIN=1` env flag on the backend process:

   ```bash
   # Mint a session for the bootstrap dev user
   curl -sS -i -X POST $RP_API/auth/dev-login \
     -H 'Content-Type: application/json' \
     -d '{"user_id":"USR_FF48C3D5270B47D9B355DF4127B3FE73"}'
   # Read `set-cookie: rp_session=SES_…` from the response.
   export RP_SID=SES_…
   ```

   Substitute any other user RID (find them via `GET $RP_API/admin/users`,
   which is open today per [[redpash-stage]]). Dev sessions live for
   30 days; mint once per session.

2. **Borrow your browser session** — F12 → Application → Cookies →
   copy `rp_session` value. Faster one-off, breaks when the browser
   logout fires.

Every mutating example below adds `-H "Cookie: rp_session=$RP_SID"`.
Read-only `/admin/*` endpoints work without it today (audit
acknowledges them as dev-permissive), but mutations need it.

**Optional aliases** for the JSON header + cookie noise:

```bash
alias rp_post='curl -sS -H "Content-Type: application/json" -H "Cookie: rp_session=$RP_SID" -X POST'
alias rp_patch='curl -sS -H "Content-Type: application/json" -H "Cookie: rp_session=$RP_SID" -X PATCH'
alias rp_get='curl -sS -H "Cookie: rp_session=$RP_SID"'
alias rp_del='curl -sS -H "Cookie: rp_session=$RP_SID" -X DELETE'
```

The rest of this doc uses full curl invocations (with the cookie
header) so the examples copy-paste cleanly without depending on the
aliases.

---

## Quick reference

| Verb | Endpoint | Common use |
|---|---|---|
| Create a case | `POST $RP_API/cases` | new ticket, new workstream item |
| List cases | `GET $RP_API/cases?…` | "what's on the board", filter by status/assignee |
| Get a case | `GET $RP_API/cases/:rid` | full detail + comments + activity feed |
| Update a case | `PATCH $RP_API/cases/:rid` | status flip, reassign, edit metadata |
| Delete a case | `DELETE $RP_API/cases/:rid` | hard delete (cascades comments) |
| Post a comment | `POST $RP_API/cases/:rid/comments` | discussion + status updates |
| Edit a comment | `PATCH $RP_API/cases/:rid/comments/:cmt_rid` | typo fix; sets is_edited=true |
| Delete a comment | `DELETE $RP_API/cases/:rid/comments/:cmt_rid` | rare; cleanup only |

The full route table lives in [routes/cases.rs](../../../backend/crates/api/src/routes/cases.rs).

---

## Common verbs

### 1. Create a case

```bash
curl -sS -X POST $RP_API/cases \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{
    "title":       "Workspace slow when filtering 100k rows",
    "description": "User report — autocomplete dropdown lags ~2s.",
    "type":        "bug",
    "priority":    "high",
    "assignee_id": "USR_e7f8a9…"
  }'
```

Required: `title`. Everything else defaults server-side:
- `type` → `task` (also valid: `bug`, `feature`, `epic`)
- `status` → `backlog` (every case starts here)
- `priority` → `medium` (also valid: `low`, `high`, `critical`)
- `reporter_id` → the caller's user RID (resolved from session cookie)
- `assignee_id` / `project_id` / `company_id` → null

**Response (201 Created):**

```json
{
  "redpash_id": "CAS_a1b2c3…",
  "type":       "bug",
  "title":      "Workspace slow when filtering 100k rows",
  "status":     "backlog",
  "priority":   "high",
  "reporter_id":            "USR_torv…",
  "reporter_display_name":  "Torv",
  "assignee_id":            "USR_e7f8a9…",
  "assignee_display_name":  "Em",
  "created_at": "2026-05-25T14:32:00Z",
  "updated_at": "2026-05-25T14:32:00Z"
}
```

Stash the `redpash_id` for follow-up calls.

---

### 2. List cases (the kanban / your queue)

```bash
# Every case (kanban-board read)
curl -sS -H "Cookie: rp_session=$RP_SID" "$RP_API/cases?size=100"

# Filter: my open work
curl -sS -H "Cookie: rp_session=$RP_SID" "$RP_API/cases?assignee=USR_gus…&status=in_progress"

# Search by title/description
curl -sS -H "Cookie: rp_session=$RP_SID" "$RP_API/cases?q=autocomplete"
```

Query params (all optional):
- `status` — exact match: `backlog | todo | in_progress | in_review | done`
- `assignee` — exact match on `assignee_id`
- `project` — exact match on `project_id`
- `q` — ILIKE search across title + description
- `page` — 1-indexed (default 1)
- `size` — clamped to [1, 500] (default 50)

**Response (200):**

```json
{
  "items": [ /* Case[] — same shape as create's response */ ],
  "total": 17,
  "page":  1,
  "size":  50
}
```

Sorted by `updated_at` DESC server-side. Most-recently-touched cases
surface first.

---

### 3. Get a case (full detail)

```bash
curl -sS -H "Cookie: rp_session=$RP_SID" "$RP_API/cases/CAS_a1b2c3…"
```

**Response (200, `CaseDetail`):**

```json
{
  "case":     { /* the Case row */ },
  "comments": [ /* Comment[] ordered by created_at ASC */ ],
  "activity": [
    {
      "redpash_id":  "EVT_…",
      "occurred_at": "2026-05-25T14:32:00Z",
      "kind":        "case_create",
      "message":     "created case CAS_a1b2c3…: Workspace slow…",
      "user_redpash_id": "USR_torv…",
      "context":     { "case": "CAS_a1b2c3…", "type": "bug", … }
    },
    {
      "kind":    "case_status_change",
      "message": "case CAS_a1b2c3…: status backlog -> todo",
      "context": { "case": "…", "field": "status", "old": "backlog", "new": "todo" }
    }
    // …
  ]
}
```

The activity feed reads through the audit-everything spine — every
case mutation emits a `case_*` event, the feed query is
`SELECT * FROM events WHERE context->>'case' = $1 ORDER BY occurred_at ASC`
([db.rs::list_activity_for_case](../../../backend/crates/api/src/db.rs)).
No separate history table.

---

### 4. Advance status (the most common operation)

The kanban click-cycle: each click PATCHes the next status. Use this
when "Gus says step 3 is done" → flip the case from `in_progress` to
`in_review`.

```bash
curl -sS -X PATCH "$RP_API/cases/CAS_a1b2c3…" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "status": "in_progress" }'
```

Valid transitions: any-to-any. The click-cycle convention on the
kanban wraps `done` → `backlog`, but the backend doesn't enforce
that — you can jump directly to `done` or reopen via `done` →
`todo`. Each transition emits a `case_status_change` event.

**Response (200):** the updated `Case` row.

---

### 5. Reassign / change priority / change type

Same PATCH shape, different fields. All optional + sparse — only
fields you include get updated.

```bash
# Reassign
curl -sS -X PATCH "$RP_API/cases/CAS_…" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "assignee_id": "USR_woz…" }'

# Bump priority
curl -sS -X PATCH "$RP_API/cases/CAS_…" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "priority": "critical" }'

# Refile as a bug instead of a task
curl -sS -X PATCH "$RP_API/cases/CAS_…" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "type": "bug" }'

# Multi-field (each becomes a discrete activity-feed entry)
curl -sS -X PATCH "$RP_API/cases/CAS_…" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "status": "in_review", "assignee_id": "USR_em…" }'
```

Each changed field emits its own `case_<field>_change` event so the
activity feed renders one row per change ("status: todo →
in_progress", "assignee: Torv → Em"). Title / description / project
/ company edits get bundled into a single `case_metadata_change`
event to keep the feed signal-heavy.

**Enum validation** happens before the DB write — invalid
status/priority/type values come back as a clean 400 with kind
`invalid`, not a 500 from the Postgres CHECK constraint.

---

### 6. Add a comment

Comments are the discussion thread on a case — distinct from the
audit-trail events. Use them for context, decisions, hand-off
notes.

```bash
curl -sS -X POST "$RP_API/cases/CAS_a1b2c3…/comments" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "body": "Looked at the picker debounce — 200ms is fine, the slowness is in the predicate render." }'
```

`body` is markdown. Emits a `case_comment_post` event.

**Response (201, `Comment`):**

```json
{
  "redpash_id": "CMT_…",
  "case_id":    "CAS_a1b2c3…",
  "author_id":  "USR_gus…",
  "body":       "Looked at the picker debounce…",
  "is_edited":  false,
  "created_at": "2026-05-25T14:42:00Z",
  "updated_at": "2026-05-25T14:42:00Z"
}
```

Edit + delete:

```bash
curl -sS -X PATCH "$RP_API/cases/CAS_…/comments/CMT_…" \
  -H 'Content-Type: application/json' \
  -H "Cookie: rp_session=$RP_SID" \
  -d '{ "body": "Updated body" }'

curl -sS -X DELETE "$RP_API/cases/CAS_…/comments/CMT_…" \
  -H "Cookie: rp_session=$RP_SID"
```

Edits set `is_edited = true` (UI shows an "(edited)" indicator).

---

### 7. Delete a case

```bash
curl -sS -X DELETE "$RP_API/cases/CAS_…" \
  -H "Cookie: rp_session=$RP_SID"
```

204 on success. Comments cascade-delete (per the FK shape in
[migration 028](../../../backend/migrations/20260610000001_cases.sql)).
The case's audit-trail events stay in the `events` table — the
`case_delete` event records that the deletion happened, with the
operator's user_rid and the deleted case's rid in context.

Use sparingly. Most "this isn't relevant anymore" cases should move
to `done` instead so the audit trail stays readable.

---

## slack → cases migration table

How today's `/Internal-Slack/*.md` patterns map to API calls:

| Slack pattern (today) | Cases API (tomorrow) |
|---|---|
| `cat >> Internal-Slack/Torv.md` with a task assignment | `POST /api/cases` with `assignee_id` set to Torv's USR_… |
| "Slice E backend shipped at f2b3d72" in slack | `PATCH /api/cases/:rid` with `status=in_review` + `POST /api/cases/:rid/comments` with the commit ref |
| "Em greenlit" in slack | `PATCH /api/cases/:rid` with `status=todo` (move out of backlog) |
| "Standing by" in slack | implicit — no API call needed |
| Slack `### 2026-05-25 — Em → Gus` headers | the case's activity feed (one event per mutation, time-ordered) |

Phase 2 of the migration sequence (cases optional, slack primary)
means: keep posting to slack for ephemeral chatter, but mirror task
assignments + status flips to cases. Phase 3 flips primary; phase 4
retires slack for task tracking entirely.

---

## Tips + pitfalls

- **RID format is `CAS_<32 hex>` / `CMT_<32 hex>`.** Same shape as
  `USR_` / `PRJ_` / `FIL_` etc. The 32-char hex part is a UUID
  without dashes — case-sensitive but the API doesn't validate
  casing.

- **`jq` is your friend for pulling the rid out of a create
  response:**

  ```bash
  RID=$(curl -sS -X POST $RP_API/cases \
    -H 'Content-Type: application/json' \
    -H "Cookie: rp_session=$RP_SID" \
    -d '{ "title": "fix the thing" }' | jq -r '.redpash_id')
  echo "Created $RID"
  ```

- **All timestamps are RFC3339 UTC** (`2026-05-25T14:32:00Z`).
  Postgres `TIMESTAMPTZ` serializes to that shape.

- **Use the activity feed instead of polling the case row.** When
  you need to know "what changed since I last looked", read
  `case.activity` from the `GET /:rid` response — it's authoritative
  per-event vs the current-state-only case row.

- **PATCH is sparse — empty body is a no-op, not a 400.**
  `{}` returns the case unchanged.

- **Unassign / clear-field is not wired yet.** Setting `assignee_id`
  to `null` or `""` in a PATCH body is a no-op (`COALESCE` keeps the
  existing value). Backend gap flagged on Torv's channel; will land
  when the FE unassign affordance is built.

- **Errors come as `{ "error": "...", "kind": "..." }`** with the
  HTTP status code on the response. Common kinds: `invalid` (enum
  validation), `not_found` (rid doesn't exist), `db` (Postgres
  failure — chain visible in stdout JSON logs via the airlock).

- **Every mutation emits an event.** Don't repeat yourself in
  comments — the status flip is already in the activity feed; the
  comment should add context (the WHY) the event row can't carry.

---

## When this cookbook stops being load-bearing

When MCP server lands (post-RBAC, slice-G+ infra item) human-operator
agents stop calling curl directly — they invoke
`track_case_create / track_case_status / list_cases / add_comment`
as MCP tools. The cookbook becomes the spec the MCP server's tool
descriptions inherit. Automated agents (Cloud Run jobs, customer-
ticket triagers) keep using direct HTTP because they're not Claude
Code instances and don't speak MCP.

Until then: curl + this doc. Both halves of the team start the
slack → cases migration with the same surface.
