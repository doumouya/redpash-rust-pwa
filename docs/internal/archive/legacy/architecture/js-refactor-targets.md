---
title: JS refactor targets — 2026-05-24
section: Internal / Architecture
order: 18
last modified date: 2026-05-24
owner: Torv
status: spec — implementations in flight
---

# JS refactor targets

> Em's standing rule: *refactoring + parameterization is not optional,
> it's our survival in a monolithic design.* This doc captures the
> patterns the audit surfaced and the ones I noted while shipping
> Designer + the chart-strip workstream, ranked by **LOC saved /
> risk**.

## Baseline (`tools/audit.sh`, 2026-05-24)

| Metric | Value |
|---|---|
| JS files | 20 |
| Total LOC | 8,016 |
| Unreachable modules | 0 |
| Duplicate symbols | 3 |
| God-objects (>800 LOC) | 4 |

### Duplicates (audit output)

| Symbol | Files | LOC per def |
|---|---|---|
| `esc` | 9 (designer · main · docs · home · login · monitoring · report · tools · topbar) | ~5 |
| `cssEsc` | 3 (docs · home · monitoring) | ~3 |
| `escHTML` | 2 (profile · settings) | ~5 |

### God-objects

| File | LOC | Notes |
|---|---|---|
| `pages/workspace.js` | 1431 | the surface itself is the size of 4 pages — orchestrates rail + redtable + filter/history/tools panels + designer mount |
| `report.js` | 1040 | full report builder (5 sections × accordion × sheet × preview × matrix × undo) |
| `tools.js` | 1017 | cleaning tools panel — columns-redtable + 15 tool configs + sheet rendering |
| `pages/monitoring.js` | 950 | rail-page shell + 6 tabs (requests, events, runs, findings, steps, optimization) |

## Refactor targets

Ranked by **net LOC saved × confidence** (highest first).

### T1 — extract `esc` / `cssEsc` to `/scripts/dom.js`

- **Saves:** ~45 LOC across 9 files + creates one bug-fix surface
- **Risk:** trivial — pure functions, identical across all copies
  (audit confirms `esc` reduces to the same `String(s).replace(/[&<>"]/g, …)`
  body everywhere)
- **Implementation:** new `frontend/scripts/dom.js` exports `esc`,
  `cssEsc`, plus any future DOM utility. Every consumer drops its
  local copy + adds `import { esc } from "/scripts/dom.js"`.
- **Risk to ship in one commit:** low. The audit will surface any
  consumer I miss (duplicate-symbols count goes 9 → 0 verifies).

### T2 — extract list-page runtime to `/scripts/list-page.js`

- **Saves:** ~350 LOC net (home.js -250, monitoring.js -250, shared
  module +150)
- **Risk:** medium — home and monitoring have subtle divergence
  (home: chipRows for per-row scope filters; monitoring: window chips
  for time ranges). Both share the same `renderListBody → fetchList →
  kpiStripHTML → chartsStripHTML → mountListCharts → disposeListCharts`
  spine.
- **What gets extracted:**
  - `headHTML(title, count)` + `kpiStripHTML(tiles)` + `setKpi(id, val)`
    + `chartsStripHTML(charts)` + `mountListCharts(spec, chipState)` +
    `disposeListCharts()` + `CHART_KINDS` map + lazy resize listener
  - Parameterised via spec shape: `{ endpoint, statsEndpoint?,
    chipRows? | windowChips?, charts? }`
- **What stays per-page:** row HTML (`spec.row(item)`), title, page-
  level state, navigation chrome. The renderer becomes a runtime;
  pages declare data.
- **Implementation:** ship in two commits — module + home.js
  migration, then monitoring.js migration.
- **Bonus:** opens future admin pages (Settings full / a Reports
  manager / etc.) to plug into the same runtime for free.

### T3 — extract dropdown atom (`[data-dd]` toggle)

- **Saves:** ~30 LOC across `workspace.js` (the canonical impl) +
  `report.js` (the workaround we shipped when the workspace's mount-
  time sweep missed dynamically-rendered buttons)
- **Risk:** low — the dropdown atom is well-defined: click target +
  body matched by id, outside-click closer, mutex behaviour.
- **Implementation:** new `frontend/scripts/dropdown.js` exports
  `bindDropdownClick(root)` that handles the toggle delegate on
  `root`. Consumers call it once at mount; dynamically-rendered
  dropdowns get the toggle for free.

### T4 — extract sheet/modal lifecycle

- **Saves:** unclear yet — depends on how much the three sheet
  implementations diverge.
- **Risk:** medium-high — `tools.js` has a select-mode sheet with
  chip header + perColumn loop, `report.js` has a dialog sheet,
  `designer.js` has the accordion (sheet-like but persistent).
  Different enough that premature extraction is the bigger risk
  than the duplication.
- **Recommendation:** **defer** until a fourth sheet site appears.
  Note the pattern, don't extract yet.

### T5 — workspace.js decomposition (1431 LOC)

- **Saves:** uncertain — the workspace is genuinely doing a lot
  (rail, toolbar, filter panel, history panel, tools panel mount,
  designer mount, report mount, file upload, deep-link routing).
  Splitting risks scattering coherent flows across files.
- **Risk:** high — workspace is the central nervous system; a
  per-section split (rail/ + table-engine/ + panel-orchestration/)
  could improve readability OR fragment the existing tight cohesion.
- **Recommendation:** **defer** until a specific section grows large
  enough to justify its own module (e.g. if the rail logic alone
  ever passes 400 LOC). The 1431 LOC is dense because the surface
  is dense, not because it's copy-paste.

## Ship order

1. **T1** — `dom.js` extraction. Low risk, fast. Audit confirms 3
   dupes → 0 dupes (success criterion is the audit number itself).
2. **T2 part A** — `list-page.js` module with home.js migration. Run
   audit; LOC drop confirms.
3. **T2 part B** — `monitoring.js` migration to `list-page.js`.
4. **T3** — `dropdown.js`. Quick win after T2.
5. **T4, T5** — deferred, re-evaluate after T1–T3 land.

## Audit pattern catalog

`tools/js-audit/audit.js` carries a pattern catalog mirroring the
`tools/rs-audit` discipline (Gus's idea, Slack 2026-05-24). Each
pattern is one regex + a status tag:

- **extracted** — helper exists; hit-count should stay 0 (T1's
  `esc`/`cssEsc`, T3's `$$("[data-dd]")` sweep, theme-less
  `echarts.init(el)`). Non-zero = regression.
- **live** — helper-usage tracker. Counts callers (skips the
  helper's own file) so `chartTheme()`, `dom.js` imports,
  `kpi*()`, `list-page.js` imports, `bindDropdown()`, and
  `ensureRegisteredThemes()` show their reuse spread.
- **declined** — duplication exists but variation is load-bearing.
  Tracked to flag growth past `REVISIT_THRESHOLD = 20` (inline-HTML
  concat, ad-hoc `setTimeout`). A crossing means "look again", not
  "extract now".

`bash tools/audit.sh` prints the catalog under `patterns:`. The HTML
report's **Patterns** tab carries the per-file breakdown.

## What we **don't** refactor (and why)

- **mount factories** (`mountDesigner` / `mountTools` / `mountReport` /
  `mountTopbar` / `mountSwUpdate` / `mountSettings` etc.) — each is
  domain-specific. A `mount()` higher-order would over-generalise:
  the inputs / lifecycle / state shape differ per surface. Em's
  "refactor by decomposition" rule applies in reverse here — you
  can't decompose mountDesigner with mountTopbar without inventing
  parameters that nobody actually shares.
- **buildOption (designer)** — already parameterised by `cfg + theme`,
  with branches per chart kind. Adding more abstraction would hide
  the kind-specific logic the user is editing.
- **Run-step lifecycle** (`runStep` in tools.js / report.js /
  designer.js) — three sites, three slightly different shapes
  (per-column loop for fill_nulls; sheet apply for global actions;
  PUT for chart save). Probably worth a shared `runMutation()`
  helper down the line, but the divergence is real enough that
  T4-style "defer until a fourth site" is the right call.

## Linked

- [`tools/js-audit/report.html`](../../tools/js-audit/report.html) — the
  audit-suite's JS report (auto-updates with `bash tools/audit.sh`).
- [`tools/audit.sh`](../../tools/audit.sh) — the suite entry point.
- [`feedback_refactor_decompose`](../../../memory) — Em's principle
  that this doc executes against.
