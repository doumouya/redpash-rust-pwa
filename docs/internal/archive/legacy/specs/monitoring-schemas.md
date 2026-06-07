---
title: Monitoring + step schemas
section: Internal
last modified date: 2026-05-30
---

# Monitoring & step schemas — what each surface reads from

> **Internal — RedPash team only.** Five tables back the `/monitoring`
> page and the Home `Steps` tab. For each: the live Postgres schema,
> the wire DTOs surfaced by `/api/monitoring/*` + `/api/admin/steps`,
> the write sites that fill it, and the read sites that surface it.
> Snapshot taken 2026-05-23 against the dev DB; the live `\d` output
> matches the migrations cited per table.
>
> Ordering follows the `/monitoring` rail: Events · Requests · Audit
> Runs · Audit Findings · then `project_steps` (lives under Home /
> Steps, included by request).

## TL;DR — surface ↔ table

| Surface | Endpoint | Backing table | Wire DTO |
|---|---|---|---|
| Monitoring → **Events** | `GET /api/monitoring/events` | `public.events` | `shared::monitoring::EventSummary` |
| Monitoring → **Requests** (drill-down) | `GET /api/monitoring/requests` | `public.request_log` | `shared::monitoring::RequestSummary` |
| Monitoring → **Requests** (stats donut + top-routes) | `GET /api/monitoring/requests/stats` · `GET /api/metrics` | `public.request_log` (aggregations) | `shared::monitoring::RequestsStats` / inline in `routes::metrics` |
| Monitoring → **Audit runs** | `GET /api/monitoring/audit-runs` | `audit.run` | `shared::monitoring::AuditRunSummary` |
| Monitoring → **Audit findings** | `GET /api/monitoring/audit-findings` | `audit.finding` | `shared::monitoring::AuditFindingSummary` |
| Home → **Steps** | `GET /api/admin/steps` | `public.project_steps` | `shared::admin::StepSummary` |

All list endpoints return `shared::Page<T>` (`rows + total + all_count + page + size + pages + ms + row_indices`).

## 1. `events` — runtime observability log

**Migration:** `backend/migrations/20260529000000_init.sql`. RID prefix `EVT_`.

**Live schema:**

```
Column          | Type                     | Nullable | Default
----------------|--------------------------|----------|------------------
redpash_id      | text                     | NOT NULL | (PK)
occurred_at     | timestamptz              | NOT NULL | now()
origin          | text                     | NOT NULL | 'backend'   CHECK origin IN ('backend','frontend')
level           | text                     | NOT NULL | 'info'      CHECK level IN ('debug','info','warn','error')
kind            | text                     | NOT NULL |             — machine type: http_error | auth_login | step_apply | …
message         | text                     | NOT NULL |
source          | text                     |          |             — emitting site: routes::files::upload | cleaner.js
user_redpash_id | text  FK→users           |          |             — ON DELETE SET NULL
session_id      | text                     |          |             — rp_session RID
request_id      | text                     |          |             — correlates one request's events front + back
http_method     | text                     |          |
http_path       | text                     |          |
http_status     | integer                  |          |
duration_ms     | integer                  |          |
context         | jsonb                    | NOT NULL | '{}'        — free-form structured payload
```

**Indexes:** `(occurred_at DESC)`, `(level, occurred_at DESC)`, `(kind, occurred_at DESC)`, `(user_redpash_id, occurred_at DESC)`, `(request_id)`.

**Wire DTO** — `shared::event::Event` (full record, per-rid view) and `shared::monitoring::EventSummary` (slim list projection — omits `context`, `source`, `user_redpash_id`, `session_id`, `http_method`, `http_path`, `duration_ms`).

**Write sites:**

| Path | Trigger |
|---|---|
| `routes::capture_mw` | After every `/api/*` request that returns 4xx/5xx. Resolves user from session, classifies kind as `http_error`. Fire-and-forget. |
| `event::record(…)` | Direct backend lifecycle calls — e.g. auth flows, step engine failures, scheduled jobs. Used wherever a handler wants to record something distinct from an HTTP error. |
| `POST /api/events` | Frontend-reported events (`origin` forced to `'frontend'`). Identity stamped server-side from `rp_session`, never trusted from the body. |

**Read sites:**

| Path | Use |
|---|---|
| `GET /api/events` | Flat list (legacy / direct), filter by `?level=` `?kind=` `?limit=` |
| `GET /api/events/:rid` | Per-event detail (full record incl. `context`) |
| `GET /api/monitoring/events` | Paginated `Page<EventSummary>` for the Monitoring → Events tab |

## 2. `request_log` — per-request performance capture

**Migration:** `backend/migrations/20260529000000_init.sql`. No RID — id is a `BIGSERIAL`; a metrics row is not an addressable entity.

**Live schema:**

```
Column      | Type        | Nullable | Default
------------|-------------|----------|--------------
id          | bigint      | NOT NULL | nextval(seq)  (PK)
at          | timestamptz | NOT NULL | now()
method      | text        | NOT NULL |
route       | text        | NOT NULL |               — normalized: RIDs collapse to ':id'; stored post-`/api`-strip
status      | smallint    | NOT NULL |
duration_ms | integer     | NOT NULL |
request_id  | text        |          |               — correlates to the matching events row
user_redpash_id | text    |          |               — who made the request (powers the per-user feed); nullable when unauthenticated
session_id  | text        |          |               — rp_session RID at request time
```

**Indexes:** `(at DESC)`, `(route, at DESC)`, `(user_redpash_id, at DESC) WHERE user_redpash_id IS NOT NULL`, `(session_id, at DESC) WHERE session_id IS NOT NULL`.

**Route normalization:** `request_log::normalize_route(path)` collapses RedPash-ID segments (`<2-4 uppercase letters>_<32 hex>`) to `:id` so `/files/FIL_…/page` aggregates as one route. Stored values are *post-`/api`-strip* because `capture_mw` layers on the nested router — `/api/projects` lands as `/projects`. This is why monitoring filters use `route NOT LIKE '/monitoring%'` for self-observation exclusion.

**Wire DTO** — `shared::monitoring::RequestSummary` (1:1 row mirror), plus aggregations: `shared::monitoring::RequestsStats { window, total, status_mix, top_routes }` and `shared::monitoring::RouteStat`.

**Write sites:**

| Path | Trigger |
|---|---|
| `routes::capture_mw` → `request_log::record(…)` | Every `/api/*` request, after the handler runs. Fire-and-forget (`tokio::spawn` — measuring the app must never slow or fail the app). |

**Read sites:**

| Path | Use |
|---|---|
| `GET /api/metrics?window=` | Overall + per-route KPIs (count, error rate, p50/p95/p99) for the existing Requests tab top-strip |
| `GET /api/monitoring/requests` | Paginated drill-down redtable below the KPI strip |
| `GET /api/monitoring/requests/stats?window=` | Status-mix donut + p95-ranked top-10 routes |

## 3. `audit.run` — one row per audit-script execution

**Migration:** `backend/migrations/20260529000000_init.sql`. Lives in the `audit` schema (separate namespace — these are dev-tooling metadata, not app data).

**Live schema:**

```
Column     | Type        | Nullable | Default
-----------|-------------|----------|--------------
id         | bigint      | NOT NULL | nextval(seq)  (PK)
tool       | text        | NOT NULL |               CHECK tool IN ('css','html','parallel','tab-compare','cross-page','ui-snapshot')
ran_at     | timestamptz | NOT NULL | now()
git_sha    | text        |          |               — captured by the ingest binary
git_branch | text        |          |
stats      | jsonb       | NOT NULL |               — headline numbers (shape per tool)
payload    | jsonb       | NOT NULL |               — the FULL `data` object the audit-bro emitted
```

**Indexes:** `(tool, ran_at DESC)`, unique on `(tool, git_sha, ran_at)` (cheap dedupe guard — `git_sha` NULLs are distinct in Postgres so this never blocks a run).

**Wire DTO** — `shared::monitoring::AuditRunSummary` (omits `payload`; the full object stays in the DB as the source of truth, available for re-render).

**Write sites:**

| Path | Trigger |
|---|---|
| `redpash-audit-ingest` binary (`backend/crates/api/src/bin/audit_ingest.rs`) | Standalone CLI invoked after every `node tools/<tool>-audit/audit.js`. Reads `audit.json`, captures git context, inserts run + explodes findings in one TX. |
| `sh tools/audit.sh` | Wrapper that runs every audit + ingests (for css + html) in one command. |

**Read sites:**

| Path | Use |
|---|---|
| `GET /api/monitoring/audit-runs?page&size&tool` | Paginated `Page<AuditRunSummary>` for the Audit runs tab |
| `audit.run_diff(cur_id, prev_id)` SQL function | "Since last run" change-tracking — see §4 |

## 4. `audit.finding` — exploded per-finding projection

**Migration:** `backend/migrations/20260529000000_init.sql` (same).

**Live schema:**

```
Column      | Type    | Nullable | Default
------------|---------|----------|----------
run_id      | bigint  | NOT NULL |          FK→audit.run(id) ON DELETE CASCADE
tool        | text    | NOT NULL |
kind        | text    | NOT NULL |          — selector_conflict | class_divergence | component_candidate
finding_key | text    | NOT NULL |          — STABLE identity across runs
severity    | integer |          |          — conflictCount | divergentCount | saved (per kind)
detail      | jsonb   | NOT NULL |
```

**Primary key:** `(run_id, finding_key)`. **Index:** `(tool, kind, finding_key)`.

`finding_key` is the stable cross-run identity that powers the diff queries:

| Tool · kind | `finding_key` |
|---|---|
| css · `selector_conflict` | `atContext + ' ||| ' + selector` |
| css · `class_divergence` | the class name (`.cls`) — only when `divergentCount > 0` |
| html · `component_candidate` | `name + '/' + tier` (e.g. `modal-overlay/slotted`) |

`payload` (in `audit.run`) is the source of truth; `audit.finding` is a derived projection re-runnable from payload. See `tools/audit-storage-brainstorming.md` for the design rationale.

**Wire DTO** — `shared::monitoring::AuditFindingSummary` (omits `detail`).

**Write sites:**

| Path | Trigger |
|---|---|
| `redpash-audit-ingest` binary | Same TX as the `audit.run` insert — walks `payload` per-tool and inserts one finding row per element. |

**Read sites:**

| Path | Use |
|---|---|
| `GET /api/monitoring/audit-findings?run=<id>` | Paginated `Page<AuditFindingSummary>`. Defaults to most-recent run when `?run=` is omitted. |
| `audit.run_diff(cur_id, prev_id)` | Joins findings across two runs by `(kind, finding_key)` and classifies each as `new | fixed | regressed | improved | unchanged`. See migration `20260529000000_init.sql`. |

**Function signature:**

```sql
audit.run_diff(cur_id BIGINT, prev_id BIGINT) RETURNS TABLE (
    status         TEXT,        -- new | fixed | regressed | improved | unchanged
    kind           TEXT,
    finding_key    TEXT,
    severity_cur   INTEGER,
    severity_prev  INTEGER
)
```

## 5. `project_steps` — one row per cleaning operation applied to a file

**Migration:** `backend/migrations/20260529000000_init.sql`. RID prefix `STP_`.

**Live schema:**

```
Column          | Type        | Nullable | Default
----------------|-------------|----------|--------------
redpash_id      | text        | NOT NULL |              (PK)
file_redpash_id | text        | NOT NULL |              FK→project_files(redpash_id) ON DELETE CASCADE
ordinal         | integer     | NOT NULL |              — position in the file's step history
kind            | text        | NOT NULL |              — step type (see kinds list below)
params          | jsonb       | NOT NULL | '{}'         — op-specific arguments
applied         | boolean     | NOT NULL | true         — false on undo; true on redo
created_at      | timestamptz | NOT NULL | now()
```

**Index:** `(file_redpash_id, ordinal)`. **Trigger:** `project_steps_bump_file` (`AFTER INSERT/UPDATE/DELETE FOR EACH ROW`) calls `bump_file_mtime_from_step()` to bubble `updated_at` up to the parent `project_files` row.

**Kinds dispatched by `data::steps::apply`** (full palette as of 2026-05-23):

| Kind | What it does | `params` shape |
|---|---|---|
| `drop_columns` | Remove columns by name | `{ columns: ["a","b"] }` |
| `filter_columns` | Keep only listed columns | `{ keep: [...] }` |
| `drop_rows` | Remove rows by index | `{ indices: [0,2,5] }` |
| `filter_rows` | Apply a row predicate | `{ combinator: "and"|"or", predicates: [{column, op, value?, case_sensitive?}, …] }` — op set: see §6 |
| `unwrap_csv` | Re-parse a single-column wrapped CSV | (no params) |
| `drop_nulls` | Drop rows with null in named columns | `{ columns: ["x"] }` |
| `set_cell` | Edit one cell | `{ row: 7, column: "name", value: "Alice" }` |
| `fill_nulls` | Fill null cells | `{ columns: [...], strategy: "value"|"forward", value? }` |
| `cast` | Change a column's dtype | `{ column: "x", to: "int"|"float"|"date"|"bool"|"string" }` |
| `rename_column` | Rename one column | `{ from: "old", to: "new" }` |
| `snake_case_columns` | snake_case every column header | (no params) |
| `replace_in_names` | Find/replace in column names | `{ find: "...", replace: "..." }` |
| `change_case` | Lower/upper a column's string values | `{ column: "x", case: "lower"|"upper" }` |
| `replace_text` | Find/replace in a column's values | `{ column: "x", find: "...", replace: "..." }` |
| `fix_invalid` | Coerce parse-failing cells to NULL on a typed cast | `{ column: "x", as: "int"|"float"|"date" }` |
| `join_columns` | Concatenate columns into a new one | `{ from: ["a","b"], sep: " ", to: "full_name" }` |
| `split_column` | Split one column into many | `{ column: "x", sep: ",", to: ["a","b"] }` |

`filter_rows` predicate op set (subset of `shared::filter::FilterOp`): `eq | neq | in | not_in | contains | not_contains | starts_with | ends_with | gt | gte | lt | lte | between | before | after | is_null | not_null`. The full `FilterOp` enum is the canonical 17-variant union — see `backend/crates/shared/src/filter.rs`.

**Wire DTOs:**

| DTO | Shape | Where |
|---|---|---|
| `shared::step::ProjectStep` | Full record incl. `params` JSONB | `GET /api/files/:rid/steps`, per-file step timeline |
| `shared::step::StepRequest` | `{ kind, params }` — body of `POST /api/files/:rid/steps` | Frontend cleaning-tool actions |
| `shared::admin::StepSummary` | Slim list projection (omits `params`, adds joined `file_filename`) | `GET /api/admin/steps` (Home → Steps tab) |

**Write sites:**

| Path | Trigger |
|---|---|
| `POST /api/files/:rid/steps` | Frontend cleaning-tool actions (the 12 buttons via `defineTool`); cell edits + row deletes from the workspace redtable. |
| `POST /api/files/:rid/undo` · `/redo` | Flips `applied` on the most-recent applied row (and replays). |

**Read sites:**

| Path | Use |
|---|---|
| `GET /api/files/:rid/steps` | Per-file step timeline |
| `GET /api/admin/steps?page&size&file&kind&applied` | Org-wide list for Home → Steps tab |
| `GET /api/admin/steps/stats` | `{ total, by_kind, last_24h }` for the Steps-tab KPI strip |

## 6. Cross-cutting — filter DTO

The `filter_rows` step (above) and the query-time filter (`/api/files/:rid/page?filters=…`) both consume `shared::filter::FilterNode` / `FilterSpec`. Canonical op list:

```
eq, neq, in, not_in,
contains, not_contains, starts_with, ends_with,
gt, gte, lt, lte, between,
before, after,
is_null, not_null
```

`FilterSpec.case_sensitive` is honored on both engine paths (defaults: `true` on the persisted-step path, `false` on the query-time path — deliberate asymmetry per `5908689`).

## 7. Self-observation filter

Every `/api/monitoring/*` and `/api/metrics` query that scans `request_log` excludes its own traffic via `WHERE route NOT LIKE '/monitoring%'` (and `'/metrics'` for metrics). The act of viewing the dashboard doesn't pollute its own data — convention matches `/api/metrics`.

## 8. User preferences — `user_preferences` table (and the client/server split)

User prefs live in
two places that don't sync today:

- **Client** — `localStorage` (one key per pref) + a `data-<attr>`
  reflection on `<html>` so CSS can react without any JS read at
  paint time.
- **Server** — the dedicated `user_preferences` table (one row per
  `(user_redpash_id, key)`, `value` JSONB). There is **no
  `users.prefs` column** — it was split out into this table (mig 023)
  and the legacy JSONB column was dropped (mig 024). Readers fold the
  rows back into a single `prefs` JSONB via a
  `jsonb_object_agg(key, value)` subquery; writes upsert per key.

The two are intentionally separate — every UI-visible pref ships
through localStorage today; the server table was provisioned but
the sync wiring hasn't landed. The comment in
`frontend/scripts/prefs.js` calls the path out:

> *When a user-prefs backend endpoint lands, the localStorage layer
> becomes an SWR cache and these helpers swap to hit
> `/api/users/:rid/prefs` underneath; the consumer-facing API
> doesn't change.*

### Client — the canonical PREFS table

`frontend/scripts/prefs.js` exports the closed list:

| Name | localStorage key | Values | Default | `<html>` data attr |
|---|---|---|---|---|
| `density` | `rp-density` | `compact \| cozy \| comfortable` | `cozy` | `data-density` |
| `fontSize` | `rp-font-size` | `sm \| md \| lg` | `md` | `data-fontSize` |
| `rowsPerPage` | `rp-rows-per-page` | `10 \| 25 \| 50 \| 100 \| all` | `25` | — (read by JS only) |
| `showRowNumbers` | `rp-show-rownum` | `1 \| 0` | `1` | `data-showRownum` |
| `showStageDots` | `rp-show-stage-dots` | `1 \| 0` | `1` | `data-showStageDots` |

Plus **theme** (`rp-theme`) which lives in `frontend/scripts/theme.js`
with its own boot wiring — not in the PREFS table because it
predates the consolidation.

`getPref(name)` returns the default if storage is empty, the value
isn't in the allowed list, or storage is unavailable. `setPref` is
the only write path; CSS-reflected prefs update `<html>` synchronously.

### Server — the `user_preferences` table

```
Column          | Type        | Nullable | Default
----------------|-------------|----------|--------------
user_redpash_id | text        | NOT NULL |              FK→users(redpash_id) ON DELETE CASCADE
key             | text        | NOT NULL |
value           | jsonb       | NOT NULL |
updated_at      | timestamptz | NOT NULL | now()
```

**Primary key:** `(user_redpash_id, key)`. **Index:**
`(user_redpash_id)`. Readers reassemble the per-user prefs object with
`COALESCE((SELECT jsonb_object_agg(p.key, p.value) FROM user_preferences
p WHERE p.user_redpash_id = users.redpash_id), '{}'::jsonb) AS prefs`.

**Known keys** that the backend actually reads or writes today (not
the same as the client's PREFS list — these are server-side
behavioral toggles, not UI prefs):

| Key | Type | Used by | What it controls |
|---|---|---|---|
| `learned_sentinels` | `string[]` | `GET /api/me` (merges with default `prefs::SENTINELS` for the Cleaner's Fix-invalid modal) | User-added junk-value sentinels |
| `share_sentinels` | `bool` | `PATCH /api/me` (gated mirror to `sentinel_submissions` when true) | Opt-in to share learned sentinels org-wide |

There is no schema check on what `key`s appear in `user_preferences` —
the table is intentionally permissive. The current path is:

1. `PATCH /api/me/prefs` upserts one row per key:
   `INSERT … SELECT $1, kv.key, kv.value, now() FROM jsonb_each($2)
   … ON CONFLICT (user_redpash_id, key) DO UPDATE`. Only keys present
   in the patch are written; unmentioned keys stay.
2. The shared DTO `shared::user::PrefsPatch` is just
   `{ prefs: serde_json::Value }` — fully free-form.
3. Anything the *client* sets (density / fontSize / etc.) is NOT
   currently propagated to `user_preferences` — those stay in
   localStorage only.

### Wire DTOs

| DTO | Shape | Where |
|---|---|---|
| `shared::user::UserProfile.prefs` | `serde_json::Value` (full record) | `GET /api/me`, `GET /api/users/:rid` |
| `shared::user::PrefsPatch` | `{ prefs: serde_json::Value }` | body of `PATCH /api/me/prefs` (the dedicated prefs write path; the `prefs` field on `PATCH /api/me` is deprecated and forwarded to the same `patch_user_prefs`) |

### Write sites

| Path | Trigger |
|---|---|
| `PATCH /api/me/prefs` → `patch_user_prefs(…)` | Upserts one `user_preferences` row per key (`ON CONFLICT (user_redpash_id, key) DO UPDATE`). Sole real write path today. |
| `PATCH /api/me` (`body.prefs`) | **Deprecated.** Forwarded to `patch_user_prefs` with a tracing warning; kept only for legacy callers. |

### Read sites

| Path | Use |
|---|---|
| `GET /api/me` | Returns the full `prefs` JSONB (reassembled via `jsonb_object_agg`) to the signed-in user; the response *augments* `learned_sentinels` with the canonical defaults from `prefs::SENTINELS` so the UI doesn't have to merge. |
| `GET /api/users/:rid` | Admin view of any user's profile incl. prefs. Same shape as `/api/me` minus the augmentation. |
| (none for `/api/admin/users`) | The Home → Users redtable's `UserSummary` deliberately omits `prefs` — admin list views don't need the JSONB. |

### The gap — what's NOT wired yet

- **No client→server sync.** Settings page changes update
  localStorage + the `<html>` data attr; the server's
  `user_preferences` table is untouched by any client UI today.
- **No prefs change history.** No table tracks who changed what,
  when. If we ever want "revert to 7-days-ago prefs" or audit-style
  visibility, that's an additional table or events-table entries
  (the events table can take it — kind would be `pref_change` or
  similar — but no one writes such events today).

This is the picture an upcoming prefs feature would need to either
keep, formalize, or close.
