---
title: frontend/scripts/framework/field.js
source: ../../../../../../frontend/scripts/framework/field.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-05
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
- `mountFieldEditable(host, { label?, value?, placeholder?, edit? })` → `{ el, set, value }`.
  The inline-editable variant: the control is a click-to-edit **value button**; clicking
  (Enter / Space) enters edit mode and hands the control slot to the caller's
  `edit(slot, commit, cancel)` (mount a `select` / `menu` / user-picker), and `commit(v)`
  writes the value back + returns to view mode. Sets `data-variant="editable"` (and
  `data-editing` while open). Self-registers as `"field-editable"`. De-cased from the
  Cases sidebar's inline-editable property rows so any record view reuses the pattern.

## How it works

Renders `.rp-field-main` (label + hint, both `esc()`'d) + a `.rp-field-control` slot,
then calls `mount(slot)` so the row composes any control without knowing it. The
configure-by-example Settings pairs each field's control with a live preview in the
same row.

`stack:true` sets the container-independent variant via `data-variant="stack"` (one
attribute on the single `rp-field` class, per the locked one-class convention) — CSS
keys off `.rp-field[data-variant="stack"]`, no modifier class.

## Drift-prone areas

- **`stack` ↔ selector pairing.** The full-width layout is `data-variant="stack"` (one
  attribute on the single `rp-field` class), keyed by `.rp-field[data-variant="stack"]`
  in `field.css`. The JS attribute and the CSS selector move together — renaming one
  side orphans the stacked layout.
- **The control is opaque.** `mount(slot)` / `html` fills the slot; the field never
  styles the control. The sub-element classes (`rp-field-main` / `-label` / `-hint` /
  `-control`) are structural children, not variants — don't add state classes here.

## Related

- `styles/framework/field.css` · [seg](seg.md) · [select](select.md) · [badge](badge.md) · [component-registry](component-registry.md).
