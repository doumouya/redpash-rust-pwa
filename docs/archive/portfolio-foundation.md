# Case — Portfolio build-engine foundation (clean, RedPash-free) · coordination + reframe needed

> **Cross-session coordination brief for the team.** The build lands in a NEW clean repo at
> `/home/mansa/rust-project/portfolio-ai-app/build-engine/`, **fully scrubbed of any "RedPash" / "rp-" reference**
> (code, comments, filenames). This doc lives in `lean` *only to coordinate* — it may name RedPash freely, because
> `lean` is the private source we generalize from. **Nothing RedPash-branded is copied verbatim into the clean repo.**

## Situation
Emmanuel is repositioning for the job market (and possibly freelance). RedPash-as-one-big-private-app is hard for a
recruiter to evaluate (heavy docs, non-trivial install). Plan: extract RedPash's best ideas into small, independent,
**public, instantly-testable** demos — each scrubbed of RedPash — and prove our build discipline by **building them
THROUGH our own system** so the Cases become the real, browsable build log.

## Why this Case (the dogfooding thesis)
Before any demo, we build a **minimal headless build-engine**, then build the demos through it (each a logged Case).
A recruiter browsing the Cases sees the genuine build history: *"every app here was built with the system on display."*

## Deliverables — the MINIMAL headless build-engine (v1), in the clean repo
1. **Data model** — a generalized, RedPash-free "DB-as-a-framework" schema: `entities` + `type_definitions`/`type_fields`
   + `entity_data` + `memberships`/`scope_parents` + `events`/audit + `cases` (comments, status, workflow, attachments)
   + orchestrator/feature state (ledger + circuit-breaker counters). *(A v0 seed is drafted at
   `portfolio-ai-app/build-engine/docs/DATA-MODEL.md` — please reframe it; see asks below.)*
2. **Cases backend** — `create / get / comment / set_status`; workflow-as-data (illegal transition → `422`); API + MCP.
   **No UI.**
3. **5-role orchestrator** — a neutralized port of `.claude/agents` (Architect→Tester→Coder→Reviewer→Ops) + the
   `/feature` flow + the Case-handoff bus + the state ledger + the circuit breaker (≤3 retries/gate, ≤8 role-hops).
4. **`ci.sh`** — the ratcheted audit gate + the genuinely-useful tools from `main`/`prerelease` folded in. **The privacy
   gate stays** (privacy-by-design is enforced here, not a separate module).

All data must be **logically stored and ready** so the later UIs (Monitoring, Case+Comment, Connector, Admin Console)
can simply *render* it — no schema rework when the front-ends arrive.

## Explicitly OUT of scope (v1)
The RBAC **resolver/admin logic**, the **connectors**, the **monitoring** logic, **any UI**, and the full
"everything-we-learned" production backend (that's a **separate freelance workstream**). v1 = the leanest engine that
lets us build the rest without drift. Resist scope creep.

## Future projects that depend on this engine (each built THROUGH it, each a logged Case + a public demo)
`advanced-datatable` (client wasm — shipped early for recruiter proof) · `entity-rbac` (the RBAC resolver + admin,
client-side via GlueSQL) · `connectors` (dogfood: wire GlueSQL/IndexedDB + Postgres) · `monitoring` (port the most
advanced `prerelease` version) · `framework-kit` + the Claude-Design front-ends.

## Per-area asks — contribute your expertise, and reframe to the leanest *correct* version
- **Data-model owner:** the minimal generalized schema — what to keep from `…_init.sql`, what to drop, RedPash-free
  naming, and how much works in BOTH Postgres (server) and a GlueSQL subset (client).
- **RBAC / registry owner:** which of the `entities`/`type_definitions`/`memberships`/`scope_parents` spine belongs in
  v1 vs. the later resolver feature; confirm the recursive-CTE shape we should generalize.
- **Orchestrator / CI owner:** the cleanest neutralized port of `.claude/agents` + `/feature` + the Case handoff +
  `ci.sh`; which `prerelease` audits/tools are worth folding in; how to store the ledger/circuit-breaker in the DB.
- **Connectors owner:** the minimal connector *contract* (for the later dogfood to GlueSQL + Postgres) — spec only, not built in v1.
- **Everyone:** flag any RedPash pattern that's **baggage** we should NOT carry into the clean foundation. The reframe
  matters more than the copy-paste.

## The reframe we're seeking
> *"What is the leanest, correct, RedPash-free build-engine (data model + Cases + orchestrator + CI) that generalizes
> everything we learned building RedPash — enough to build any of these web projects without drift — without recreating
> RedPash's size/install problem?"*

## How to contribute
- **Code → the clean repo** (`portfolio-ai-app/build-engine/`), scrubbed. **This doc → coordination only.**
- Reply via `case_comment` (if the MCP is up), or append a dated section to this spec, or open a sibling spec under
  `docs/internal/specs/`. Keep edits attributed.
