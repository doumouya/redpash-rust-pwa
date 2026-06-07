---
title: 0019 — Workspace Dashboards path stripped (Slice D / D2) — designer + view-toggle removed, CAS_3BCD6727 deleted structurally
date: 2026-06-07
case: CAS_3BCD6727
area: frontend/scripts/pages/workspace.js + partials/workspace.html + pages/dashboard.js + framework/rail.css
---

# 0019 — Workspace becomes a pure data-redtable (Dashboards path stripped)

## Context

The multi-app split (Studio = Workspace · Dashboard · SheetWise) gave the chart/dashboard
designer its own page, `#/dashboard` (Slice D / **D1**, commits `366e2aa` / `7fbc5e5` /
`a6caae9`). Until now Workspace still crammed **both** surfaces into one page via a
**Data↔Dashboards rail-view toggle** (`#wsRailView`) that swapped `#wsSurface` between the
data redtable and an in-page designer. **D2** removes that second half.

## What changed (a deletion, ~515 lines)

`frontend/scripts/pages/workspace.js`:
- Removed the rail-view seg mount + `currentSurfaceView` / `railSyncing` / `lastFileRidByView`
  / `setRailView` / `maybeAutoToggleRail` and the `WS_CREATE`/`syncWsCreateButton` adapter.
- Removed the designer: the `mountDesigner` import + mount block, `#wsDesignerCfgToggle` /
  `#wsDesignerAddChart` handlers, `enterDesignerMode` / `exitDesignerMode` (the
  `.is-designer-mode` swap), and the dead `is-designer-mode` removal in `showLanding`.
- Removed every chart/dashboard flow: `createChart` / `createDashboard` /
  `addChartToOpenDashboard` / `promoteChartToDashboard` / `chartAsDashboard` /
  `ensureSourceCache` / `ensureProjectSourceFiles` + the `sourceCache` / `projectSourceFiles`
  / `designerCtrl` state and the now-dead `activeProjectRid`.
- `loadFile`: dropped the `CHT_` branch and the `file_type` chart/dashboard branches. A
  chart/dashboard rid now **redirects to `#/dashboard`** (a deep-link safety guard — the rail
  itself filters charts/dashboards out, so this only fires for an external
  `#/workspace?file=…` deep-link). The CSV path is unchanged minus its designer teardown.
- `renderFiles` filters the rail to **data files only** (`file_type ∉ {chart, dashboard}`) so
  the rail + `syncGroupCount` reflect CSVs only.
- **Per-row Visualize:** `fileTab` gained a `.rp-rail-tab-visualize` chart glyph; the navBody
  delegator short-circuits its click (before the generic tab→`loadFile` branch) to
  `location.hash = "#/dashboard?source=" + rid`.
- Rail-foot button repurposed to **New Project** (`#wsNewProject`, glass CTA); the redundant
  rail-head plus-button was removed. (Em 2026-06-07: "the New chart button in the rail-foot
  becomes New Project"; per-row chart icon is the WS→Dashboard bridge.)

`frontend/partials/workspace.html`: removed `#wsRailView`, the `.rp-dash-toolbar` block, and
the `#wsDesigner` shell; head plus-button removed; foot button → `#wsNewProject`.

`frontend/scripts/pages/dashboard.js` (additive): on init, parse `?source=<FIL_rid>` from
`location.hash`, resolve the file's project, focus its rail group, and pre-pick the CSV as
the chart source (`setSource`). Router tolerates the suffix (`main.js:69` splits on `?`).

`frontend/styles/framework/rail.css`: added the `.rp-rail-tab-visualize` atom (mirrors
`.rp-rail-tab-rename`; `--rp-info` on hover = navigation, distinct from the destructive ×).

## Why this closes CAS_3BCD6727 (re-entrancy) structurally

The [CAS_3BCD6727](CAS_3BCD6727-workspace-rail-view-surface-swap.md) bug was a re-entrancy in
the view-toggle's surface swap (a `set()` echo bouncing back into another swap, guarded by the
`railSyncing` flag + `currentSurfaceView()` DOM-derivation). **D2 removes the toggle and the
opposite-view surface entirely** — there is nothing to swap to and no echo to guard, so the
bug class cannot occur. The fix is the page split, not a patch. This runbook supersedes the
CAS_3BCD6727 runbook for the live code (that runbook stays as the historical record of the
in-page-toggle era).

## Verify

- `node --check frontend/scripts/pages/workspace.js` + `…/dashboard.js` → OK.
- `grep` workspace.js for the deleted symbols (`railSyncing`/`setRailView`/`designerCtrl`/
  `sourceCache`/`createChart`/…/`is-designer-mode`/`wsDesigner`/`wsRailView`) → zero (only
  truthful comments remain).
- `node tools/page-verify/verify.js --pages home,workspace,dashboard,sheetwise,cases,monitoring,admin-console,database,profile,settings,docs --themes catppuccin-mocha,catppuccin-latte,new-dark,new-light` → console-clean, working rail on every page; eyeball the shots.
- `sh tools/audit.sh` → retired-class / uniformity / doc-coverage / class-count clean.
- Live (dev-login, HARD reload): Workspace shows data files only, redtable + data toolbar,
  **no view-seg / no designer toolbar / no `is-designer-mode`**; per-row chart glyph →
  `#/dashboard` with the CSV pre-picked; rail-foot New Project creates + expands a group;
  deep-link a chart rid to `#/workspace` → redirects to `#/dashboard`; an existing multi-tile
  dashboard still opens on `#/dashboard` (D1 intact).
