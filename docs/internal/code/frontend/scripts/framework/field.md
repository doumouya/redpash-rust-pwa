---
title: frontend/scripts/framework/field.js
source: ../../../../../../frontend/scripts/framework/field.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/field.js — labeled field row

## Purpose

The labeled row that wraps any control (seg / select / rp-input / badge / a custom
preview) with a label + optional hint — generalizing the page-local `page-row.js`
into ONE framework row for Profile + Settings + any form (form-control set,
CAS_37B2E1BF). CSS: `styles/framework/field.css`.

## Public surface

- `mountField(host, { label?, hint?, stack?, mount?, html? })` → `{ el, control }`.
  `host` becomes the `.rp-field`; `mount(slot)` fills the control slot (compose any
  component), or `html` for a static control string; `stack:true` puts a full-width
  control below the label (text inputs / previews). Self-registers as `"field"`.

## How it works

Renders `.rp-field-main` (label + hint, both `esc()`'d) + a `.rp-field-control` slot,
then calls `mount(slot)` so the row composes any control without knowing it. The
configure-by-example Settings pairs each field's control with a live preview in the
same row.

## Related

- `styles/framework/field.css` · [seg](seg.md) · [select](select.md) · [badge](badge.md) · [component-registry](component-registry.md).
