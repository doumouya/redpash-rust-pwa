---
title: 0013 — Workspace rail view-switch leaves a wrong-kind file on the surface
section: Internal
order: 13
last modified date: 2026-06-01
case_id: CAS_3BCD6727
---

# 0013 — Workspace rail view-switch leaves a wrong-kind file on the surface

**Date:** 2026-06-01 · **Area:** frontend / `frontend/scripts/pages/workspace.js` (Data ↔ Dashboards rail toggle) · **Status:** resolved · **Case:** `CAS_3BCD6727`

## Problem Statement

Em: *"actually, it's CAS_3BCD6727 and it's not done"* — then the concrete symptom: *"if a csv file is selected in Data, switching to the dashboard still show the csv file."*

The Workspace rail has a "Data ↔ Dashboards" segmented toggle (`#wsRailView`). It is supposed to do two things: (a) CSS-filter the rail's file rows to the chosen view kind, and (b) bring the corresponding **surface** forward (`rp-surface`: a data CSV renders the redtable; a chart/dashboard renders the designer canvas). Part (a) worked. Part (b) was incomplete: with a CSV open in Data, toggling to Dashboards left the CSV redtable showing on the surface — a data file lingering under the Dashboards view.

## Troubleshooting steps

1. Grepped `workspace.js` for the view switcher (`mountRailSeg($("#wsRailView"), …)`) and read the `onChange` handler.
2. Found the buggy branch verbatim:
   ```js
   onChange: (view) => {
     nav.dataset.railView = view;
     if (!activeFileRid) return;
     const target = lastFileRidByView[view];
     if (target && target !== activeFileRid) { loadFile(target); }
   },
   ```
   When toggling to Dashboards with no prior dashboard opened, `lastFileRidByView.dashboards` is `null`, so `target` is falsy and the handler **did nothing** — the comment even said "leave the surface as-is." So the CSV redtable stayed on the surface. That is exactly Em's symptom.
3. Mapped the surface state machine. `#wsSurface` has three modes maintained by `loadFile`/`showLanding`: `is-landing-mode` (overview), `is-designer-mode` (chart/dashboard canvas), neither (data redtable). File→view: data files → `data`; charts **and** dashboards → `dashboards`.
4. Found two hazards a naive fix would hit:
   - **Re-entrancy.** `loadFile` mirrors the seg to the file it opened via `maybeAutoToggleRail → setRailView → railViewSeg.set()`, and rail-controls `set()` has **no equality short-circuit** — it always fires `onChange`. A surface-swap in `onChange` would bounce back into `loadFile`.
   - **Stale parallel state.** `activeFileRid` is reset to `null` at ~a dozen sites (delete, project-switch, create flows). Any separate "active view" variable tracking it would drift.
5. Verified the slot writes: the data branch and dashboard branch each set `lastFileRidByView`, but **the two chart branches (`CHT_` + the `file_type === "chart"` fallback) set neither slot** — so a chart, which lives in the Dashboards view, was never remembered for restore.

## RCA

| Aspect | Assumed | Actually true |
|---|---|---|
| The toggle | "Restore the new view's last file, else the user picks from the rail" | "Else" left the **previous view's** file on the surface — a CSV under Dashboards |
| `set()` | Fires `onChange` only on a real value change | Fires on every call, including `loadFile`'s own rail-mirror echo |
| Active-view tracking | A variable mirroring `activeFileRid` would stay in sync | `activeFileRid` clears at ~a dozen sites; a parallel var drifts |
| Chart files | Recorded as a Dashboards-view file | Chart branches recorded **no** restore slot — toggling away then back lost the chart |

Root cause: the `onChange` only ever *added* a file to the surface (when one was remembered) and never *removed* the wrong-kind file that was already there. The surface must reflect the **active view**, so toggling has to evict a file that doesn't belong to the new view even when there's nothing to restore.

## Solution

One file (`frontend/scripts/pages/workspace.js`). Four coordinated changes:

1. **`currentSurfaceView()`** — derives the showing view from the `#wsSurface` mode classes (`is-landing-mode` ⇒ `null`; `is-designer-mode` ⇒ `dashboards`; else a data redtable **iff** `activeFileRid` is set). Single source of truth — immune to the `activeFileRid` reset sites.
2. **`railSyncing` flag + wrapped `setRailView`.** `setRailView` now sets `railSyncing = true` around `railViewSeg.set()`. `onChange` returns early while it's set, so `loadFile`'s rail-mirror echo can't trigger a surface swap. A genuine user **click** on the seg goes straight to rail-controls `set()` (bypassing `setRailView`), so `railSyncing` is false and the swap runs — exactly the path we want.
3. **Rewrote `onChange`:** ignore the echo → if `currentSurfaceView() === view` no-op → else restore `lastFileRidByView[view]` if remembered, **else clear `activeFileRid` and `showLanding()`** so a wrong-kind file never lingers under the new view.
4. **Chart branches record the slot.** Both chart branches now set `lastFileRidByView.dashboards = rid` (a chart renders in the designer canvas = a Dashboards-view file), so toggling Data → Dashboards restores a previously-open chart instead of dropping to the landing.

## Post Checking

Verified live via Playwright MCP against the running dev instance (`:8088`, dev-login session), project `PRJ_D32D474B` (3 CSVs + 2 charts + 2 dashboards). Asserted `#wsSurface` mode + element visibility after each toggle:

1. Open CSV in Data → surface = `data-redtable`, table visible (2 rows). ✓
2. Toggle to Dashboards (no dashboard opened yet) → surface = `landing`; `#wsTable` measured `height:0`, `offsetParent:null` (genuinely hidden, not merely behind the overlay). **CSV no longer shows — the reported symptom.** ✓
3. Toggle back to Data → CSV redtable restored. ✓
4. Open a real dashboard → designer canvas. Toggle to Data → CSV restored. Toggle back to Dashboards → **dashboard** restored (designer), not the CSV and not a stale landing. ✓

No new console errors from the change. (Pre-existing, unrelated: opening a *dashboard* makes the report-builder probe `POST /api/group/preview` → 400 "no underlying data file", logged as a `warn` by design — see the loadFile comments at ~2430. Triggered by opening a dashboard, not by the toggle.)

## The discipline this updates

- **A view toggle must reflect the active view, not just additively restore.** If the surface shows content that doesn't belong to the toggled-to view, *evict* it (restore the right file, else fall back to a neutral surface) — don't leave it as-is.
- **Read "what's showing" from the DOM, not a parallel variable.** When the canonical state (here, `activeFileRid` + the surface mode classes) is mutated at many sites, derive from it; a shadow variable drifts. (Same lesson as runbook 0007's "read positional state from the DOM.")
- **A control that fires its change handler on every `set()` (no equality short-circuit) needs a re-entrancy guard** when the handler can call back into code that calls `set()`. The `railSyncing` flag is that guard; the genuine-user-click path deliberately bypasses it.
- **When a kind has multiple representations (chart + dashboard both ⇒ Dashboards view), every branch that opens one must update the shared per-view memory** — a missed branch is a silent restore gap.

## Linked

- The fix — `frontend/scripts/pages/workspace.js` (atomic doc: [workspace.md](../code/frontend/scripts/pages/workspace.md), drift note "Rail view-switch swaps the main surface").
- The seg primitive — `frontend/scripts/rail-controls.js` (`set()` has no equality short-circuit — the re-entrancy source).
- The cadence this runbook codifies — [bug-case-runbook-cadence.md](../processes/bug-case-runbook-cadence.md).
- **Case ID:** `CAS_3BCD6727`.
