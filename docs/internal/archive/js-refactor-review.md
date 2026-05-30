---
title: Frontend JS — refactoring review
section: Refactor
order: 0
last modified date: 2026-05-22
superseded-by: tools/js-audit/ — recurring audit replaces the one-shot review
---

# Frontend JS — the refactoring review

> **Internal — RedPash team only.** The JS counterpart to Gus's Rust
> audit. **Review only — no code changed.** Em's rule frames it: a
> refactor is only tractable once it is a *finite component
> decomposition*, not an open-ended cleanup list. So this document does
> not say "clean up the frontend". It says: **delete N modules, build M
> primitives, split 4 files into a known set of parts.** When that list
> is done, the refactor is done.

## The lesson, applied

The redtable surface felt huge until it turned out to be 8 HTML
components. The frontend JS is the same shape. `frontend/scripts/` is
**26,617 lines across ~46 files** — but that number is a fiction. A
large fraction is dead, and most of the rest is the *same dozen
behaviours* re-implemented per page. Decomposed, the real surface is
small. This review names every part so the work has a finish line.

## Current state — the JS tree, 2026-05-22

| File | LOC | Note |
|------|-----|------|
| `pages/cleaner.js`        | 8,653 | Two eras in one file — see Finding 1 |
| `pages/objects.js`        | 3,999 | Two engines in one file — see Finding 1 |
| `pages/reports.js`        | 2,058 | Live Designer page |
| `controls.js`             | 1,928 | 4 unrelated subsystems — see Finding 3 |
| `reports/index.js`        | 1,809 | **Dead** — nothing imports it |
| `redtable/index.js`       | 707   | Live |
| `dashboards/chart-render.js` | 697 | **Live** — keep, relocate |
| `main.js`                 | 671   | Router / shell |
| `file-review.js`          | 630   | Live |
| `dashboards/index.js`     | 589   | **Dead** — nothing imports it |
| `pages/settings.js`       | 524   | Defines `esc` twice |
| `pages/home.js`           | 462   | Live |
| `pages/dashboards.js`     | 392   | Live |
| `cleaner/index.js`        | 326   | **Dead** — nothing imports it |
| `dashboards/widgets.js`   | 219   | **Dead** — only `dashboards/index.js` imports it |
| `dashboards/templates.js` | 72    | **Dead** — only `dashboards/index.js` imports it |
| 17× `cleaner/tools/*.js`  | ~1,600 | One component, 14 configs — see Finding 2 |
| ~25 other files           | —     | Mostly thin; the duplication tax lives here |

The headline: of 26.6k lines, **~3,000 are strictly dead** (unimported
modules) and **another ~4,800 are dormant legacy fallback paths** that
prerelease never executes. The codebase you are actually maintaining is
closer to **~19k lines** — and shrinks further once the duplication is
pulled into shared primitives.

## Finding 1 — Dead code: delete before you decompose

Deleting is not refactoring — it is the *prerequisite*. You cannot
decompose a surface while half of it is unreachable. Two categories.

### 1a. Strictly dead modules — ~3,000 LOC, zero importers

Verified: no live `import` resolves to any of these.

| Module | LOC | Status |
|--------|-----|--------|
| `reports/index.js`        | 1,809 | `pages/reports.js:5` says it outright: *"kept on disk for revertability but never"* loaded. |
| `dashboards/index.js`     | 589   | `pages/dashboards.js:16` calls it *"the old multi-file delegator"*. |
| `dashboards/widgets.js`   | 219   | Imported **only** by the dead `dashboards/index.js`. |
| `dashboards/templates.js` | 72    | Imported **only** by the dead `dashboards/index.js`. |
| `cleaner/index.js`        | 326   | No script imports it. (Distinct from the live `partials/cleaner/index.html`.) |

`dashboards/chart-render.js` (697) and `dashboards/echarts.js` (84)
**survive** — they are imported live by `pages/reports.js` and
`pages/dashboards.js`. They are mis-filed: they no longer belong under
`dashboards/`. Move both to a neutral `scripts/charts/` so the live
chart engine is not buried in a dead folder.

**Action:** delete the 5 dead modules (~3,015 LOC). Git history is the
revert path — the on-disk "revertability" comment is the debt itself.

### 1b. Dormant legacy eras inside live files — ~4,800 LOC

`cleaner.js` and `objects.js` each contain **two complete
implementations**. The new one (the "sandbox" path) always wins:

- `cleaner.js:147` — `mount()` branches to `mountSandbox()` whenever
  `.rp-rt-proj-tabs-inner` is in the DOM. In prerelease that markup is
  *always* present, so the legacy path (~3,000 lines, incl. the
  ~2,000-line `_wireGlobals`) runs only if `include.js` fails to load a
  partial.
- `objects.js:845` — `mount()` branches to `mountObjectsSandbox()` the
  same way. The legacy mount + `loadTable`/`renderTable` (~L920–2785,
  ~1,800 lines) is the same dormant fallback.

The code comments call these "fallbacks". They are not — they are a
**permanent bet on a revert that the locked object model and the
redtable surface have already ruled out.** Two engines per file is also
why bugs hide (Finding 4): a fix lands in one era, not the other.

**Action:** once the redtable surface lands, delete both legacy eras.
That alone cuts `cleaner.js` ~8.6k → ~5k and `objects.js` ~4k → ~2.2k —
*before a single line is decomposed.*

### 1c. Dead schema entries

`objects.js` `SCHEMAS` still carries `reports` (`:311`) and
`dashboards` (`:362`) — entity types the locked object model retired.
`objects-catalog.js` already documents the removal in its header.
Delete both `SCHEMAS` blocks.

## Finding 2 — The finite shared-primitive set

This is the decomposition — the part that converts "refactor forever"
into "build M known things". Each row is a primitive that **already
exists, re-implemented per page**. Building it once and importing it is
a bounded, countable task.

| Primitive | Absorbs | Today |
|-----------|---------|-------|
| `dom.js` — `esc`, `$`, `$$` | HTML escaping + query helpers | `esc` defined in **27 files** (Finding 4) |
| `format.js` — `fmtDate`, `fmtBytes`, `relativeTime` | value formatting | re-implemented per page |
| `redtable.js` | the data-grid render/sort/select loop | inlined in cleaner, objects, reports |
| `filter-panel.js` | the 2-level AND/OR predicate panel | `cleaner/filters/panel.js` + an objects copy |
| `cell-edit.js` | inline cell editing (enum/text/commit) | inlined in objects + cleaner |
| `column-config.js` | the show/hide/reorder columns dropdown | inlined per page |
| `dropdown.js` | generic dropdown open/close/select | re-implemented in `controls.js` + pages |
| `pager.js` | rows-per-page + page nav | unified in markup, still per-page in JS |
| `blob-download.js` | export-blob → file download | re-implemented per export site |
| `ui/avatar.js` | initials/colour avatar | inlined in profile + settings + topbar |
| `ui/animate.js` — `animateNumber` | count-up animations | inlined per page |
| `session.js` — `doLogout` | logout + session teardown | re-implemented per page |
| `swr.js` | cache-then-fresh fetch pattern | the `api.getCached(...).fresh` dance, hand-rolled per call site |
| `defineTool({kind, fields, toParams, enableWhen})` | the 14 single-purpose cleaner tools | 17 files in `cleaner/tools/`; 14 are the *same component* |
| `renderChartInto()` | chart spec → DOM | already near-isolated in `chart-render.js` |

**On the cleaner tools:** `cleaner/tools/` has 17 files. `sidebar.js`
is the tool rail (not a tool). `joins.js` (204) and `dedup.js` (193)
are genuine exceptions — keep them standalone. The remaining **14 are
one component**: each declares a field set, maps fields → params, and
an enable condition. Collapse to a `defineTool` factory + 14 config
objects. `objects-catalog.js` is the proven model for this exact
pattern — a catalog array drives N surfaces.

That is the whole list. **~15 primitives.** Build them and the per-page
files have nothing left to duplicate.

## Finding 3 — Size hotspots: split plans

Each hotspot below is given as a *bounded part list*, not "make it
smaller".

**`cleaner.js` (8,653 → ~5k after Finding 1b → target ~4 files):**
after the legacy era is gone, the sandbox path splits into
`cleaner/mount.js` (orchestration), `cleaner/handlers.js` (the
~1,700-line `_installSandboxLiveHandlers`), `cleaner/state.js` (the
`STATE`/`OV` objects), `cleaner/render.js`. The "apply step →
re-render" block repeated ~10× becomes one `applyStep()` in
`render.js`.

**`objects.js` (3,999 → ~2.2k after Finding 1b/1c):** what remains is
the `SCHEMAS` table + `mountObjectsSandbox` + handlers. Once
`redtable.js`, `cell-edit.js`, `filter-panel.js`, `column-config.js`
are extracted, `objects.js` is just *the `SCHEMAS` catalog plus wiring*
— the thin shape it was always meant to be.

**`reports/index.js` (1,809):** deleted in Finding 1a. Not split.

**`controls.js` (1,928) — 4 unrelated subsystems, split 4 ways:**
- A — redtable interaction (`~L39–443`) → folds into `redtable.js`.
- B — tab system (`~L445–935`) → `tabs.js`.
- C — dropdowns / pager / theme (`~L937–1097`) → `dropdown.js` + `pager.js`.
- D — sandbox demo previews `SP_DEMO_*` / `spPreview*` (`~L1331–1593`)
  → **delete** — non-production demo scaffolding.

## Finding 4 — The `esc()` duplication

The single clearest duplication signal. An HTML-escaper is **defined in
27 files** under five different names — `esc`, `escapeHtml`, `_escHtml`,
`_htmlEsc`, `_spEscHtml` — plus `escapeAttr` in `joins.js`.
`pages/settings.js` defines `esc` **twice in one file** (`:369` and
`:431`). `cleaner/tools/*.js` carry a byte-identical one-liner copy in
each file.

This is not 27 bugs — it is 27 symptoms of one missing module. `esc`
moves to `dom.js`; all 27 sites import it. The five names collapse to
one. (Watch the [[module-strict-mode]] trap when removing module-scope
copies — duplicate `function` declarations are parse-time errors.)

## Finding 5 — Confirmed bug + a stale fork

Both verified against current source.

**Bug — `objects.js:2840`:**
```js
const res = await SCHEMAS.projects.fetch();
```
`SCHEMAS` entries have **no `fetch` method** — only `path`, `label`,
`title`, `icon`, `columns`. This line throws
`TypeError: SCHEMAS.projects.fetch is not a function` on **every
sandbox mount that does not start on the Projects tab** — and the bare
`catch {}` two lines down swallows it silently, so the Project column
falls back to a rid slice instead of real names. Every other call site
does it right: `objects.js:2708` is
`await api.getCached(SCHEMAS.projects.path).fresh`. The fix is that
exact line. (Likely a casualty of the two-engine split in Finding 1b —
the fix landed in one era, not the other.)

**Stale fork — `controls.js:561`:** `controls.js` re-declares
`window.OBJECT_TAB_CATALOG` with **6 entries** — including `reports`
and `dashboards`, the types the locked object model retired.
`objects-catalog.js` is the canonical source with **4 entries** and a
header that explicitly documents the removal. The `controls.js` copy is
a stale fork that will resurrect dead tabs. Delete it; import the
canonical catalog. (Subsystem D, deleted in Finding 3, but call it out
on its own — it actively contradicts a locked decision.)

## Phasing — the bounded plan

| Phase | Work | Result |
|-------|------|--------|
| **0 — Delete** | Finding 1a + 1c; fix Finding 5 bug; delete the `controls.js` catalog fork. | ~3,100 LOC gone, 1 real bug fixed. Near-zero risk — nothing imports the deleted code. |
| **1 — Primitives** | Build the ~15 modules in Finding 2, starting with `dom.js`/`esc` (touches 27 files, highest leverage). | The duplication has somewhere to go. |
| **2 — Delete legacy eras** | Finding 1b — drop the dormant paths in `cleaner.js` + `objects.js` once the redtable surface lands. | ~4,800 LOC gone; both files roughly halve. |
| **3 — Split hotspots** | Finding 3 — `cleaner.js` → 4 files, `controls.js` → 4 targets. | No file is a god-object. |

Phases 0 and 1 are independent and can start now. Phase 2 is gated on
the redtable surface. Phase 3 is last because it is only safe once the
primitives exist to split *into*.

## Lanes

- **Frontend (Woz):** Phase 0 + Phase 1. Phase 0 is a clean, low-risk
  first commit — pure deletion + one bug fix.
- **Frontend (Torv / Woz):** Phases 2–3, sequenced behind the redtable
  surface work already in flight.
- **No backend or docs lane** — this is entirely `frontend/scripts/`.

## The bounded total

This refactor is not "improve the frontend". It is:

> **Delete 5 modules + 2 legacy eras + 2 dead schema blocks. Build ~15
> primitives. Split 2 files into a known set of parts. Fix 1 bug.**

Every item is countable and has a clear *done*. That is the whole job —
there is no open-ended remainder. Per [[refactor-decompose]]: once the
list is finite, the work stops feeling infinite.
