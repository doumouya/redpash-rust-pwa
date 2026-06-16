# Monitoring — the in-app audit trail

The Admin **Monitoring** page surfaces the audit suite's runs + findings (the same `tools/*-audit/` suite
behind the ci-audit ratchet), so audit health is observable in-app, not only in CI logs. Read-only,
**platform-admin only**. Ported + adapted from prerelease's audit trail.

## Layers
- **Schema** — the `audit` Postgres schema ([20260617000001_audit_monitoring.sql](backend/migrations/20260617000001_audit_monitoring.sql)).
- **Ingest** — the `redpash-audit-ingest` bin writes runs + findings ([audit_ingest.rs](backend/crates/api/src/bin/audit_ingest.rs)).
- **API** — four read endpoints ([monitoring.rs](backend/crates/api/src/monitoring.rs)); catalog in [api-routes.md](api-routes.md).
- **Rail** — the `monitoring` view = two Sections (`runs` · `findings`) ([rail.rs](backend/crates/api/src/rail.rs)).
- **FE** — `frontend/apps/admin/monitoring` (M1).

## The `audit` schema
A SYSTEM schema — rows are NOT registry entities (no `register_entity`, no RBAC cascade); it is platform-ops
data, gated at the handler instead. See [schema.md](schema.md) for the registry it
deliberately sits outside of.

- **`audit.run`** — one row per audit invocation: `(id, tool, ran_at, git_sha, git_branch, stats jsonb,
  payload jsonb, UNIQUE(tool, git_sha, ran_at))`. `payload` is the whole `audit.json` (the source of truth);
  `stats` is the human summary (`{}` or `{count}` when a tool emits none). **No `tool` CHECK** — lean's
  ~28-tool suite grows without a migration; the ingest's discovery loop validates the name instead (the
  closed-enum trap, avoided).
- **`audit.finding`** — the exploded projection: `(run_id FK ON DELETE CASCADE, tool, kind, finding_key,
  severity, detail jsonb, PK(run_id, finding_key))`. Exploded at ingest so the diff is a plain self-join.
- **`audit.run_diff(cur, prev)`** — classifies each finding by `(kind, finding_key)` presence + severity
  delta → `new | fixed | regressed | improved | unchanged`. Ported verbatim; the regression view (M3) reads it.

## Ingest — `redpash-audit-ingest`
A standalone bin, DECOUPLED from the file ratchet (`tools/ci.sh` needs no DB) — run it where a DB exists
(`--tool <name>` reads `tools/<tool>-audit/audit.json`; `--file` overrides the path; `--all` walks every
`tools/*-audit/audit.json`). Captures git sha/branch via `git rev-parse`; one transaction per tool
(INSERT run RETURNING id → `explode` → INSERT findings `ON CONFLICT DO NOTHING`); prints a `run_diff`
summary vs the previous run for that tool.

`explode` handles two finding shapes per item, **preferring the item's own fields** so distinct findings
never collide:
- **contract** — the item already carries `{kind, finding_key, severity}` (e.g. ui-snapshot / api-doc /
  fe-framework): used verbatim.
- **uniform** — `{file, line, rule, msg}` (e.g. rail-create): synthesizes `kind = rule`,
  `finding_key = rule|file:line`, `severity = NULL`.

**Known gap (count-only):** a tool that nests findings under a BESPOKE key (auth-audit `leaks`/`auditGaps`,
css-audit `selectorConflicts`) has no top-level/`findings` array, so it ingests as a run with zero findings
until a per-tool key adapter — or an audit-side normalizer that makes every tool emit the contract shape —
lands. The run + `stats` still record it (trend-able); the findings list just won't show those rows.

## API — `/api/monitoring/*`
Every handler opens with the leak-free admin gate (`require_admin` → `404`, never `403`; see
[rbac.md](rbac.md)). Ad-hoc `{items, total, page, size}` envelope (lean has no
shared `Page<T>`); `size` clamps 1–200; `offset` is computed in `i64` (no `u32` overflow).
- `GET /audit-runs?page&size&tool&q` — runs, newest first (`ORDER BY ran_at DESC, id DESC` — a total order,
  so pages can't repeat/skip on `ran_at` ties). Optional exact-`tool` + free-text `q` (tool/branch/sha).
- `GET /audit-runs/stats` — `{ total, by_tool:{tool→count}, last_7d }`.
- `GET /audit-findings?page&size&run&tool&kind&q` — findings; with no `run` it defaults to the MOST-RECENT
  run (optionally per `tool`) so the first load is one coherent set, and echoes the resolved `run`.
- `GET /audit-findings/stats?run&tool` — `{ total, by_severity, by_kind, run }`. `resolve_run` is SHARED
  with the list so the KPI strip scopes to the SAME run it annotates. `by_severity` buckets
  `low ≤5 / med ≤15 / high`, with NULL→`low` (lean findings carry no severity yet).
- *(M3)* `GET /audit-runs/:id/diff?prev=` → `audit.run_diff` rows (not built yet).

## Verification / lifecycle
Pre-ingest the page shows an empty-state. `cd backend && cargo test -p api` covers the admin gate, the
generic `explode`, and a DATABASE_URL-gated `run_diff` + query-shape test
([tests/monitoring.rs](backend/crates/api/tests/monitoring.rs)). End-to-end: run `redpash-audit-ingest`
against a DB, then the four endpoints populate and the page renders the runs/findings tables + KPI strips.
