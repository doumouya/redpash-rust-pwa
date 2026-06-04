---
title: frontend/scripts/framework/settings-config.js
source: ../../../../../../frontend/scripts/framework/settings-config.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/settings-config.js — Settings configure-by-example

## Purpose

Em's Settings reframe (CAS_37B2E1BF): Settings is preferences on elements already
in the UI, so **pair each preference's control with a LIVE preview of the exact
component it controls** — change the control, watch the real thing change. Turns
abstract toggles into a "this setting changes THIS" showcase and a reuse demo.
CSS glue: `styles/framework/settings-config.css`.

## Public surface

- `mountSettingsConfig(host, opts)` → `{ el }`. Self-registers as `"settings-config"`.
  Renders the configure-by-example rows into `host` (the page frame's surface).

## How it works (all reuse)

Each row (`.rp-settings-config-row`) is `[label + hint + control] | [live preview]`,
where the control is a form-control and the preview is a reused component the
control drives via `onChange`:

- **Theme** (`seg`) → a sample `.rp-surface` card (`rp-btn`/`rp-chip`/`rp-badge` — the
  badge's accent tone via `data-variant="accent"`) whose `data-theme` flips live.
- **Default chart kind** (`seg`) → a real `chart` tile; `onChange` calls its
  `setOption(chartOption(kind))` so the chart morphs bar↔line↔pie.
- **Rows per page** (`select`) → a `table` re-rendered to N rows.
- **Show row numbers** (`seg`) → the `redtable` re-rendered with the rownum column on/off.

Render-first proof of the PATTERN; the live cutover folds the full `prefs.js` registry +
persistence into this shape (each `onChange` writes the pref). `set-account` is dropped
from Settings (account identity lives on the Profile record — the dedup).

## SECURITY

Labels/hints `esc()`'d; the sample card markup is static; the chart `option` goes to
`setOption()` (never interpolated into HTML).

## Drift-prone areas

- **The Theme preview is a hand-written demo string.** Its badge uses
  `data-variant="accent"` (matching the converted `rp-badge` atom). The `rp-chip
  is-active` in the same string is left as-is on purpose — `rp-chip`'s active state
  still keys `.rp-chip.is-active`, so converting it now would orphan the fill; it
  migrates with the chip-row lane.
- **Previews resolve components by registry name** (`get("seg" / "select" / "chart" /
  "table" / "redtable")`). Renaming or failing to register any of those silently drops
  that row's preview — the row renders its control beside an empty preview pane.
- Render-first proof: the `onChange`s drive the previews, not persistence. The live
  cutover wires them to `prefs.js`; until then no pref is written.

## Related

- [seg](seg.md) · [select](select.md) · [field](field.md) · [chart](chart.md) · [table](table.md) · [redtable](redtable.md) · [page-assembly](page-assembly.md) (the `mount` hook fills the surface).
- Plan §4: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` · brief: `docs/profile-settings-rebuild.md` · live prefs: `frontend/scripts/prefs.js`.
