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

One DOM build (a `<button data-seg=…>` per option, `.is-active` on the current),
a delegated click that flips active + calls `onChange(value)`, and `set(v)` to drive
it programmatically. Every option field is `esc()`'d.

## Related

- `styles/framework/seg.css` (the atom) · [field](field.md) (wraps it) · [select](select.md) (sibling for long option sets) · [component-registry](component-registry.md).
- Consumers: Settings prefs (theme/density/rows-per-page/etc.), view switchers.
