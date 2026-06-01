---
title: frontend/scripts/prefs/controls/chart-layouts.js
source: ../../../../../../frontend/scripts/prefs/controls/chart-layouts.js
owner: Torv
section: Internal · Code · Frontend · scripts/prefs/controls
last modified date: 2026-06-01
---

# chart-layouts.js

## Purpose

Settings v2 control renderer — handles the `chart-layouts` control
type for any registered pref. Surfaces the per-tab chart picker
(Slice D / D2) for `monitoringCharts` and `homeCharts`; future
surfaces (e.g. Workspace dashboards) plug in by registering a third
spec with `control: "chart-layouts"` + a `surface` key + a
`SURFACE_CFG` entry. Settings.js never changes.

Moved verbatim out of `pages/settings.js` in Settings v2 step 4
(CAS_55984AC7). The picker behavior is unchanged from the inline
version — tab row + chart list (defaults vs customised) + Add /
Reset buttons + the add-chart modal (preview + builder).

## Public surface

- `render(spec)` — returns the mount-slot HTML string. Called by the
  `settings.js` CONTROLS dispatcher during `renderFromRegistry`.
  Produces a `mountRow` shell that the picker paints into post-mount.
- `postMount(app, spec)` — paints the picker into its slot. Called
  by `callPostMountHooks` in `settings.js` after the registry-driven
  render lays down the rows. Reads + writes the pref via `spec.key`
  (`getPref` / `setPref` from prefs.js).

Both functions read the per-surface cfg from `SURFACE_CFG[spec.surface]`
(internal map, keyed by spec field). Missing surface = silent no-op
(spec stays in the registry but renders nothing — disposable).

## Per-surface cfg

```js
SURFACE_CFG = {
  monitoring: { rootId, schema, defaults, newTemplate, labels, surfaceLabel },
  home:       { rootId, schema, defaults, newTemplate, labels, surfaceLabel },
}
```

- `rootId` — DOM id of the mount slot (mountRow stamps it; postMount
  queries it).
- `schema` — per-tab field schema (drives the field picker in the
  Add-chart modal's builder). Sources: `monitoring-bank.js`,
  `home-bank.js`.
- `defaults` — curated per-tab default chart arrays. Surface when the
  user hasn't customised that tab yet.
- `newTemplate(tabKey)` — starter spec for "Add chart" (preview +
  builder receive the same mutable object).
- `labels` — human labels for the tab row (fallback is the raw tab
  key).
- `surfaceLabel` — passed to the modal title + Add button ("Add to
  Monitoring" / "Add to Home").

Pref keys come from the registered spec (`spec.key`), not duplicated
into the cfg.

## How it fits the CONTROLS dispatcher

Settings.js wires it as:

```js
import * as chartLayouts from "/scripts/prefs/controls/chart-layouts.js";
const CONTROLS = {
  onoff:           { render: prefRowFromSpec },
  segmented:       { render: prefRowFromSpec },
  "chart-layouts": chartLayouts,   // exports render + postMount
};
```

`renderFromRegistry` calls `ctrl.render(spec)` to gather row HTML;
after `mount.innerHTML` lands, `callPostMountHooks` iterates the
registry once more and fires each spec's `ctrl.postMount(app, spec)`
where present. The picker's stateful behavior (tab toggle, add /
remove chart, reset to defaults) lives entirely inside postMount's
closure.

## Drift-prone areas

- **Per-surface cfg is open-ended** per [[data-format-open-ended]] —
  adding a new surface = one `registerPref` call (`surface: "X"`)
  in the per-page module + one `SURFACE_CFG.X` entry here. No edit
  to `settings.js` and no edit to `prefs.js`'s core API.
- **Pref shape is `{ <tabKey>: chart[] }`** — when the user hasn't
  customised, the slot is missing from the object and the picker
  surfaces the curated defaults. First Add promotes the defaults
  to the user list so the user starts from "defaults + mine," not
  "blank + mine".
- **Add-chart modal stays a real DOM modal** (overlay backdrop +
  centered card, body-mounted). Esc + backdrop click + close button
  + Cancel button all dismiss; Add persists via the `onAdd(spec)`
  callback.
- **Live preview uses a generation token** so rapid `cfg` changes
  can't leak stale ECharts instances as the live `previewInst`.
- **schemaPaths** is derived from `schema.fields[*].path` —
  monitoring-bank + home-bank define the schema; if a future bank
  uses a different shape, extend the picker's getSource call.

## Settings v2 rollout reference

Step 4 of the 7-step plan
(`~/.claude/plans/transient-dazzling-conway.md`). Steps 1-3 built
the open registry + registry-driven render + search affordance this
module plugs into. Steps 5 (Hidden Items tab), 6 (26 new prefs +
read-site cutover + rail-view auto-toggle), 7 (SQL backfill) extend
the same pattern.

## Related

- [Frontend pillar landing](../../../../index.md)
- [`prefs.js`](../../prefs.md) — the registry whose specs this
  module renders.
- [`pages/settings.js`](../../pages/settings.md) — the CONTROLS
  dispatcher that wires this module.
- [Settings v2 plan](~/.claude/plans/transient-dazzling-conway.md).
