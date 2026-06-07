---
title: frontend/scripts/prefs/controls/theme-swatch.js
source: ../../../../../../frontend/scripts/prefs/controls/theme-swatch.js
owner: Torv
section: Internal · Code · Frontend · scripts/prefs/controls
last modified date: 2026-06-07
---

# theme-swatch.js

## Purpose

Settings v2 control renderer — handles the `theme-swatch` control
type. It is the **GENERAL · Appearance > Theme** picker: a grid of
cards, one per theme, each a **live mini-preview of its own palette**
(bg field + accent bar + lifted surface + accent dot) plus the theme
name and a selected check. Clicking a card applies that theme app-wide,
live.

Replaces the old `onoff` dark↔light toggle for `general-theme`. The
toggle could only ever surface two options even though the pref's
`values` enum allows all four named themes (Catppuccin Mocha/Latte +
New Dark / New Light, the 2026-06-05 design-language identity). The
swatch picker surfaces all four, each previewing its real colours.

Same `{ render, postMount }` module shape as
[`chart-layouts.js`](chart-layouts.md), so `settings.js`'s CONTROLS
dispatcher drives it identically.

## Public surface

- `render(spec)` — returns the mount-slot HTML string (a `mountRow`
  shell). Called by the `settings.js` CONTROLS dispatcher during
  `renderFromRegistry`. The grid paints into the slot post-mount.
- `postMount(app, spec)` — paints the swatch grid into the slot.
  Iterates `spec.options` (the 4 themes from the `general-theme`
  registration). Reads the current selection via `currentTheme()`
  (theme.js) and writes via `applyTheme(value)` so the whole app
  re-themes live on click. One delegated click handler on the slot
  root moves the `aria-checked` selection.

## How the live per-theme preview works

Each card's preview element carries `data-rp-theme="<value>"`. tokens.css
keys every palette block on BOTH `html[data-theme="X"]` (the document
theme) AND a scoped `[data-rp-theme="X"]` alias, so the preview's
`var(--rp-bg)` / `--rp-surface` / `--rp-accent` resolve to **that card's
theme**, regardless of which theme the document is on. One source of
truth — the control duplicates no palette values; adding/retuning a
theme is a tokens.css edit, never a change here.

## How it fits the CONTROLS dispatcher

`settings.js` wires it as:

```js
import * as themeSwatch from "/scripts/prefs/controls/theme-swatch.js";
const CONTROLS = {
  onoff:           { render: prefRowFromSpec },
  segmented:       { render: prefRowFromSpec },
  "chart-layouts": chartLayouts,
  "theme-swatch":  themeSwatch,   // exports render + postMount
};
```

`renderFromRegistry` calls `ctrl.render(spec)` to gather row HTML;
after the rows land, `callPostMountHooks` iterates the registry once
more and fires each spec's `ctrl.postMount(app, spec)`.

The swatch cards live in a `mountRow` (no `[data-pref]` ancestor), so
the page-level `[data-value]`→`[data-pref]` click delegation in
`settings.js` ignores them — the control's own handler is the sole
driver, exactly like chart-layouts' internal buttons.

## Drift-prone areas

- **Options drive the grid** — `general-theme`'s `options` array in
  prefs.js is the source of which cards appear (value + label). The
  control adds nothing per-theme; a 5th theme is a tokens.css block +
  one `options` entry.
- **Selection state is `aria-checked`** (radiogroup/radio roles), not
  the `.is-active` class the prefRow groups use — self-contained, set
  in `postMount` from `currentTheme()` and moved on click. The page's
  general-theme `paint()` path no longer applies (no `[data-pref]`
  group for the theme pref once the control is `theme-swatch`).
- **Write path is `applyTheme`** (theme.js), not a bare
  `setPref` — `applyTheme` is the canonical theme setter (validates
  against the enum, reflects `html[data-theme]`, write-throughs to
  `/me/prefs`, clears the legacy `theme` alias).
- **Default is New Dark** (prefs.js `general-theme` default +
  index.html pre-paint + theme.js `applyTheme`/`toggleTheme`
  fallbacks). Changing the default means updating all of those in
  lockstep.

## Related

- [Frontend pillar landing](../../../../index.md)
- [`prefs.js`](../../prefs.md) — the registry; owns the `general-theme`
  spec (`control: "theme-swatch"`, the 4 `options`, `default:
  "new-dark"`).
- [`theme.js`](../../theme.md) — `applyTheme` / `currentTheme` /
  `toggleTheme` (the latter now family-aware).
- [`pages/settings.js`](../../pages/settings.md) — the CONTROLS
  dispatcher that wires this module.
- [`chart-layouts.js`](chart-layouts.md) — the sibling deferred-mount
  control this mirrors.
