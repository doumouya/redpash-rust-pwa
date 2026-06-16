# docs/ — index

One line per doc. For the **doc ⇄ code** cross-reference (which doc maps to which
part of the codebase), scan [REDMAP.md](REDMAP.md) first. Add a row here in the
same commit whenever you add a doc — `tools/doc-coverage-audit` gates it.

## Project-level

| Doc | What |
|---|---|
| [ROADMAP.md](ROADMAP.md) | The rebuild-from-scratch roadmap — phases + per-phase acceptance gates |
| [REDMAP.md](REDMAP.md) | Structural map: docs ⇄ code-area cross-reference + repo layout (scan before diving) |
| [INDEX.md](INDEX.md) | This file |

## Decisions (locked; changing one is an Em-level decision)

| Doc | What |
|---|---|
| [decisions/day-one.md](decisions/day-one.md) | The day-one locked decisions baked into the rebuild (retrofitting costs 10×) |
| [decisions/client-data-engines.md](decisions/client-data-engines.md) | Engine roles by job: Polars = compute, GlueSQL-idb = on-device store, Postgres = registry |
| [decisions/registry-redundancy.md](decisions/registry-redundancy.md) | The privacy posture — registry (ids/metadata) in Postgres, customer data client-side |

## Privacy (`docs/privacy/`)

| Doc | What |
|---|---|
| [privacy/privacy-by-design.md](privacy/privacy-by-design.md) | The standing PbD register — roles, data inventory, the 7 principles, risk register; enforced by `tools/privacy-audit/` |
| [privacy/assessment-2026-06-16.md](privacy/assessment-2026-06-16.md) | Dated independent GDPR/PbD assessment — verdict + findings register F-A…F-L |

## Code — Backend (`backend/crates/{api,data,shared}`)

| Doc | What |
|---|---|
| [internal/code/backend/README.md](internal/code/backend/README.md) | Backend index — the three-crate workspace (api edge / data engine / shared DTOs) — **start here** |
| [internal/code/backend/api-routes.md](internal/code/backend/api-routes.md) | The HTTP route catalog the frontend speaks (auth, me, files, objects/registry, types, rail, search, …) |
| [internal/code/backend/data-engine.md](internal/code/backend/data-engine.md) | The `data` crate: cleaning steps, group_by/reports, filters, the wasm `Workbook` surface |
| [internal/code/backend/connectors.md](internal/code/backend/connectors.md) | Connectors as a conduit — pull an external source → CSV bytes → client GlueSQL; the SSRF/TLS gate |

## Code — Frontend (`frontend/`)

| Doc | What |
|---|---|
| [internal/code/frontend/README.md](internal/code/frontend/README.md) | Frontend start-here — shell, routing, the page contract, the three registries |
| [internal/code/frontend/components.md](internal/code/frontend/components.md) | Component reference — grid family, chrome (rail/topbar/omni), atoms, responsive |
| [internal/code/frontend/conventions.md](internal/code/frontend/conventions.md) | ui-fork-audit R1–R9, the CI gates, CSS tokens, how to add a component |
| [internal/code/frontend/data-cleaner.md](internal/code/frontend/data-cleaner.md) | The Data Cleaner (`apps/studio/workspace`): orchestrator, engine seam, catalogs, modes |

## Specs / work items (`docs/internal/specs/`)

| Doc | What |
|---|---|
| [internal/specs/docs-reorg.md](internal/specs/docs-reorg.md) | This docs reorganization task (hierarchy + INDEX/REDMAP + reconcile + audit gate) |
| [internal/specs/build-fe-wasm-src.md](internal/specs/build-fe-wasm-src.md) | Bug: build-fe ships `frontend/wasm-src/` (~381 MiB Rust artifacts) into the dist |
