---
title: Atomic-doc plan — every source file documented
section: Processes
order: 5
last modified date: 2026-05-30
---

# Atomic-doc plan

Every source file under `tools/`, `frontend/scripts/`, and
`backend/crates/` gets a corresponding atomic doc under
`docs/internal/code/<mirrored-path>.md`, with a 2-line breadcrumb in
the source pointing back. Drift is prevented by a new
`tools/doc-coverage-audit/` and a touch-policy recorded in
`CLAUDE.md`. Em (2026-05-30): *"in the long run the cost will be high
to not maintain the code documented at an atomic level."*

> **All 9 decisions resolved 2026-05-30 — Phase A unblocked.** Em
> accepted the recommended defaults for #1–5, #7, #8; overrode #6 (no
> REDMAP size constraint) and #9 (substantive `getting-started.md`
> treatment). See §10 for the full decision log.

## Non-goals

- **No doc-gen framework.** No Docusaurus, no MkDocs runtime. Markdown
  files only, rendered today by `data::render::doc`. Stack constraint:
  no frameworks ([[feedback-no-frameworks]]).
- **No in-source extraction tooling.** The atomic doc IS the deep
  explanation; the source carries a one-line breadcrumb pointing at
  it. No build step, no generated artifacts in `docs/`.
- **No big-bang retroactive fill.** Phase A delivers 100% stub
  coverage + the audit; Phases B–D deep-fill pillar-by-pillar;
  touch-policy carries it forward forever.

---

## 1 · The seven forks, resolved

| # | Fork | Position | Rationale |
|---|---|---|---|
| 1 | Granularity | **Per-file** (+ optional internals subdoc for >800-LOC files like `steps/mod.rs`, `files/mod.rs`) | The file is the unit Torvs and audits already reason about; per-symbol is unmaintainable in a no-framework shop, per-module hides the file-boundary contracts that drift |
| 2 | Layout | **Mirror source tree** under `docs/internal/code/{backend,frontend,tools}/` | Maps source → doc by string substitution; `tools/doc-coverage-audit` enforces it both ways; matches git-blame mental model |
| 3 | Authoring style | **Markdown-primary + 2-line `Doc:` breadcrumb in source** | Both halves are human-readable, git-friendly; the breadcrumb closes the loop bidirectionally without a build step |
| 4 | Sequencing | **Cover-first-stub-then-fill + touch-policy** | Stubs give 100% coverage day 1 (audit can grade against it); touch-policy carries it forward; big-bang is infeasible across the parallel-Torv pool |
| 5 | Drift prevention | **Audit + policy** — `tools/doc-coverage-audit/` is the data, `CLAUDE.md` is the discipline | Audit is the only honest enforcer in a no-CI-gate-by-default repo; policy is what the audit gives Torvs grounds to reject a PR on |
| 6 | REDMAP role | **Spine + link** — both REDMAPs (`docs/REDMAP.md` + `docs/internal/redmap.md`) gain anchor links from Surface-map leaves to their atomic doc; neither absorbs the explanation inline | spine+link keeps REDMAPs the only useful index. Per decision §10·6 (Em override) they are **not size-capped** — they may grow as needed; the constraint is "don't absorb the catalog," not "stay under N lines" |
| 7 | Existing brainstorming docs | **`git mv` to `docs/internal/specs/`** — they're design specs in disguise | Brainstorming docs in `tools/` mix shapes; specs/ is their natural home per the ontology in `docs/internal/index.md` |

---

## 2 · Inventory baseline

| Pillar | Count | Breakdown |
|---|---|---|
| **Tools** | 31 | 19 audit-family dirs (`auth-audit`, `ci-audit`, `crossing-audit`, `css-audit`, `css-cross-page-audit`, `css-tab-compare-audit`, `html-audit`, `js-audit`, `mcp-server`, `memory-gc`, `observability-audit`, `page-structure-audit`, `parse-diag`, `redtable-audit`, `rs-audit`, `rs-perf-audit`, `team`, `ui-snapshot-audit`, `wasm-bench`) + 9 shell scripts + 3 one-off tool dirs (`css-parallel`, `css-usage`, `csv-to-xlsx-rs`) |
| **Frontend scripts** | 45 | 24 in `scripts/` root, 11 in `scripts/pages/`, 5 in `scripts/charts/`, 3 in `scripts/tools/`, 1 in `scripts/report/`, 1 in `scripts/audit/` |
| **Backend** | 80 | 25 `api/routes/`, 16 `shared/`, 13 `data/`, 9 `api/` root, 6 `data/steps/`, 6 `api/db/`, 3 `data/parse/`, 2 `api/bin/` |
| **= atomic units** | **156** | **+ ~18 dir-rollup `index.md` files + ~6 cross-section navigational edits ≈ 180 docs total** |

---

## 3 · Existing navigational topology (in scope)

15 indexing artifacts must be considered in Phase A:

| Layer | Artifact | Role |
|---|---|---|
| Public top | `docs/INDEX.md` | Public docs landing — Section table |
| | `docs/REDMAP.md` | Source-tree index ("read first") |
| | `docs/getting-started.md` | Onboarding — "RedPash has two halves: backend/ frontend/" |
| | `docs/VISION.md` | Product intent (**untouched** by plan) |
| Internal top | `docs/internal/index.md` | Shape ontology (8 sections, "each is a shape not a topic") |
| | `docs/internal/redmap.md` | Internal navigational index |
| Section rollups | `docs/internal/{architecture,archive,excel-edge-cases,flows,processes,runbooks,specs,standup,subsystems}/index.md` | 9 per-section indexes |

The atomic-docs plan adds a **9th shape** to the ontology:

| Section | Shape | Lifecycle |
|---|---|---|
| **[code]** *(name decision §10·7)* | the **what this file is** — one doc per source file | lives as long as the file does; refreshed in the touching commit (touch-policy) |

---

## 4 · Target file layout

New tree under `docs/internal/code/` (additive — nothing existing moves
except the two `git mv` source paths):

```
docs/internal/code/
├── index.md
├── backend/
│   ├── index.md
│   ├── api/
│   │   ├── index.md
│   │   ├── main.md, state.md, bootstrap.md, id.md, error.md, event.md,
│   │   │   db_query.md, redact.md, request_log.md
│   │   ├── bin/{redpash-audit-ingest.md, …}
│   │   ├── db/{index.md, mod.md, sessions.md, sentinels.md, users.md,
│   │   │       projects.md, …}
│   │   └── routes/
│   │       ├── index.md
│   │       ├── auth.md, me.md, projects.md, charts.md, group.md,
│   │       │   dashboards.md, cases.md, monitoring.md, metrics.md,
│   │       │   search.md, admin.md, demo.md, docs.md, pagination.md,
│   │       │   users.md, companies.md, events.md
│   │       └── files/{index.md, mod.md, joins.md, stats.md, output.md,
│   │                  meta.md, state_ops.md}
│   ├── data/
│   │   ├── index.md
│   │   ├── dtype.md, group_by.md, stats.md, joins.md, dedup.md,
│   │   │   render.md, encoding.md
│   │   ├── parse/{index.md, mod.md, filter.md, sniff.md}
│   │   └── steps/{index.md, mod.md, util.md, rows.md, columns.md,
│   │              cells.md, structure.md}
│   └── shared/
│       ├── index.md
│       └── {lib, project, file, step, filter, report, dashboard, user,
│            company, case, chart, search, monitoring, optimization,
│            admin, event}.md
├── frontend/
│   ├── index.md
│   ├── scripts/
│   │   ├── index.md
│   │   ├── {main, api, events, virtual-rows, designer, report, tools,
│   │   │   dom, dropdown, autocomplete, column-index, format, joins,
│   │   │   list-page, page-row, prefs, rail-controls, rail-footer,
│   │   │   sw-update, theme, topbar, wasm-engine, echarts-kpi,
│   │   │   echarts-theme}.md
│   │   ├── audit/snapshot.md
│   │   ├── charts/{build, render, builder-ui, home-bank,
│   │   │           monitoring-bank}.md
│   │   ├── pages/{workspace, home, monitoring, cases, profile,
│   │   │           settings, docs, login}.md
│   │   ├── pages/cases/*.md, pages/home/*.md, pages/monitoring/*.md
│   │   ├── report/*.md
│   │   └── tools/{catalog, actions, fields}.md
└── tools/
    ├── index.md
    ├── audit-suite/
    │   ├── index.md
    │   └── {auth, ci, crossing, css, css-cross-page, css-tab-compare,
    │         html, js, memory-gc, observability, page-structure,
    │         parse-diag, redtable, rs, rs-perf, ui-snapshot}-audit.md
    ├── mcp-server.md, team.md, wasm-bench.md
    ├── shell/{audit, build-wasm, db-reset, db-setup, dev-setup,
    │           health-check, install-stack, port-check,
    │           stack-version}.md
    └── one-off/{css-parallel, css-usage, csv-to-xlsx-rs}.md
```

Two relocations (Phase A, single commit, via `git mv` to preserve blame):

- `tools/audit-storage-brainstorming.md` → `docs/internal/specs/audit-storage-design.md`
- `tools/dep-audit-brainstorming.md` → `docs/internal/specs/dep-audit-design.md`

---

## 5 · Atomic doc page template

Every atomic doc uses this exact skeleton. `doc-coverage-audit` parses
the headings to grade completeness.

```markdown
---
title: <relative source path, e.g. backend/crates/api/src/routes/files/joins.rs>
source: ../../../../<relative path from this doc back to the source file>
owner: Gus | Torv | Em | shared
section: Internal · Code · <Pillar>
last modified date: YYYY-MM-DD
---

# <filename>

## Purpose          ← REQUIRED
1–3 paragraphs. WHY this file exists, what problem it solves, what
would break if it were deleted. No code.

## Public surface   ← REQUIRED
Bulleted list of every exported symbol.
- Rust: `pub fn name(args) -> Ret — one-line summary`
- Routes: `METHOD /path — handler — auth posture`
- JS: `export name — shape — callers`

## Internal contracts
Invariants this file assumes about its inputs and guarantees about its
outputs. The "if you touch this, you must preserve…" list.

## Dependencies (upstream)
- Crates / modules imported and what is used from each.
- DB tables/columns touched (backend).
- DOM ids / CSS classes touched (frontend).

## Callers (downstream)
- Who imports this file and which symbol they reach for.
- Cross-tier callers (`api/routes/foo.rs` ← `frontend/scripts/pages/foo.js`)
  — captured by `tools/crossing-audit`; link to its latest finding.

## Drift-prone areas   ← REQUIRED
Places this file is most likely to silently break:
- shape changes shared with `shared/<x>.rs`
- hardcoded ids/paths/route strings that must match X
- ordering / mutex / regex assumptions

## Related docs
- Subsystem: [../../../subsystems/<x>.md]
- Spec: [../../../specs/<x>.md]
- Sibling atoms in the same dir.

## History (optional)
Decomp dates, big rewrites, deprecations.
```

**Required:** `Purpose`, `Public surface`, `Drift-prone areas`
*(decision §10·1)*. Other sections may be `_n/a_`.

---

## 6 · Inline source breadcrumb

Every documented source file gets a 2-line header pointing at its
atomic doc.

**Rust** — top of file:

```rust
//! Purpose: short one-liner — what this file is.
//! Doc: docs/internal/code/backend/crates/api/src/routes/files/joins.md
```

**JavaScript** — top of file:

```js
/* Purpose: short one-liner — what this file is.
   Doc: docs/internal/code/frontend/scripts/api.md */
```

**Shell scripts** — top of file:

```bash
#!/usr/bin/env sh
# Purpose: short one-liner.
# Doc: docs/internal/code/tools/shell/audit.md
```

The breadcrumb closes the loop both ways: source → doc via the `Doc:`
line, doc → source via the front-matter `source:` field.
`doc-coverage-audit` validates both directions.

---

## 7 · `tools/doc-coverage-audit/` design

Mirrors `tools/rs-audit/` and `tools/rs-perf-audit/` exactly (ES5
CommonJS, no deps, <1s, emits `report.html` + `audit.json`,
auto-discovered by `tools/audit.sh`'s `tools/*-audit/` glob).

### What it scans

1. Walks `backend/crates/{api,data,shared}/src/**/*.rs`,
   `frontend/scripts/**/*.js`, `tools/**/audit.js`, `tools/**/*.sh`,
   and the three one-off tool dirs.
2. For each source file, computes the expected doc path by string
   substitution: `backend/crates/api/src/routes/files/joins.rs` →
   `docs/internal/code/backend/crates/api/src/routes/files/joins.md`.
3. Reads the source file's first 30 lines, extracts the `Doc:`
   breadcrumb.
4. Reads the doc file (if it exists), parses front-matter + required
   headings.
5. Also walks `docs/internal/` to flag navigational consistency
   (orphans, unregistered sections).

### Finding kinds (emitted as `audit.json` rows for ingest)

| Finding | Trigger |
|---|---|
| `missing_doc` | Source file exists, atomic doc does not |
| `missing_breadcrumb` | Source file has no `Doc:` line in its first 30 lines |
| `wrong_breadcrumb` | `Doc:` line points to a path that doesn't exist or doesn't match the mirror rule |
| `stub_doc` | Doc exists but a required heading body is `_stub_` or shorter than 40 chars |
| `stale_doc` | Source has a commit newer than the doc by **[14] days** *(decision §10·2)* |
| `orphan_doc` | Doc file exists under `code/` with no matching source file |
| `missing_required_heading` | Doc lacks `## Purpose`, `## Public surface`, or `## Drift-prone areas` |
| `unregistered_section` | New top-level dir under `docs/internal/` with no row in `internal/index.md`'s shape table |
| `unindexed_internal_doc` | New `.md` under `docs/internal/` not referenced from `internal/redmap.md` |

### Gating

- **Local suite run** (`sh tools/audit.sh`): runs like every other
  audit; failures **reported**, not enforced — parity with `rs-audit`.
- **Pre-commit gate** *(decision §10·3)*: optional
  `tools/doc-coverage-audit/precommit.sh` scoped to changed files, exits
  non-zero on `missing_doc` / `missing_breadcrumb` for files in the
  diff. **Recommend opt-in per Torv.**
- **Ingest**: relax `audit.run.tool` CHECK in a new migration to add
  `doc-coverage` (precedent: `20260613000001_relax_audit_tool_check.sql`).
  Findings land in `audit.run` + `audit.finding` like every other tool.

---

## 8 · Phased rollout — parallel-Torv-safe

Each phase has **disjoint pathspecs**. With `git commit -o <pathspecs>`
the three Torvs never collide.

### Phase A · Foundation (single Torv, blocking, ~6–8h)

**Pathspecs:**

```
tools/doc-coverage-audit/**
backend/migrations/<date>_relax_audit_tool_check_doc_coverage.sql
docs/internal/code/**/index.md
docs/REDMAP.md
docs/INDEX.md
docs/getting-started.md
docs/internal/index.md
docs/internal/redmap.md
docs/internal/specs/audit-storage-design.md   ← from tools/ via git mv
docs/internal/specs/dep-audit-design.md       ← from tools/ via git mv
CLAUDE.md
```

**Deliverables:**

1. Build `tools/doc-coverage-audit/audit.js` + `report.html` template +
   `audit.json` schema. Wire into `tools/audit.sh`'s `INGEST_TOOLS`.
2. Ship the CHECK-relaxation migration.
3. Author `docs/internal/code/_template.md` — the atomic-doc skeleton
   (§5).
4. Create every `docs/internal/code/**/index.md` (18 rollups) — real
   docs from day 1, listing children + cross-links.
5. **Restructure both REDMAPs:**
   - `docs/REDMAP.md`: each leaf in the Surface map ASCII tree gains a
     `[doc](internal/code/...)` link. Add a new `## Atomic docs`
     section pointing to `docs/internal/code/index.md`.
   - `docs/internal/redmap.md`: add `code/` to its Surface map; add
     cross-refs from `## Find by question` and `## Find by system`.
6. **Update both internal indexes:**
   - `docs/internal/index.md`: add the **[code]** row to the Sections
     table with declared shape + lifecycle.
   - `docs/INDEX.md`: register `code/` under the existing **Internal —
     RedPash team only** section *(decision §10·8)*.
7. **New "Going deeper — code-level docs" section in `getting-started.md`**
   *(decision §10·9, Em 2026-05-30: substantive treatment)*. The
   section must, at minimum:
   - State that every file under `tools/`, `frontend/scripts/`,
     `backend/crates/` has a corresponding atomic doc under
     `docs/internal/code/...md`.
   - Show the 2-line breadcrumb pattern (one Rust + one JS example,
     copy-paste from §6) so new readers recognise it in source.
   - Map the source-tree → doc-tree convention (one paragraph: "to
     find the doc for `backend/crates/api/src/routes/files/joins.rs`,
     read `docs/internal/code/backend/crates/api/src/routes/files/joins.md`").
   - Link to `docs/internal/code/index.md` (top of the code-doc tree)
     and `docs/internal/processes/atomic-doc-plan.md` (this plan, the
     spec).
   - Include a "your first dive" pointer to **2–3 worked-example atomic
     docs** once Phase B/C/D produce them. In Phase A, stub this as
     `_pointers added when Phase B lands its first 5 docs_` so the
     `stub_doc` audit flags it for fill.
8. Record touch-policy in root `CLAUDE.md`: *"editing a source file
   requires updating its `docs/internal/code/...md` in the same
   commit; flagged by `doc-coverage-audit` and `stale_doc`."*
9. `git mv` both brainstorming docs to `specs/`; prepend
   `Superseded-by: none — design spec, kept live` headers; cross-link
   from `subsystems/audit-storage.md`.
10. *(decision §10·5)* Archive backfill: every doc under
    `docs/internal/archive/` gets a `Superseded-by:` header pointing to
    its live replacement (or `Superseded-by: none — historical only`).
    Recommend folding into Phase A as a single sub-commit (~1h).

**Exit gate:** `sh tools/audit.sh` reports `missing_doc` for ~156
files (the expected baseline). No other audit regresses. Coverage %
displayed in `report.html`.

### Phase B · Backend pillar (one Torv, ~22–28h)

**Pathspecs:**

```
backend/crates/**/*.rs            ← 2-line header insertions only
docs/internal/code/backend/**
```

- Add the 2-line `Purpose:` + `Doc:` header to every `.rs` file.
- Write the 80 atomic docs, ordered: `shared/` (smallest surface, sets
  shape) → `data/` → `api/` with `routes/` last.
- Stub coverage delivered in commit 1 of Phase B (audit % = 100%);
  deep-fill incrementally as cleaner / route work touches files.

### Phase C · Frontend pillar (one Torv, ~14–18h, parallel with B)

**Pathspecs:**

```
frontend/scripts/**/*.js          ← 2-line header insertions only
docs/internal/code/frontend/**
```

- Same shape as B — 45 docs across root, `pages/`, `pages/*/`,
  `charts/`, `tools/`, `report/`, `audit/`.

### Phase D · Tools pillar (any Torv, ~10–12h, parallel with B/C)

**Pathspecs:**

```
tools/**/audit.js                 ← header insertions; DO NOT touch other Torvs' WIP audit dirs
tools/*.sh                        ← header insertions
docs/internal/code/tools/**
```

- Audit-suite docs are **largely extractable** from the rich existing
  headers in `tools/css-audit/audit.js`, `tools/rs-audit/audit.js`,
  etc. — ~30-min copy-shape-and-paraphrase per audit.
- Shell-script docs are mostly stub-grade — they're already
  self-documenting via top-of-file comments; the `.md` collects them.

### Phase E · Ongoing (no end date)

- Touch-policy + `doc-coverage-audit` becomes the new normal.
- `audit.sh` runs it every time any Torv runs the suite.
- One Torv-half-day per quarter sweeping `stale_doc` findings as
  backlog grooming.

**Parallel safety:** B, C, D have disjoint pathspecs (`backend/` vs
`frontend/` vs `tools/`). Phase A is single-Torv and gates B/C/D.
REDMAP edits in Phase A commit only `docs/REDMAP.md` +
`docs/internal/redmap.md` via `-o` so other Torvs editing adjacent
sections in parallel WIP don't get swept.

---

## 9 · Maintenance loop

```
   ┌─────────────────────────────────────────────────┐
   │  edit source file                               │
   │       ↓                                         │
   │  touch-policy (CLAUDE.md):                      │
   │     update docs/internal/code/.../<file>.md     │
   │     in the same commit                          │
   │       ↓                                         │
   │  sh tools/audit.sh on PR / locally              │
   │       ↓                                         │
   │  doc-coverage-audit:                            │
   │     stale_doc? missing_breadcrumb?              │
   │     missing_required_heading?                   │
   │       ↓ findings                                │
   │  audit.finding rows in Postgres (ingest)        │
   │       ↓                                         │
   │  monitoring page surfaces backlog               │
   │       ↓                                         │
   │  quarterly Torv-half-day grooming               │
   └─────────────────────────────────────────────────┘
```

---

## 10 · Decision log

**All resolved 2026-05-30** — Phase A unblocked.

| # | Decision | Value | Status | Notes |
|---|---|---|---|---|
| 1 | Required heading count in template (§5) | **3** — Purpose, Public surface, Drift-prone areas | ✓ Em 2026-05-30 | recommended default accepted |
| 2 | `stale_doc` threshold (§7) | **14 days** between source-commit and doc-commit | ✓ Em 2026-05-30 | recommended default accepted |
| 3 | Pre-commit gate per Torv (§7) | **opt-in** — each Torv installs `precommit.sh` for themselves | ✓ Em 2026-05-30 | recommended default accepted |
| 4 | Brainstorming `git mv` (§4) | **yes** — to `docs/internal/specs/` | ✓ Em 2026-05-30 | recommended default accepted |
| 5 | Archive backfill timing (§8·A·10) | **now** — 1h sub-commit folded into Phase A | ✓ Em 2026-05-30 | recommended default accepted |
| 6 | REDMAP length budget post-restructure | **no size constraint** *(Em override; recommended was ≤700)* | ✓ Em 2026-05-30 | REDMAPs may grow as needed to host the spine+link structure; the constraint is "don't absorb the catalog inline," not a line cap |
| 7 | New section name (§3) | **code** — section path: `docs/internal/code/` | ✓ Em 2026-05-30 | tracks Em's framing; shape-ontology row in `internal/index.md` disambiguates |
| 8 | `docs/INDEX.md` registration (§8·A·6) | **under "Internal — team only"** | ✓ Em 2026-05-30 | recommended default accepted |
| 9 | `getting-started.md` treatment (§8·A·7) | **substantive "Going deeper" section** *(Em override; recommended was one-line)* | ✓ Em 2026-05-30 | one-line was the lean default; Em wants `getting-started.md` to genuinely onboard readers into the code-level docs |

---

## 11 · Effort estimate

| Phase | Effort | Calendar |
|---|---|---|
| A · Foundation | 6–8 h, single Torv blocking | ~1 day |
| B · Backend (80 docs) | 22–28 h | ~3–4 Torv-days |
| C · Frontend (45 docs) | 14–18 h | ~2–3 Torv-days |
| D · Tools (31 docs) | 10–12 h | ~1.5 Torv-days |
| **Total initial** | **~52–66 h** | **~1.5 calendar weeks** at three Torvs in parallel after A |

| Maintenance | Cost |
|---|---|
| Touch-policy (per source-file-touching commit) | +3–5 min/commit |
| Quarterly stale-doc grooming sweep | ~4 h/quarter |
| `doc-coverage-audit` runtime in suite | zero added (auto-discovered) |
| **Quarterly steady-state** | **~14–16 h** |

Em's "cost will be high to not maintain" thesis cashes out as:
**~60 h upfront + ~15 h/quarter forever**, in exchange for grep being
optional and onboarding a Torv-week shorter.

---

## 12 · Critical files for Phase-A execution

- `tools/audit.sh` — master runner; rs-perf-audit precedent for new audit shape
- `tools/rs-audit/audit.js` — closest existing audit to mirror (ES5, file walker, report.html)
- `tools/rs-perf-audit/audit.js` — newest audit (this Torv built; ~410 lines, good shape match)
- `docs/REDMAP.md` — restructure target #1
- `docs/internal/redmap.md` — restructure target #2
- `docs/internal/index.md` — shape ontology, add `[code]` row
- `docs/INDEX.md` — register under "Internal — team only"
- `docs/getting-started.md` — one-line mention
- `CLAUDE.md` — touch-policy entry
- `backend/migrations/` — CHECK-relaxation migration for `doc-coverage` tool

---

## 13 · Related

- [[feedback-audit-everything]] — every meaningful capability has an audit
- [[feedback-build-tools-proactively]] — `doc-coverage-audit` IS the discipline
- [[feedback-process-oriented]] — fix it once by encoding the fix in a tool
- [[feedback-own-the-surface]] — the structural sweep is part of the discipline
- [[feedback-parallel-safe-commits]] — `git commit -o` for every phase
- `docs/internal/index.md` — the shape ontology the `[code]` section extends
- `tools/rs-perf-audit/` — newest sibling audit, shape this one follows
