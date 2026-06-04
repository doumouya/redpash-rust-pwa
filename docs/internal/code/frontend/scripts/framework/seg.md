---
title: frontend/scripts/framework/seg.js
source: ../../../../../../frontend/scripts/framework/seg.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/seg.js — segmented control

## Purpose

The JS builder the `rp-seg` CSS atom lacked (form-control set, CAS_37B2E1BF).
`mountSeg` renders a 2+-option pill switcher with single-select + `onChange` —
replacing the hand-rolled `.rt-btn` preference clusters across Settings, and
folding On/Off toggles in as a 2-option seg (no separate toggle atom). CSS is
owned by `styles/framework/seg.css` (Torv-A's B3.0 atom: `rp-seg` base + `--rail`);
this module is behaviour only and does not edit that sheet.

## Public surface

- `mountSeg(host, { options:[{value,label?,icon?,title?}], value?, variant?, ariaLabel?, onChange? })`
  → `{ el, get(), set(v) }`. `host` becomes the `.rp-seg` track. Self-registers as `"seg"`.

## How it works

One DOM build (a `<button data-seg=…>` per option, `aria-pressed="true"` on the
current — no `is-active` class, per the locked one-class convention), a delegated
click that flips the pressed state + calls `onChange(value)`, and `set(v)` to
drive it programmatically. Every option field is `esc()`'d.

The active pill keys off `aria-pressed="true"`. `seg.css` carries a **transitional
dual selector** (`.rp-seg button.is-active, …[aria-pressed="true"]`) because the
still-class-based live consumers (`mountRailSeg` in `rail-controls.js`; the
filter-panel AND/OR combo) sync `.is-active`; `.is-active` drops once they migrate
to `aria-pressed` (the seg/rail cascade).

## Drift-prone areas

- **`seg.css` is transitional — don't drop the `.is-active` arm.** `mountSeg` sets only
  `aria-pressed`, but the active rule is a dual selector
  (`.rp-seg button.is-active, …[aria-pressed="true"]`) because the live class-based
  consumers (`mountRailSeg` in `rail-controls.js`; the filter-panel AND/OR combo) still
  sync `.is-active`. Removing that arm before they migrate orphans every live switcher's
  active fill.
- **Two seg builders coexist.** `mountSeg` (this module, aria-based) vs the class-agnostic
  `mountRailSeg` (`rail-controls.js`, `.is-active`-based, the live path); they share
  `seg.css`, so any change to the active rule must satisfy both.
- **`variant` builds `rp-seg--<variant>` dynamically** (`--rail` / `--combo` live in
  `seg.css`, shared with the class-based consumers) — those stay container-variant
  modifier classes for now, not `data-variant`.

## Related

- `styles/framework/seg.css` (the atom) · [field](field.md) (wraps it) · [select](select.md) (sibling for long option sets) · [component-registry](component-registry.md).
- Consumers: Settings prefs (theme/density/rows-per-page/etc.), view switchers.
