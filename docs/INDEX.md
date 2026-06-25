# docs/ — index

One line per doc. For the **doc ⇄ code** cross-reference (which doc maps to which
part of the codebase), scan [REDMAP.md](REDMAP.md) first. Add a row here in the
same commit whenever you add a doc — `tools/doc-coverage-audit` gates it.

## Project-level

| Doc | What |
|---|---|
| [REDMAP.md](REDMAP.md) | Structural map: docs ⇄ code-area cross-reference + repo layout (scan before diving) |
| [INDEX.md](INDEX.md) | This file |

## Decisions (locked; changing one is an Em-level decision)

| Doc | What |
|---|---|
| [decisions/vision.md](decisions/vision.md) | The product north-star — who RedPash serves, the three-step promise (Upload→Clean→Visualise), the join problem, and the two strategic bets that bind how it evolves |
| [decisions/target-architecture.md](decisions/target-architecture.md) | The durable platform DNA — the 3-bucket rule (entity / edge / derived view), the two spines (entity registry + unified membership edge), cascade-as-data, single-table-subtype; the WHY behind day-one's locked line items |
| [decisions/object-model.md](decisions/object-model.md) | A new object exists only for a new SHAPE, never a new combination — the orthogonal-primitive rule; what is stored vs derived (no reports/dashboards tables); underpins day-one #1/#2 |
| [decisions/day-one.md](decisions/day-one.md) | The day-one locked decisions baked into the rebuild (retrofitting costs 10×) |
| [decisions/client-data-engines.md](decisions/client-data-engines.md) | Engine roles by job: Polars = compute, GlueSQL-idb = on-device store, Postgres = registry |
| [decisions/registry-redundancy.md](decisions/registry-redundancy.md) | The privacy posture — registry (ids/metadata) in Postgres, customer data client-side |
| [decisions/disposability-requires-a-ledger.md](decisions/disposability-requires-a-ledger.md) | No capability lives only in memory — a rebuild reconciles against the capability ledger; enforced by `tools/capability-audit/` |

## Governance & memory (`docs/internal/`)

| Doc | What |
|---|---|
| [internal/capability-ledger.md](internal/capability-ledger.md) | The source of truth for what exists (every capability as a key); `tools/capability-audit/` fails CI on a dropped or undocumented capability |
| [internal/parity-review-2026-06-20.md](internal/parity-review-2026-06-20.md) | Dated prerelease→lean parity diagnostic — what the graduation genuinely dropped vs merely refactored |

## Privacy (`docs/privacy/`)

| Doc | What |
|---|---|
| [privacy/privacy-by-design.md](privacy/privacy-by-design.md) | The standing PbD register — roles, data inventory, the 7 principles, risk register; enforced by `tools/privacy-audit/` |
| [privacy/assessment-2026-06-16.md](privacy/assessment-2026-06-16.md) | Dated independent GDPR/PbD assessment — verdict + findings register F-A…F-L |

## Auth (`docs/internal/auth/`)

| Doc | What |
|---|---|
| [internal/auth/dev-user.md](internal/auth/dev-user.md) | The dev-user / bootstrap / first-admin path — `#[cfg(debug_assertions)]` dev-login (compiled OUT of release, not a runtime flag), the auto-admin `dev` bootstrap user + default project, and `POST /auth/claim-admin` (the atomic first-admin claim) |
| [internal/auth/google.md](internal/auth/google.md) | The production Google OAuth authorization-code flow — backend-minted opaque `rp_session` (no Google token reaches JS), the `rp_oauth_state` CSRF bridge, upsert-by-`sub`, the `Caller`/60s-cache lifecycle (day-one #10) |

## Code — Backend (`backend/crates/{api,data,shared}`)

| Doc | What |
|---|---|
| [internal/code/backend/README.md](internal/code/backend/README.md) | Backend index — the three-crate workspace (api edge / data engine / shared DTOs) — **start here** |
| [internal/code/backend/api-routes.md](internal/code/backend/api-routes.md) | The HTTP route catalog the frontend speaks (auth, me, files, objects/registry, types, rail, search, …) |
| [internal/code/backend/data-engine.md](internal/code/backend/data-engine.md) | The `data` crate: cleaning steps, group_by/reports, filters, the wasm `Workbook` surface |
| [internal/code/backend/connectors.md](internal/code/backend/connectors.md) | Connectors as a conduit — pull an external source → CSV bytes → client GlueSQL; the SSRF/TLS gate |
| [internal/code/backend/schema.md](internal/code/backend/schema.md) | The Postgres data model — the entity-registry spine, `type_definitions`/`type_fields`, `entity_data` vs typed tables, the file pipeline + `audit` schemas |
| [internal/code/backend/redpash-id.md](internal/code/backend/redpash-id.md) | The RedPash-ID scheme — `<PREFIX>_<32-hex>` UUID v4, the per-type-unique prefix registry (FIL/USR/…), the two mint paths, and why UUID over Crockford-base32 |
| [internal/code/backend/rbac.md](internal/code/backend/rbac.md) | The authorization model — `require_action`/`require_rule`, the `scope_parents` reach cascade, leak-free 404, the per-role field-permission layer |
| [internal/code/backend/objects.md](internal/code/backend/objects.md) | The polymorphic object registry — `/api/objects/:type` as one handler over every registered type; `entity_data` vs typed tables; the IDOR guard |
| [internal/code/backend/cases.md](internal/code/backend/cases.md) | The `/api/cases` surface — the workflow-as-data engine (transition map → 422), the 10 endpoints, metadata-only attachments |
| [internal/code/backend/messaging.md](internal/code/backend/messaging.md) | In-app chat (channels + DMs) on the registry substrate — RBAC by channel-membership cascade, `/api/channels` + `/api/messages`, polling, safe Markdown |
| [internal/code/backend/monitoring.md](internal/code/backend/monitoring.md) | The in-app audit trail — the `audit` schema, the `redpash-audit-ingest` bin, the four platform-admin `/api/monitoring/*` endpoints |

## Code — Frontend (`frontend/`)

| Doc | What |
|---|---|
| [internal/code/frontend/README.md](internal/code/frontend/README.md) | Frontend start-here — shell, routing, the page contract, the three registries |
| [internal/code/frontend/components.md](internal/code/frontend/components.md) | Component reference — grid family, chrome (rail/topbar/omni), atoms, responsive |
| [internal/code/frontend/conventions.md](internal/code/frontend/conventions.md) | ui-fork-audit R1–R9, the CI gates, CSS tokens, how to add a component |
| [internal/code/frontend/data-cleaner.md](internal/code/frontend/data-cleaner.md) | The Data Cleaner (`apps/studio/workspace`): orchestrator, engine seam, catalogs, modes |

## Code — Tools (`tools/`)

| Doc | What |
|---|---|
| [internal/code/tools/README.md](internal/code/tools/README.md) | The `tools/` immune system — the `ci.sh` gate, the auto-discovered `*-audit/` suite + ci-audit ratchet, the wasm/FE build scripts, `tools/lib/`, the MCP server, wasm-bench, and the tracked git hooks |

## Specs / work items (`docs/internal/specs/`)

| Doc | What |
|---|---|
| [internal/specs/docs-reorg.md](internal/specs/docs-reorg.md) | This docs reorganization task (hierarchy + INDEX/REDMAP + reconcile + audit gate) |
| [internal/specs/build-fe-wasm-src.md](internal/specs/build-fe-wasm-src.md) | Bug: build-fe ships `frontend/wasm-src/` (~381 MiB Rust artifacts) into the dist |
| [internal/specs/agent-system-review-2026-06-12.md](internal/specs/agent-system-review-2026-06-12.md) | Dated review of the `/feature` 5-role orchestrator — 49 prerelease findings (+ F50 from the lean re-verify), each tagged addressed/open/diverged against the current lean tree |

## Runbooks (`docs/internal/runbooks/`)

| Doc | What |
|---|---|
| [internal/runbooks/0007-column-drag-reorder-cluster.md](internal/runbooks/0007-column-drag-reorder-cluster.md) | Historical record — four bugs (thead↔tbody desync, weak edge drop indicator, trailing-sentinel `appendChild` off-by-one, spec-index edit-mode mis-target) on the predecessor's in-table column drag-reorder; lean closes the class by construction (one `redtable` keyed by `data-col`/`data-key`, reorder = `update({columns})` re-render, no drag interaction) |
| [internal/runbooks/0009-cleaning-type-coercion-regression.md](internal/runbooks/0009-cleaning-type-coercion-regression.md) | Historical record — the cleaner stopped cleaning (`type_consistency` gap on the Fleury corpus) because plain `.cast()` is locale-naive; fixed (live on lean) by `normalize_numeric_cell`/`normalize_bool_cell`/day-first `parse_date_flex` in `steps/util.rs`, pinned by in-crate tests |
| [internal/runbooks/0010-rbac-admin-nest-privilege-escalation.md](internal/runbooks/0010-rbac-admin-nest-privilege-escalation.md) | Historical record — the predecessor's `/admin` nest had no platform-admin gate (any authed user could `POST /admin/memberships` to self-grant Owner) while `/monitoring` did; lean closes it by construction (admin verdict pre-resolved on `Caller`, gate is the FIRST line of every `/admin`/`/monitoring` handler, leak-free 404) |
| [internal/runbooks/0011-object-kind-prefix-mismatch.md](internal/runbooks/0011-object-kind-prefix-mismatch.md) | Historical record — the predecessor's hardcoded `TEAM`/`DSH` prefix dispatch drifted from minted `TEM_`/`FIL_`; lean closes it by construction (unique `rid_prefix` + registry-driven `object_kind`) |
| [internal/runbooks/0012-connector-gate-ssrf-encodings.md](internal/runbooks/0012-connector-gate-ssrf-encodings.md) | The connector SSRF/TLS gate hole — IPv6-wrapper / zone-id / trailing-dot encodings of `169.254.169.254` slipped `is_blocked_host`; fixed by `embedded_ipv4`+`ip_literal`+`is_unspecified`, pinned by 5 tests |
| [internal/runbooks/0022-admin-scope-registry-list.md](internal/runbooks/0022-admin-scope-registry-list.md) | Architecture record — user surfaces de-admin-scoped via the object registry + reach-scoped delivery ("one engine, two surfaces"); the generic `/api/objects/:type` reach-scoped list; staged rollout (shipped vs deferred) |
| [internal/runbooks/0023-polars-0.54-wasm-fork.md](internal/runbooks/0023-polars-0.54-wasm-fork.md) | polars 0.54 won't compile for wasm32 (tokio→mio); fix = the `doumouya/polars-rp` fork via `[patch.crates-io]` (live on lean) + the upgrade playbook |
| [internal/runbooks/objects-scope-parent-idor.md](internal/runbooks/objects-scope-parent-idor.md) | Historical record for the FIXED cross-tenant `scope_parent_id` IDOR in `objects.rs::create` — the `require_rule >= Member` reach gate, the day-one #3 FK, the regression test, the auth-audit Cat-4 detector |
