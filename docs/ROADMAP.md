# RedPash rebuild-from-scratch roadmap

## Context

RedPash (repo: `/home/mansa/rust-project/redpash-rust-pwa`, WSL) is a data-quality PWA for the
"Operational Analyst" — Excel-skilled, no Python/SQL. The promise: **Upload → instant quality
report → Clean (plain language, never silently auto-fixed) → Visualise (shareable charts)**, with
multi-file joins as the differentiator and an Africa-first / data-sovereign GTM bet. Two strategic
bets shape everything: **(1) one engine, two surfaces** — a pure-compute Rust+Polars `data` crate
that runs natively on the server AND compiles to wasm32 to run *client-side in the browser* (raw
data never has to leave the device); **(2) framework, not product** — entity registry +
polymorphic memberships + TypeDefinition store + open registries make the vertical disposable
(a CRM ships by changing type definitions, proven by `typedef-acceptance.html`).

This plan is the answer to "if you had to rebuild it from scratch, how?" — an executable, phased
roadmap. The honest headline: **this is a port-and-fix, not a redesign.** The architecture's
load-bearing ideas survived a 7-lens deep read; what a rebuild buys is (a) skipping the migration
debt that the current tree carries (three RBAC gate generations, dual CSS namespaces, fork-A/B
redtable, god-object pages, half-wired registries), and (b) baking in the ~20 "CHANGE" items every
lens independently flagged.

**Port-verbatim list** (mature, tested, the moat): the `data` crate's locale heuristics
(FR-first date/number/sentinel/mojibake handling), `connectors_core` SSRF/TLS gate (12 tested
bypass encodings), the error airlock + request-id + fire-and-forget observability spine, the
auth module (~335 lines, boring and correct), `build-wasm.sh` content-hash pipeline, the
cleanness score shape (value-blend × structural gate), the step-replay model, leak-free-404,
prefs SWR, the SW-caches-only-hashed-wasm strategy, the audit-suite concept.

---

## Phase 0 — Decisions locked before code (the day-one list)

These are the things the current codebase shows are 10× costlier to retrofit:

1. **RID prefixes unique per type** — no `FIL_` shared by file+dashboard (today's
   ordinal-resolution trap). Dashboard gets `DSH_`.
2. **Register `users` and `files` in the entity registry from day one** — "share one file with
   one person" is on the roadmap and is inexpressible today because files aren't entities.
3. **`entity_data.scope_parent_id` gets a real FK** to `entities(id)` (the IDOR guard covers
   create only; the DB must refuse dangling parents).
4. **One canonical FilterNode DTO** consumed by `page()`, steps, group_by pre-filter, AND the
   wasm wrapper — the flat-vs-tree split is the only reason filter/search can't run client-side.
5. **One RBAC gate generation**: `require_action` (tier + contract) is the only handler-facing
   gate, in a typed axum extractor. No `ensure_owner` sibling, ever.
6. **Cascade arms are data** — scope-parent declared as a column on `type_definitions`,
   GRANT_SQL and EDGES_SQL generated from that one declaration (today: three hand-synced copies).
7. **Content-hash discipline for ALL static assets** (JS/CSS like the wasm today) — kills the
   stale-JS-in-Chrome dev pain permanently.
8. **Time-partition `events`/`request_log`/`db_query_log` at schema birth** (the acknowledged
   deferral; free now, painful later).
9. **Workflow identity never string-keys on `context_role`** — case reporter/assignee are
   registry rel fields; `context_role` stays purely cosmetic (the docs already claim this; the
   shipped code violates it).
10. **dev-login gated by compile profile**, not env var; Secure cookies + CSRF answer decided
    now with a single flip point.

Scaffolding: 3-crate workspace (`api`/`data`/`shared`) + `frontend/` + `tools/`; CI from day
one = `cargo check --target wasm32-unknown-unknown -p data` (mechanical purity gate for the
"zero IO in data crate" rule), `cargo test`, the audit-harness shell, `test-fe.sh`.

## Phase 1 — Data spine (Postgres + identity)

*Goal: a designed schema (not a pg_dump baseline) carrying every locked decision.*

- **Migration 1 (designed init)**: `entities(id,type,created_at)` registry, FK'd-into by every
  subtype PK ON DELETE CASCADE; `memberships(object,member,role,context_role)` wide-PK
  polymorphic edge; `type_definitions`/`type_fields`/`type_scope_roles` (+ `scope_parent_field`
  column per #6); `entity_data` JSONB with FK'd scope_parent_id; `project_files` (File-is-a-File:
  csv/chart/dashboard discriminated by `file_type`, spec JSONB, lineage `source_file_id`);
  append-only `project_steps` (kind text + params JSONB + `applied` bool); `users`/`sessions`;
  `cases` (people as memberships from the start); versioned append-only `company_rbac`;
  partitioned observability tables. Derived-never-stored: `file_stages` view → `project.stage`.
- **Auth**: port Google OAuth + opaque `rp_session` (upsert by `sub`, userinfo-over-JWT, no
  refresh tokens) verbatim; add the first-admin claim flow (replaces `REDPASH_BOOTSTRAP_ADMINS`);
  session→user in-memory TTL cache (kills 2 queries/request).
- **Gate to exit phase**: migrations run from empty; `sqlx` non-macro layer compiles without a
  live DB.

## Phase 2 — RBAC core

*Goal: the one-edge model with a single gate, machine-verified.*

- One recursive resolver (principals closure + data-driven cascade_scopes + max-rank split by
  direct/scope reach); platform-admin-bypass-first ordering; leak-free 404 everywhere; the
  404/403 split only where reach is already proven (members manage, field gate).
- `require_action(caller, object, Action)` = tier floor (View→Viewer, Create/Edit→Member,
  Delete→Admin) ∩ company Contract (team-PK → object-TYPE → CRUD), contract-absent ⇒ tier-only.
  **Wired from the first route** — no three-generation accretion.
- Field axis: perm_class matrices → derived per-role cells ⊕ sparse `field_permissions`
  overrides, served as TypeDefinitions; client caches via `type-registry.js` (add server-push or
  ETag revalidation so a second tab can't serve stale permissions).
- Router-layer middleware for whole admin nests; reach-scoped `all_count`; list providers
  registry.
- **Gate to exit phase**: a seeded **non-admin RBAC matrix integration suite** (the thing the
  current repo never had — its only cross-tenant tests are 4 `#[ignore]` live-DB tests). Include
  the scope_parent IDOR regression class and the dev_user fake-green trap lesson (always seed
  real non-admin users).

## Phase 3 — Data engine (`data` crate port)

*Goal: the moat, ported with its known bugs fixed.*

- Port: encoding sniff (chardetng + BOM) — **fix the dead TLD-hint bug** (`encoding.rs:28`
  always evaluates to None); newline normalization; two-pass delimiter/preamble sniff;
  wrapped-CSV diagnose-don't-fix (`RescueDiag` + explicit `unwrap_csv` step); the 18-kind step
  engine + replay; locale coercion (last-separator-decimal, day-first + 2-digit-year-first,
  EN+FR bools); **one unified sentinel vocabulary** (today `stats::SENTINELS` and
  `dtype::SENTINEL_TOKENS` drift); two-tier cleanness score (blend × structural gate) +
  raw-bytes suspicion pass; overlap-coefficient join detector (top-N-by-frequency);
  polars-SQL substrate with the read-only allowlist inside the crate.
- Performance: replace per-cell `AnyValue::get` + String loops with typed columnar iterators
  (the documented hot path at the 500k cap).
- wasm: budget the polars fork upfront (`polars-rp` ~110 lines, runbook 0023's lessons — smoke-run
  every export incl. a lazy-collect in a node host); JSON-in/out boundary for v1 with the
  Arrow-IPC/columnar escape hatch planned; **generate the JS `ENGINE_METHODS` from the
  wasm-bindgen output** (today 7 of 13 exports are unreachable dead weight); content-hash
  pipeline verbatim. Multi-sheet Excel: import each sheet as a file (or at minimum warn).
- Decide `render`: move doc-rendering out of the data crate (it's a stub with 4 declared deps
  today) — keep the crate's pure-compute story clean.
- **Gate to exit phase**: wasm-bench harness reproduces ≤~1.2s 500k-row worker sort; in-browser
  parse+score on the demo corpus matches server output byte-for-byte.

## Phase 4 — API crate

*Goal: same shape, fixed memory model, sealed write path.*

- axum + tower stack as today; error airlock (rich eyre chain server-side, `{error,kind}` wire),
  request-id span + `X-Request-Id`, fire-and-forget events/request_log — port verbatim.
- **`pipeline::upload_csv` sealed by module visibility** — make it the only function that *can*
  reach `insert_file`, so the Kafka-loader bypass class (CAS_A4448B94) is impossible by
  construction, not by audit.
- **Streaming memory model** (the biggest behavioral change): multipart → disk (don't buffer
  256 MiB), loader extracts → temp file (not a String), streamed exports, LRU/size-budgeted
  frame cache with per-rid single-flight hydration (kills the duplicate-parse race and the
  read-path DB write-back).
- **Connector sync = async job rows** (status poll/SSE), not in-request ETL; ALL connector creds
  encrypted (today only Kafka SASL is; pg/mysql passwords are plaintext JSONB); Kafka contract
  reference moves into the connector row (self-describing); `connectors_core` host gate ported
  verbatim with its 12 SSRF regression tests.
- CSRF token or strict origin check + non-permissive CORS; deep health check (`?deep=1` DB ping —
  planned in the current header, never built).
- **Gate to exit phase**: auth-audit Cat-1/3/4 clean; upload→clean→sql→export flows green;
  RBAC matrix re-run.

## Phase 5 — Frontend framework-first

*Goal: the current end-state, built in the right order (sandbox → pages, not pages → retrofit).*

- Day one on `rp-*` atoms + the component registry + ONE `mountRedTable` (no fork-A/B duality;
  data col-keys only — no `-3` display-index sentinel); single CSS @import manifest + two-tier
  tokens; hash router; prefs SWR + FOUC pre-paint script — all per current design.
- **`page-assembly` declarative page specs before any page is written** — the current 2,000–2,700
  line closure-threaded page modules are the explicitly-regretted order of operations.
- Worker-hosted wasm engine with permutation-only returns + the truncated-buffer completeness
  guard ("a partial client sort is impossible") — and keep the parsed buffer *resident in the
  worker* (transfer once, sort many) instead of re-cloning per gesture.
- Client-side filter/search lands here for free via the Phase-0 unified FilterNode.
- The four proof harnesses ported as standing acceptance gates: `framework-sandbox.html`
  (completeness), `typedef-acceptance.html` (vertical-agnosticism: unseen TypeDefinition renders
  with zero source changes), `wasm-bench.html`, `orchestrator-sim.html`.
- **Gate to exit phase**: sandbox renders all planned pages from registered components only;
  typedef-acceptance passes.

## Phase 6 — The apps (Studio first)

*Build order follows the product promise, not the current accretion order.*

1. **Studio / Workspace** — rail (projects/files), RedTable surface, cleaner panel (steps,
   undo/redo via `applied` flips), filter panel, joins wizard. The core product.
2. **Studio / Dashboard** — chart + dashboard designer (specs as `project_files` rows; ECharts
   self-hosted; `?source=FIL_` deep-link from Workspace).
3. **Studio / SheetWise** — read-only SQL console + connector pulls, **zero-risk invariant
   verbatim**: live sources never mutated; everything materializes as a NEW file through the
   upload pipeline.
4. **Support / Cases** — early, because it doubles as the agent-team handoff bus (5-lane kanban,
   optimistic status with revert, whitelist-rebuild sanitizer). People = memberships from day one.
5. **Home** — *decide the identity up front*: launcher grid ("My Services") with org/data CRUD
   living in Admin — resolving the launcher-vs-command-center split that's been pending as
   CAS_274 Phase B. The `apps.js` single registry (app = RBAC boundary + topbar) ports as-is.
6. **Admin** — Monitoring (request_log/events/db_query tabs), Admin Console (read-only config +
   RBAC field matrix), Database (read-only SQL console dogfooding the connector substrate; the
   real guarantee is the server-side READ ONLY txn + statement_timeout + LIMIT, never client
   parsing).
7. **Support / Docs** — pulldown-cmark reader; **authenticated** (today it's public and serves
   `docs/internal/` including runbooks).

## Phase 7 — Platform/ops layer (the agent operating system)

- **Audit suite with a shared harness lib first** (walk/strip/report once; each audit = classifiers
  only) — at 26 audits the current per-file boilerplate is ~10–20k duplicated lines. Keep the
  one-bug→one-audit reflex + incident citations in headers + `AUTH-AUDIT-ACK` reasoned
  suppressions.
- **Audits-as-CI ratchet** (findings in Postgres, `run_diff` SQL, only new/regressed fail) —
  replace the shell-whitelist + CHECK-constraint pair with a registry table; decouple ingestion
  from the cargo build so static audits never block on a broken backend.
- doc-gen marker-region generation (live DB as truth), extended to the page/route inventory so
  spine docs regenerate in the route-add commit.
- page-verify (Playwright, opt-in, exit-2 skip) — the JS-selector-lockstep check only a real
  browser catches.
- **One agent-identity source** (the users table) consumed by the MCP bridge, hooks, and
  presence — replacing today's three-way split (`.agent` file / `agent-rids.md` / per-process
  cookie). Cases as the only coordination bus; no markdown-slack peer system. Coordination state
  lives in a versioned store, not an rsync-stompable directory.
- 5-role orchestrator with **PreToolUse role-guards from day one** (not Phase-3-pending), the
  Case handoff bus, breaker caps, two human checkpoints — per the 2026-06-12 agent-system review
  (`docs/internal/specs/agent-system-review-2026-06-12.md`), whose 49 findings are the
  ops-layer punch list for this phase.

---

## Verification (per phase, cumulative)

- Phase 1–2: empty-DB migration run; **seeded non-admin RBAC matrix** (cross-tenant 404s, cascade
  reach, contract intersection, IDOR class) in CI.
- Phase 3: wasm32 `cargo check` purity gate; node-host smoke of every wasm export incl. lazy
  collect; wasm-bench parity (client score == server score on the stress corpus).
- Phase 4: auth-audit clean; connectors-audit (no `insert_*` outside pipeline) clean; SSRF
  regression tests; upload→clean→join→sql→export E2E.
- Phase 5–6: framework-sandbox completeness; typedef-acceptance (zero-source-change new type);
  page-verify across themes; 500k-row client sort with completeness guard.
- Phase 7: ci-audit ratchet green; orchestrator first run on a real Case as the validation.

## What this roadmap deliberately does NOT rebuild

- The vertical-specific cleverness is *ported*, not re-derived: the FR locale corpus knowledge,
  the SSRF encoding list, the score calibration, the join detector. Rewriting those would be
  burning the moat to admire the flame.
- No frameworks, no job queue/daemon/CI service beyond what exists — the everything-runs-from-
  a-fresh-clone frugality is a feature (and the Africa-first deployment story).
