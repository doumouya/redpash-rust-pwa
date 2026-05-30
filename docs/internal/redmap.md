---
title: Internal REDMAP — find anything fast
section: Internal
order: -1
last modified date: 2026-05-24
---

# Internal REDMAP

One page for navigating the internal docs without `grep`. Counterpart
to the public [REDMAP](../REDMAP.md) which covers the source tree.

Sections:
[Surface map](#surface-map) ·
[By question](#find-by-question) ·
[By system](#find-by-system) ·
[Cross-refs to public docs](#cross-refs-to-public-docs)

---

## Surface map

```
docs/internal/
├── index.md                       this layout, lane ownership, audience routing
├── redmap.md                      ← you are here
│
├── architecture/                  the WHY
│   ├── js-rust-boundary.md        Rust owns data, JS owns pixels — the contract
│   ├── object-model.md            Em-locked 2-entity model (Project + File)
│   ├── redtable-unification.md    WS#5 — one atom, three consumers (next big refactor)
│   ├── roadmap-webassembly.md     Gus's WASM phasing — runtime-neutral DTO rule
│   └── ui-shell-pattern.md        .rp-shell, rail+body, the wide modifier
│
├── subsystems/                    the HOW IT WORKS
│   ├── api-routes.md              every /api/* route — purpose, auth, owners
│   ├── audit-storage.md           audit JSON → DB → diff lifecycle
│   ├── data-engine.md             data crate, polars features, dtype sniff
│   ├── events-and-logs.md         events capture + request_log + monitoring reads
│   ├── omnisearch.md              /api/search + topbar dropdown
│   ├── prefs.md                   user_preferences table + SWR cache
│   ├── step-engine.md             apply / replay / undo / redo / snapshots
│   ├── wasm-engine.md             wasm-bindgen wrappers + 5 MB gate
│   └── workspace-shell.md         rail + table + filter + tools panels
│
├── specs/                         the WHAT — wire contracts
│   ├── admin-monitoring-surfaces.md  Home + Monitoring IA + endpoint list
│   ├── audit-storage-design.md    audit-ingest pipeline design (was tools/audit-storage-brainstorming.md, moved 2026-05-30)
│   ├── dep-audit-design.md        dep & runtime tracking spec (was tools/dep-audit-brainstorming.md, moved 2026-05-30)
│   ├── filter-dto.md              FilterNode / FilterOp canonical
│   ├── monitoring-schemas.md      events / request_log / audit.* shapes
│   └── user-preferences.md        prefs key registry + PATCH protocol
│
├── flows/                         the HOW DATA MOVES
│   ├── csv-upload-to-render.md    multipart → xlsx_to_csv → DB → /page → table
│   ├── step-apply-and-replay.md   POST /steps → persist → replay on next read
│   ├── search-omnisearch.md       keystroke → /api/search → grouped → navigate
│   └── auth-session-prefs.md      login → /api/me → seedPrefs → first paint
│
├── processes/                     how the team works
│   ├── audit-cadence.md           audit.sh as a merge gate
│   ├── docs-lane-ownership.md     each agent is SME for their lane's docs
│   ├── push-policy.md             agents commit on prerelease, Torv pushes
│   └── ui-change-process.md       the standard HTML/CSS/JS-change checklist
│
├── runbooks/                      operational / incident playbooks
│   ├── 0001-orphan-prefs.md       Settings UI persisted a choice no code read
│   └── 0002-stale-join-after-drop.md  joins that survived dropped columns
│
├── standup/                       per-contributor append-only logs
│   ├── em.md, gus.md, torv.md, woz.md
│
├── code/                          the WHAT IS THIS FILE — one doc per source file
│   ├── backend/                   80 atomic docs (api, data, shared)
│   ├── frontend/                  45 atomic docs (scripts, pages, charts, tools)
│   └── tools/                     32 atomic docs (audit-suite, shell, per-dir, one-off)
│
├── archive/                       snapshots no longer load-bearing
│   ├── frontend-parity-inventory.md     pre-merge parity gap accounting
│   ├── frontend-reset-merge-report.md   the rebuild-into-prerelease cut
│   ├── handoff-frontend-datatables.md   Woz → Torv handoff during suspension
│   ├── js-refactor-review.md            one-shot JS-refactor critique
│   ├── workspace-migration.md           workspace-page migration journal
│   └── woz-2026-05-25-suspension-report.md
│
└── excel-edge-cases/              triage data (22 fixtures × 41 classes)
```

---

## Find by question

| If you want to … | Read |
|---|---|
| Understand the Rust ↔ JS split | [architecture/js-rust-boundary.md](architecture/js-rust-boundary.md) |
| Know what entities exist (Project, File, …) | [architecture/object-model.md](architecture/object-model.md) |
| Plan the workspace's next big refactor | [architecture/redtable-unification.md](architecture/redtable-unification.md) |
| Get the WASM phasing | [architecture/roadmap-webassembly.md](architecture/roadmap-webassembly.md) |
| Use the rail-page shell on a new page | [architecture/ui-shell-pattern.md](architecture/ui-shell-pattern.md) |
| Add a new HTTP route | [subsystems/api-routes.md](subsystems/api-routes.md) |
| Understand the audit pipeline | [subsystems/audit-storage.md](subsystems/audit-storage.md) |
| Touch the cleaning step engine | [subsystems/step-engine.md](subsystems/step-engine.md) |
| Regenerate the WASM bundle | [subsystems/wasm-engine.md](subsystems/wasm-engine.md) |
| Add a new pref | [subsystems/prefs.md](subsystems/prefs.md) + [specs/user-preferences.md](specs/user-preferences.md) |
| Send a filter from the workspace UI to the server | [specs/filter-dto.md](specs/filter-dto.md) + [architecture/js-rust-boundary.md](architecture/js-rust-boundary.md) |
| Understand the upload flow end-to-end | [flows/csv-upload-to-render.md](flows/csv-upload-to-render.md) |
| Understand how cleaning steps survive a reload | [flows/step-apply-and-replay.md](flows/step-apply-and-replay.md) |
| Investigate a frontend production issue | [runbooks/](runbooks/index.md) first, then `standup/` for recent context |
| Find the parity-gap log we used during the merge | [archive/frontend-parity-inventory.md](archive/frontend-parity-inventory.md) |
| Find the deep-explanation for a specific source file | [code/index.md](code/index.md) — atomic docs mirror the source tree |
| Author a new atomic doc | [code/_template.md](code/_template.md) — copy and fill the 3 required headings |
| See current doc coverage / drift | run `sh tools/audit.sh` — `doc-coverage-audit` reports per-pillar % + stubs / staleness |

---

## Find by system

| System | Architecture | Subsystem | Spec | Flow |
|---|---|---|---|---|
| **Workspace UI** | [redtable-unification](architecture/redtable-unification.md) | [workspace-shell](subsystems/workspace-shell.md) | — | [csv-upload-to-render](flows/csv-upload-to-render.md) |
| **Step engine** | [js-rust-boundary](architecture/js-rust-boundary.md) | [step-engine](subsystems/step-engine.md) | — | [step-apply-and-replay](flows/step-apply-and-replay.md) |
| **Filter / sort** | [redtable-unification](architecture/redtable-unification.md) | [data-engine](subsystems/data-engine.md) | [filter-dto](specs/filter-dto.md) | — |
| **Omnisearch** | — | [omnisearch](subsystems/omnisearch.md) | — | [search-omnisearch](flows/search-omnisearch.md) |
| **User prefs** | — | [prefs](subsystems/prefs.md) | [user-preferences](specs/user-preferences.md) | [auth-session-prefs](flows/auth-session-prefs.md) |
| **Monitoring** | — | [events-and-logs](subsystems/events-and-logs.md) | [admin-monitoring-surfaces](specs/admin-monitoring-surfaces.md), [monitoring-schemas](specs/monitoring-schemas.md) | — |
| **Audit suite** | — | [audit-storage](subsystems/audit-storage.md) | — | — |
| **WASM** | [roadmap-webassembly](architecture/roadmap-webassembly.md) | [wasm-engine](subsystems/wasm-engine.md) | — | — |

---

## Cross-refs to public docs

- Architecture docs explain the *why*; public [features/](../features/) docs describe the *user-facing* surface. A new engineer reads architecture first, then features for the consumer side.
- Specs here define the wire; public [api/](../api/) docs describe what the API *does* for the consumer. Same endpoint, different audience.
- Internal subsystems are deeper than the public docs — when in doubt, the subsystem doc is the source of truth.
