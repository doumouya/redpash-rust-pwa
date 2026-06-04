---
title: frontend/scripts/framework/panel.js
source: ../../../../../../frontend/scripts/framework/panel.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/panel.js — Panel shell component

## Purpose

The side-panel **shell** shared by the filter / tools / history panels inside a
surface: an `<aside>` that slides open from 0 width, with a **head** (a single
title OR a tab strip, plus a close button) and a scrolling **body** (+ optional
**foot**). It is **generic + data-driven** — `mountPanel(host, config)` emits the
entire `rp-panel-*` structure and wires open/close + tab-switch; the
filter / tools panels mount **their** content INTO the returned `body` later
(the "lego brick"). Part of the framework extraction (CAS_37B2E1BF); the
consolidation of the per-page `rt-panel-*` panels the live app hand-builds.

## Public surface

- `mountPanel(host, config)` → `{ el, head, body, foot, close, setTab(id), setOpen(open) }`.
  `host` becomes the `.rp-panel` aside. Self-registers as `"panel"`. ESM;
  composes the `rp-btn-icon` atom (close) and `esc`. The caller mounts content
  into `body` (and `foot` when `foot:true`), calls `setOpen(bool)` to slide it
  open/closed, and `setTab(id)` to drive the active tab from outside.

### Config (every field optional)

| key | shape | renders |
|---|---|---|
| `variant` | `"filter"\|"tools"\|"history"\|string` | `rp-panel-<variant>` (border side + width) |
| `title` / `titleIcon` | string / `bi-*` | single `rp-panel-title` head (+ leading icon) |
| `tabs` | `[{id,label,icon,active}]` | `rp-panel-tabs` strip (replaces the title) |
| `pills` | bool | tabs render as the pill switcher (`rp-panel-tabs-pills`) |
| `foot` | bool | emit an empty `rp-panel-foot` the caller fills |
| `onClose` | fn | close button click |
| `onTab` | `(id) => void` | tab click (after `is-active` is updated) |

The head is **either** a single title **or** a tab strip — supply `tabs` for the
strip (filter / tools), `title` for the text (history).

## How it works

- **Shell + slide**: `host` is the `.rp-panel`; `.open` toggles the width
  transition. `variant` picks the docked border side and the wide (35vw) width
  classes (`-filter` / `-tools` / `-history`), matching the legacy `--filter` /
  `--tools` / `--history` modifiers.
- **Head is one of two shapes**: a `rp-panel-title` (history-style) **or** a
  `rp-panel-tabs` strip (filter/tools). The close button always renders; it
  composes the `rp-btn-icon` atom for its shape and `rp-panel-close` only
  **positions** it (absolute, right-of-strip) inside a pill-tab head.
- **Tab switching** is delegated on the strip: a click updates `is-active`
  across the strip (`setTab`) then calls `onTab(id)`; the caller toggles its own
  `rp-panel-tab` / `rp-panel-tab-foot` bodies (those `[hidden]` to `display:none`).
- All dynamic content is escaped via `esc()` — the same XSS-safe pattern as
  [rail.js](rail.md); no new surface. The shell holds no untrusted markup.

## Drift-prone areas

- **Close is `rp-btn-icon`, not `--sq`.** The legacy `.rt-panel-close` carried
  `.rt-btn` (the 2rem padded pill = `rp-btn-icon` verbatim), **not** the 1.75rem
  square `.rt-icon-btn`. Composing `--sq` would silently shrink it. The atom owns
  the shape; this component only repositions it.
- **De-BEM**: legacy `.rt-panel-tabs--pills` becomes `.rp-panel-tabs-pills`
  (single hyphen) — it's a sub-variant of the tabs sub-part, not a true atom
  modifier, so no `--`.
- **Body content lives elsewhere.** The filter groups, report builder, step-history
  rows, and tools surfaces mount INTO `body` from their own components; the shell
  ships them no markup. `rp-panel-sect` / the `rp-label:first-child` reset are the
  only body-content hooks this sheet keeps.
- **Designer-mode hide** (`.rp-surface.is-designer-mode .rp-panel-*`) is ported
  from `chart.css` into the panel sheet as the rule's only home; the integrator
  scopes it at page composition (it's page behavior, not shell shape).
- **Cutover pending**: live workspace still hand-builds `rt-panel-*` panels in
  `partials/workspace.html` + `scripts/pages/workspace.js`. At cutover they become
  `mountPanel` config-suppliers; until then the framework twin coexists.

## Related

- [framework/panel.css](../../../styles/framework/panel.md) — the panel shell CSS (ported from `panel.css` + the `chart.css` designer-mode hide).
- [framework/atoms.css](../../../styles/framework/atoms.md) — `rp-btn-icon` (close), `rp-label`, `rp-btn`.
- [framework/rail.js](rail.md) — sibling shell component; same `register` + `esc` pattern.
- [component-registry](component-registry.md) · [framework index](index.md).
