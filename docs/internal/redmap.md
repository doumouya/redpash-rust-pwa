---
title: Internal REDMAP — find anything fast
section: Internal
order: -1
last modified date: 2026-06-07
---

# Internal REDMAP

One page for navigating the internal docs without `grep`. This is now the
**single** nav map — the public `docs/REDMAP.md` is being folded in and
deleted (CAS_701CF65E); during the migration the old shape-based sections are
kept under [Transitional](#transitional--migrating) so nothing goes dark.

Sections:
[Surface map](#surface-map) ·
[Find by area](#find-by-area) ·
[The survival layer](#the-survival-layer-code) ·
[Transitional](#transitional--migrating)

---

## Surface map

```
docs/internal/
├── index.md            the ontology — feature/page spine + survival layer + shelves
├── redmap.md           ← you are here
│
│   ── feature/page spine (hand-written WHY + generated facts) ──
├── rest-api/           the HTTP surface — generated route table + per-resource conventions
├── auth/               sign-in — google + dev-user/bootstrap
├── db/
│   ├── schemas/        per-object: generated schema + field/business-logic prose
│   └── rbac/           entity · memberships · teams · permission-contract
├── stack/              code explanation at SYSTEM granularity — frontend/backend/tools/db
├── pages/              one doc per shipped page + _shared/ chrome (topbar, rail-footer)
│
│   ── the survival layer ──
├── code/               one doc per source file (tools/ · frontend/scripts/ · backend/crates/)
│   ├── _nav.md         generated back-index of every atomic doc
│   ├── backend/  frontend/  tools/
│
│   ── cross-cutting shelves ──
├── runbooks/           operational / incident playbooks
├── processes/          how the team works (touch-policy, audit cadence, push policy, …)
├── decisions/          the durable WHY — design choices that bind future work
└── archive/            snapshots no longer load-bearing
```

---

## Find by area

| If you want to … | Read |
|---|---|
| Understand a page (what it does, its rail, its surface) | [pages/](pages/index.md) |
| Find / add an HTTP route | [rest-api/](rest-api/index.md) |
| Know the data model / an object's schema or who can touch it | [db/](db/index.md) · [db/schemas/](db/schemas/index.md) · [db/rbac/](db/rbac/index.md) |
| Understand how a subsystem works under the hood | [stack/](stack/index.md) |
| Understand a specific source file | [code/](code/index.md) — the survival layer |
| Know *why* it's built this way | [decisions/](decisions/index.md) |
| Sign-in / session flow | [auth/](auth/index.md) |
| Debug a production incident | [runbooks/](runbooks/index.md) |
| Follow the team's conventions | [processes/](processes/index.md) |
| See current doc coverage / drift | run `sh tools/audit.sh` — `doc-coverage-audit` reports per-pillar % + stubs / staleness |

---

## The survival layer (`code/`)

One doc per source file — the cross-rewrite + agent-onboarding layer
(`code/.../joins.md` is what let the join feature be rebuilt across multiple
RedPash incarnations). Held fresh by the **touch-policy** (edit a source file →
update its atomic doc in the same commit).

- [code/index.md](code/index.md) — the dir map + up-links to each file's spine page.
- [code/_nav.md](code/index.md) — the generated back-index of every atomic doc (`doc-gen --code-nav`).
- [code/_template.md](code/_template.md) — copy + fill the 3 required headings to author one.

---

## Transitional — migrating

The old shape-based sections, kept until their content is ported (Phase C) and
they're deleted (Phase E). **Don't add new docs here.** Listed so nothing goes
un-navigable mid-migration.

```
architecture/   → decisions/ (durable why) + stack/frontend (shell patterns)
│   ├── js-rust-boundary.md  object-model.md  redtable-unification.md
│   ├── roadmap-webassembly.md  ui-shell-pattern.md
subsystems/     → stack/ or the owning pages/
│   ├── api-routes.md  audit-storage.md  data-engine.md  events-and-logs.md
│   ├── omnisearch.md  prefs.md  step-engine.md  wasm-engine.md  workspace-shell.md
specs/          → db/schemas/, db/rbac/, pages/, or the owning subsystem
│   ├── admin-monitoring-surfaces.md  audit-storage-design.md  dep-audit-design.md
│   ├── filter-dto.md  monitoring-schemas.md  user-preferences.md  (+ rbac/, object-metadata/)
flows/          → the owning pages/
│   ├── csv-upload-to-render.md  step-apply-and-replay.md
│   ├── search-omnisearch.md  auth-session-prefs.md
ui/             → generated catalog under ui/catalog/, linked from pages/
observability/  → pages/monitoring + stack/backend
cases/          → pages/cases + processes/
excel-edge-cases/   kept (referenced from stack/backend)
jira-flow-proposition/  → archive/
standup/        retired (empty) → deleted Phase E
```

Old routing (still valid for the not-yet-ported docs):

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

Old by-question rows still pointing at not-yet-ported docs:

| If you want to … | Read (until ported) |
|---|---|
| Plan the workspace's next big refactor | [architecture/redtable-unification.md](architecture/redtable-unification.md) |
| Touch the cleaning step engine | [subsystems/step-engine.md](subsystems/step-engine.md) |
| Regenerate the WASM bundle | [subsystems/wasm-engine.md](subsystems/wasm-engine.md) |
| Send a filter from the UI to the server | [specs/filter-dto.md](specs/filter-dto.md) |
| Understand the upload flow end-to-end | [flows/csv-upload-to-render.md](flows/csv-upload-to-render.md) |
| Find the parity-gap log from the merge | [archive/frontend-parity-inventory.md](archive/frontend-parity-inventory.md) |
