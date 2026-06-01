---
title: frontend/scripts/pages/settings.js
source: ../../../../../frontend/scripts/pages/settings.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-01
---

# settings.js

## Purpose

Settings page — app preferences. **Settings v2 (2026-06-01,
CAS_55984AC7):** the page renders by iterating the OPEN PREF REGISTRY
in `prefs.js`. Each registered spec carries its `section` /
`control` / `label` / `hint` / `options`; `renderFromRegistry()`
buckets specs by section, dispatches each through a CONTROLS map to
the matching `page-row.js` helper, then appends non-pref rows from
`SECTION_EXTRAS`. The hand-written `SETTINGS_ROWS` tree is gone.

## Public surface

- Default export: `settings(app, { session })` — page mount.
- Reads / writes via `prefs.js` (`getPref` / `setPref` / `eachPref`
  for iteration).
- Charts management section per-tab via the chart-picker (Slice
  D/D2); the picker stays as inline code today and moves into a
  `chart-layouts` control renderer in step 4 of the Settings v2
  rollout.

## How the registry drives rendering

```js
function renderFromRegistry(app) {
  const rowsBySection = {};
  eachPref((spec) => {
    if (!spec.section) return;
    const renderer = CONTROLS[spec.control];
    if (!renderer)   return;
    (rowsBySection[spec.section] ||= []).push(renderer(spec));
  });
  for (const [section, extras] of Object.entries(SECTION_EXTRAS)) {
    (rowsBySection[section] ||= []).push(...extras);
  }
  // mount each section's HTML into [data-rp-rows="<short-key>"]
}
```

Spec → row dispatch:

- `control: "onoff"` / `"segmented"` → `prefRow` (button-group).
- `control: "chart-layouts"` → step 4.
- Specs without `section` skip rendering (e.g. `workspaceRailView`,
  `casesDoneWindow` — read by their page but not surfaced as a
  Settings row).

## Section EXTRAS

Non-pref rows kept inline (one section → array of HTML strings):

- `set-cleaner` — sentinels `mountRow` + `share_sentinels` `prefRow`
  (server-passthrough; boolean coerced from data-value at click time).
- `set-monitoring-charts` / `set-home-charts` — chart-picker mount
  slots; the panel body paints via `mountChartPickerPanel`.
- `set-account` — `display_name` + `username` valueRows + signout
  actionsRow; filled from session at mount time.
- `set-cases` — stub placeholder (CAS_3FC70F56); replaced by Cases
  prefs in step 6.
- `set-about` — brand row with Docs / Vision / Getting started links.

## Drift-prone areas

- **Adding a pref → one `registerPref()` call in `prefs.js`** (or the
  per-page module landing in step 6). Settings page auto-renders;
  zero edits here.
- **Adding a non-pref row → `SECTION_EXTRAS` entry**, keyed by the
  rail tab id (`set-*`).
- **Rail grouped by PAGE, not by ABILITY** (2026-05-31, CAS_3FC70F56):
  `SET_GROUPS` are GENERAL / HOME / WORKSPACE / CASES / MONITORING.
  `SET_TABS` assigns each section to its owning page (e.g. `set-tables`
  under WORKSPACE because rows-per-page-Workspace is the dominant row
  there; the per-surface rows-per-page split stays). Section IDs
  (`set-*`) preserved across the regroup so deep-links + pref keys
  stay valid.
- **Section ↔ mount-key map** — `SECTION_MOUNT_KEY` bridges
  `set-monitoring-charts` (rail tab id, spec.section) →
  `monitoringCharts` (HTML `[data-rp-rows]` slot). If a new section
  lands, add the partial slot + the map entry.
- **Chart-picker still uses inline code** — moves into
  `prefs/controls/chart-layouts.js` in step 4. Until then, the picker
  reads the `monitoringCharts` / `homeCharts` prefs directly and
  paints into `#rp-settings-mon-charts` / `#rp-settings-home-charts`.
- **`SETTINGS_ROWS` removed** — old code that read it externally
  would fail (no callers found as of 2026-06-01).

## Settings v2 rollout reference

This module is step 2 of the 7-step Settings v2 plan (Em-approved
2026-06-01, plan file `~/.claude/plans/transient-dazzling-conway.md`).
Step 3 adds search + tag chips on top of the registry; step 4 moves
the chart picker into a control renderer; step 5 lands Hidden Items
under GENERAL; step 6 registers 26 candidate prefs across Home /
Workspace / Cases with `migrateFrom` aliases + flips read-sites; step
7 ships the server-side SQL backfill.

## Related

- [Frontend pillar landing](../../../index.md)
- [`prefs.js`](../prefs.md) — the registry this page renders from.
- [`page-row.js`](../page-row.md) — `prefRow` / `valueRow` /
  `actionsRow` / `mountRow` helpers reused unchanged.
- [Settings v2 plan](~/.claude/plans/transient-dazzling-conway.md) —
  the 7-step rollout.
