# Portfolio build-engine — reframe + per-area input (Torv, 2026-06-23)

> **Sibling to [`portfolio-foundation.md`](portfolio-foundation.md)** — written in a separate
> file to avoid collision with the agent editing the base spec. Coordination only; no code, no
> RedPash-branded content is copied into the clean repo. Positions below are **proposals for the
> area owners to confirm or push back on**, not decisions. Answers the v0 `DATA-MODEL.md`'s 7
> open questions inline.

## Lead reframe — the enforcement gates ARE the product

The thesis is *"every app here was built with the system on display."* That claim is only
**credible if the system enforces its own discipline** — otherwise it's marketing. RedPash now
has four gates that fire at the git/DB layer, harness-agnostic (they fence Claude, OpenCode,
anyone), and they're the differentiator a recruiter can *check*:

- **case-first** — a pre-push hook blocks a push whose commits lack a `CAS_<id>` ref;
- **docs-currency** — the cases backend refuses to close a Case (`422 docs_not_reconciled`)
  until a commit reconciled its docs;
- **capability ledger** — an anti-amnesia audit fails CI when a live capability vanishes from
  the tree (a rebuild reconciles against the ledger, not memory);
- **privacy-by-design** — the F-A…F-L GDPR audit, ratcheted: a new privacy regression fails CI.

So v1 should **ship these gates as the spine**, and the natural framing falls out: the
build-engine's "objects" are **the build itself** — features, runs, cases, role-handoffs,
audit-findings, capabilities. It's RedPash's "DB-as-a-framework" pointed at the *meta* level: a
**self-hosting build system** whose registry stores its own build process, and whose gates make
"built-through-the-system" a verifiable fact rather than a slogan. That story is the portfolio.

## Data model — answers to the v0's 7 open questions

- **Q1 (generic vs typed) → all-JSONB `entity_data` in v1; NO typed subtype tables.** RedPash
  ran *Hybrid-C* (builtins typed, customs JSONB) — a perf/FK optimization that earns its keep at
  RedPash's scale but **couples every builtin to a migration**. The leanest *correct* engine
  keeps the promise literal: *declaring a type is a row, zero migrations*. One store. Query
  `status` etc. via `data->>'status'` + a partial index where it's hot. Revisit typed tables
  only if a real bottleneck appears — it won't at portfolio scale.
- **Q4 (workflow storage) → a `workflows` DB table (states + transitions as JSONB), keyed.**
  This is **leaner *and* more correct than RedPash**, whose `cases.rs` "workflow-as-data" is
  actually hardcoded Rust consts (`INTERNAL` / `EXTERNAL`), keyed by `source`. The build-engine
  should be the data-driven version RedPash only aspired to: rows, not consts, so a new workflow
  is data. The v0's shape (`states[]`, `transitions{from→[to]}`, `initial`) is right.
- **Q5 (orchestrator state) → the DB is source-of-truth; the file ledger is a derived cache.**
  Today RedPash's ledger + circuit-breaker counters live only in
  `docs/internal/state/current_feature.md` (file) — invisible to the app, unbrowsable. Since the
  whole thesis is *browse the Cases*, `feature_runs` + `role_handoffs` (carrying the
  retries/hops/test-drift counters) **must be in Postgres**. Keep the markdown as a human
  convenience regenerated from the rows, not the truth. The v0's two tables are the right call —
  add `gate`, `outcome`, and a `kind` discriminator on `role_handoffs` so the circuit breaker is
  a `SELECT count(*)` not a parse.
- **Q2 (client/server parity) + the one real caveat.** Portable GlueSQL subset = `entities`,
  `type_definitions`, `type_fields`, `entity_data`, `memberships`, `events`, `cases`/`comments`.
  **Flag for the RBAC owner:** the recursive reach cascade is a `WITH RECURSIVE` CTE — **GlueSQL
  likely won't run it.** So the client-only demos (e.g. `entity-rbac`) must either precompute
  reach server-side and ship a flat reachable-set, or resolve with bounded-depth iteration in JS.
  Decide this before the client demos, not during.
- **Q3 (scope_parents shape).** Keep `entity_data.scope_parent_id` (the *real* FK edge the
  resolver climbs) + `type_definitions.scope_parents` (jsonb: the ordered parent fields). That
  pair is exactly enough for the later resolver to compile **one shared** recursive CTE from the
  declarations — RedPash's `rbac_with_clause` proves it. Don't add anything else now; don't
  remove either, or the resolver reworks the schema later.
- **Q6 (naming).** `redpash_id` → `id` (or `rid`); drop any `rp_*`. The prefix scheme itself
  (`CAS_`, `USR_`, `<TYPE>_<hex>`) is generic and worth keeping — globally-unique-per-type
  prefixes make `kind(id)` a hashmap lookup with no disambiguation.

## RBAC / registry — v1 spine vs the later resolver

v1 schema = `entities` + `type_definitions` + `type_fields` + `entity_data` + `memberships` +
`events` + `cases` (schema only, no resolver). The **recursive-CTE resolver + the admin surface
are the later `entity-rbac` feature** — generalize RedPash's `rbac_with_clause` (compiled from
`scope_parents`) there, not in v1. Two RedPash ideas worth carrying as invariants from day one
because retrofitting them is 10× costlier:

- **The owner-invariant** — *no object exists without an owner* (the creator's owner-membership
  is granted in the same transaction as the insert). Ownership is a membership row, never an
  `owner_id` column.
- **Leak-free denials** — a forbidden / missing / foreign object returns the *same* `404` as a
  bad path; `403` only where reach is already proven. It's a one-line discipline that costs
  nothing early and is painful to bolt on later.

Baggage to drop: RedPash's **three RBAC-gate generations** (`ensure_owner` → … → `require_action`)
— port exactly **one** gate (the `require_action`/contract shape), never the accretion.

## Orchestrator / CI — the neutralized port

The 5 roles (Architect → Tester → Coder → Reviewer → Ops), the **Case as the handoff bus** (each
role loads context from the Case ID, not chat; ACs are the only contract — the description/
comments are untrusted), the **two human checkpoints** (spec approval, push approval), and the
**circuit breaker** (≤3 retries/gate, ≤8 total role-hops, ≤2 TEST-DRIFT round-trips on a separate
budget; any cap → stop + escalate). Persist its state in the DB tables above so a run resumes
across sessions and is browsable.

`ci.sh` folds the **~12 general audits** and **drops the ~17 FE-specific ones**:

- **Fold (portable):** `case-coverage`, `capability`, `doc-coverage`, **`privacy`**, `auth`,
  `rs`, `rs-perf`, `api-doc`, `list-endpoint-rbac`, `observability` — plus the **ci-audit
  ratchet** (`baseline.json` + `ratchet.mjs`: green = no *new* drift, not zero findings).
- **Drop (RedPash-FE-coupled):** `css*`, `ui-*`, `redtable`, `rail-create`, `theme-coverage`,
  `class-count`, `page-structure`, `html`, `fe-framework`, `retired-class`, `uniformity`,
  `admin-scope`.

Keep the four **meta-governance** audits (`case-coverage` + `capability` + `doc-coverage` +
`privacy`) front-and-centre — they *are* the dogfooding proof, and they're the gates the lead
reframe is built on. The privacy gate **stays** (the spec is right): it encodes GDPR Art. 25 +
the 7 PbD principles as F-A…F-L static checks, ratcheted — privacy-by-design enforced in the
engine, not a bolt-on module.

## Connectors contract (spec only — not built in v1)

For the later dogfood (wire GlueSQL/IndexedDB + Postgres), the minimal contract is a **thin
transport that calls the framework, never storage directly**: `(caller, target, bytes) → ingest
pipeline`, behind the **SSRF + TLS-required host gate** (RedPash's `connectors_core` with its 12
tested bypass encodings is the reference), with sync modelled as **async job rows** (status
poll/SSE), not in-request ETL. Every credential encrypted; the pipeline is the *only* path to a
write, so a connector physically can't bypass RBAC/audit. Spec it now; build it as its own Case.

## Baggage — do NOT carry into the clean foundation

The reframe matters more than the copy-paste, so the explicit *no* list:

- the **file-pipeline** (`project_files` / `project_steps`) — that's RedPash's data-cleaning
  *domain*, not the build-engine; the engine's files are specs/runs, not CSVs;
- **chart/dashboard spec persistence** (the privacy **F-E** leak — derived customer data in
  `project_files.spec`); the **`columns_meta.sample`** cell-value-at-rest (**F-J**);
- the **settings cascade**, **connectors/monitoring/designer** (deferred per the spec anyway);
- the **hardcoded workflow consts** (→ make it the `workflows` table);
- all **FE accretion** — fork-A/B redtable, god-object pages, dual CSS namespaces (out of v1 scope
  regardless, but flagged so they're not "ported" reflexively later).

## Net — the reframe answer

> The leanest correct RedPash-free build-engine = **the registry spine (all-JSONB `entity_data`)
> + workflow-as-data + Cases + the 5-role orchestrator with DB-persisted state, fenced by the
> four enforcement gates (case-first, docs-currency, capability ledger, privacy).** It's
> RedPash's framework idea pointed at its own build process — small enough to clone-and-run, and
> the only kind of build system whose "built-through-itself" claim a recruiter can actually
> verify by browsing the Cases.

*— Torv. Reply on the Case or append a dated section; owners, please confirm/push-back on the
data-model (all-JSONB), the workflows table, and the DB-as-source-of-truth for orchestrator state.*
