---
title: frontend/scripts/framework/select.js
source: ../../../../../../frontend/scripts/framework/select.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/select.js — form dropdown select

## Purpose

A single-value form select for option sets too long for a `seg` (e.g. the 9-option
CSV encoding pref) — built on the `rp-menu` dropdown (form-control set, CAS_37B2E1BF).
JS-only: composes `menu.js` + the `rp-btn` atom; no new CSS.

## Public surface

- `mountSelect(host, { options:[{value,label?,icon?}], value?, id?, triggerClass?, onChange? })`
  → `{ el, get(), set(v) }`. Self-registers as `"select"`.

## How it works

`mountMenu` builds the trigger (current option's label + a chevron) + the option
panel; a delegated panel click sets the value, updates the trigger label + the
`.selected` item, and fires `onChange(value)`. Labels `esc()`'d by mountMenu + here.

## Related

- [menu](menu.md) (the dropdown it wraps) · [seg](seg.md) (sibling for short option sets) · [field](field.md) (wraps it) · [component-registry](component-registry.md).
