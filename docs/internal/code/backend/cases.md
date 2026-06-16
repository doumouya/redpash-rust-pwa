# Cases — the agent-handoff surface + the workflow-as-DATA engine

`/api/cases` is the dedicated case surface the generic registry can't carry. `case`
is a real registry entity (type `case`, browsable + deletable via `/objects/case`),
but it stays **`registry_read_only`** there — create, comment, status-advance, and
attachments live ONLY here. This is the contract the MCP client
(`tools/mcp-server/dist/cases.js`) already speaks and the kanban + detail UI consume.

The keystone is the **workflow engine: workflows-as-DATA**, a pure transition map
keyed by `cases.source` (no DB, no rows). A status PATCH **enforces** `to ∈
transitions[from]` → else `422 invalid_transition`; the `cases.status` CHECK is the
DB backstop. The MCP surfaces the 422 body to the agent, so a rejected
`setCaseStatus` skip propagates for free.

**Source:** [`backend/crates/api/src/cases.rs`](../../../../backend/crates/api/src/cases.rs)
(routes + workflow + handlers),
[`backend/crates/api/src/pipeline.rs`](../../../../backend/crates/api/src/pipeline.rs)
(the sealed attachment write path).

> The route catalog rows for these 10 endpoints live in the `/api/cases[/:rid]` section of
> [`api-routes.md`](api-routes.md); this doc is the model + workflow-engine detail behind them.

---

## The case as a registry entity

`case` is registered like any object: `create` calls
[`db::register_entity(.., "case")`](../../../../backend/crates/api/src/cases.rs#L217)
+ [`db::grant_owner`](../../../../backend/crates/api/src/cases.rs#L236), so the
creator owns it and RBAC/audit/reach apply uniformly. Its display fields are seeded
in [`type_fields`](../../../../backend/migrations/20260616000000_case_type_fields.sql)
— every `field` is a REAL `cases` column (read-only `string`), so `/objects/case`
renders through the generic `builtin_list`. The `type`/`status`/`source`/`priority`
`options` arrays record the CHECK vocabularies for downstream UIs (the kanban); they
are inert for the read-only registry view.

`priority` (`low|medium|high|critical`, default `medium`) and the `case_attachments`
table were added in
[`20260617000000_case_priority_attachments.sql`](../../../../backend/migrations/20260617000000_case_priority_attachments.sql);
the enum matches the MCP `case_create` contract (the planning doc's "urgent" was a
divergence).

---

## The workflow engine — workflows-as-DATA, keyed by `source`

The whole engine is one [`mod workflow`](../../../../backend/crates/api/src/cases.rs#L51):
a `source → transition map` lookup, five pure functions (`initial`, `states`,
`transitions`, `is_valid`, `is_known_state`), no DB. A new workflow is a new const
table + one `match` arm — disposable at near-zero cost.

**INTERNAL (live)** — five states `backlog → todo → in_progress → in_review → done`,
matching the `cases.status` CHECK and the MCP enum exactly. Transitions are
**permissive**: forward + one-step-back + reopen-from-done
([`INTERNAL`](../../../../backend/crates/api/src/cases.rs#L58)). A kanban drag
routinely moves a card back a column, so forbidding that would 422 a recoverable
mis-click; only illegal **skips** (e.g. `backlog → done`) are rejected. (Em toggle:
strict forward-only is a one-line edit to this table.)

**EXTERNAL (dormant)** — DESIGNED but **unreachable**
([`EXTERNAL`](../../../../backend/crates/api/src/cases.rs#L71)):
`New → Assess → Research → Solution Provided → {Closed | Research}`. It is dormant by
construction — the `cases.status` CHECK does **not** permit these states, and no path
creates `source='external'` cases (`create` hard-codes `source = "internal"`,
[L213](../../../../backend/crates/api/src/cases.rs#L213)). Lighting it up needs a
CHECK-widening migration + an external-create path; that is a later slice, not wired
today.

`is_valid(source, from, to)` ([L103](../../../../backend/crates/api/src/cases.rs#L103)):
same-state is an idempotent no-op (a kanban re-drop onto the same column); otherwise
`to` must be listed in `transitions[from]`. An unknown `source` defaults to INTERNAL.

---

## The endpoints

[`routes()`](../../../../backend/crates/api/src/cases.rs#L38), nested at `/cases`
([`main.rs`](../../../../backend/crates/api/src/main.rs#L34)). Note the **static
`/workflows` is declared before the `:rid` matcher** so `/cases/workflows` never
resolves as a case lookup — do not fold it in.

| Method + path | RBAC | Notes |
|---|---|---|
| `GET /cases` | reach-scoped | reach-filtered list, `status`/`assignee`/`project`/`q` filters + paging |
| `POST /cases` | Member+ on each scope_parent | create internal case |
| `GET /cases/workflows` | any authed caller | the two workflow defs (defs aren't secret) |
| `GET /cases/:rid` | `View` | CaseDetail = row + comments + activity + attachments |
| `PATCH /cases/:rid` | `Edit` | THE workflow engine — status transition |
| `POST /cases/:rid/comments` | `Edit` | append a comment |
| `GET /cases/:rid/attachments` | `View` | metadata list |
| `POST /cases/:rid/attachments` | `Edit` | multipart upload |
| `GET /cases/:rid/attachments/:att` | `View` | raw download |
| `DELETE /cases/:rid/attachments/:att` | `Edit` | remove row + blob |

**`GET /cases` — reach-scoped list** ([`list`](../../../../backend/crates/api/src/cases.rs#L267)).
A platform admin sees everything (`viewer = None`, no reach filter); otherwise the
viewer's principals drive [`CASE_REACH`](../../../../backend/crates/api/src/objects.rs#L432)
— membership on the case **OR** either declared scope_parent (`company_id` /
`project_id`). `CASE_REACH` is a trusted const (safe to interpolate); the four
filters bind as `NULL ⇒ no filter`, `q` is an `ILIKE` over `title + description`.
Returns the MCP/kanban contract `{ items, total, page, size }` (size clamped 1..500).

**`POST /cases` — create** ([`create`](../../../../backend/crates/api/src/cases.rs#L170)).
Validates `type ∈ {bug,feature,task,epic}` and `priority ∈ {low,medium,high,critical}`.
The **IDOR guard** (mirroring `objects.rs builtin_create`): each supplied scope_parent
(`company_id` / `project_id`) must be reachable at `>= Member` via
[`require_rule`](../../../../backend/crates/api/src/cases.rs#L196) — else any authed
user could graft a case under a foreign company/project and hand its admins cascade
write. `assignee_id` must exist (a clean 400, not a raw FK 500). Status = the workflow
`initial`; reporter = caller; creator owns it. Returns `201` with the case row.

**`PATCH /cases/:rid` — the transition** ([`patch`](../../../../backend/crates/api/src/cases.rs#L418)).
`Edit` reach. Because `require_action` returns `Ok` immediately for a platform admin
(no existence check), a missing rid is re-checked here via `fetch_optional` → clean
404. Then: `is_known_state` (else `422 invalid_status`) → `is_valid` (else `422
invalid_transition`) → `UPDATE` + a `case_status` activity event recording `from → to`.

**`POST /cases/:rid/comments`** ([`add_comment`](../../../../backend/crates/api/src/cases.rs#L367)).
`Edit` reach. **Security contract**: the comment `body` is stored as **RAW PLAIN
TEXT** — there is no server-side HTML sanitizer, so the FE renderer MUST escape it
(`textContent`, never `innerHTML`). The init-migration's "sanitized HTML" column
comment is an aspirational note predating this surface; this is the authoritative
contract.

**`GET /cases/:rid`** ([`get_one`](../../../../backend/crates/api/src/cases.rs#L320))
assembles the row + comments + the **activity feed** (every `events` row tagged
`context->>'case' = rid`, via the `events_case_idx`) + attachments metadata. Every
mutating handler emits a `case` event so this feed stays queryable. `fetch_case`
strips the legacy `attachments` jsonb (real attachments come from `case_attachments`).

---

## Attachments — metadata-only in Postgres, bytes on disk

The privacy posture of the connectors/file pipeline applied to case files: **no
customer bytes ever sit in Postgres**. The
[`case_attachments`](../../../../backend/migrations/20260617000000_case_priority_attachments.sql#L17)
table holds METADATA only — `filename`, `mime`, `size_bytes`, `storage_path` — and
**there is no bytes/content column**, so the invariant holds by construction. The raw
bytes live at `storage_path` (`attachments/<ATT_rid>.bin`) on the server disk: the
durable share + recovery source, exactly as CSVs. Em's note: the client caches a
**GlueSQL working copy** for fast/offline view; the server `.bin` is the source of
truth.

**Not a registered entity.** Unlike a file, an attachment is not independently
shareable, so it is NOT an `entity` — its RBAC **derives from the parent case**
(`View` → read, `Edit` → add/remove), the same way `project_steps` aren't entities.
`ON DELETE CASCADE` from `cases` cleans the rows when a case is deleted.

**The sealed write path.** Upload routes through
[`pipeline::upload_attachment`](../../../../backend/crates/api/src/pipeline.rs#L309)
— the case analogue of `upload_csv` but with **no parse/summarize/score**: write the
`.bin`, then `insert_attachment` the metadata row, guarded by a `BlobGuard` so a
failed insert doesn't orphan the blob. `insert_attachment` is **private** (the seal,
mirroring `insert_file`) — there is no public `db::insert_attachment`. The handler
gates RBAC (`Edit` on the case) before calling; the pipeline just seals the write.
256 MiB cap is the router-wide `DefaultBodyLimit`
([`main.rs`](../../../../backend/crates/api/src/main.rs#L52)); any MIME accepted.

**The per-attachment IDOR guard.** Every attachment-by-id query is keyed `WHERE
redpash_id = $att AND case_id = $rid`
([download](../../../../backend/crates/api/src/cases.rs#L564),
[delete](../../../../backend/crates/api/src/cases.rs#L596)), so an attachment id from a
different case 404s — a caller with `View` on case A can't fetch case B's blob by
guessing its `ATT_` id.

**Download hardening** ([`download_attachment`](../../../../backend/crates/api/src/cases.rs#L557)):
served with the STORED mime, a forced `attachment` disposition, and `X-Content-Type-Options:
nosniff`, so an uploaded `.html` can never render inline (stored-XSS guard). The
filename is sanitized for the header (strip `" \ CR LF`) — no header injection from a
crafted upload name. **Delete** removes the row, then best-effort removes the blob; the
row is the source of truth, so an orphan `.bin` is harmless (a future BlobGuard sweep
can reap it).

---

## See also

- [`api-routes.md`](api-routes.md) — the rest of the `/api` HTTP surface + the
  leak-free-404 RBAC model these handlers follow.
- [`connectors.md`](connectors.md) — the same "server is a conduit, not a store"
  posture for external-DB ingest.
