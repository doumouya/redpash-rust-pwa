---
title: frontend/styles/framework/seg.css
source: ../../../../../../frontend/styles/framework/seg.css
owner: Torv
section: Internal · Code · Frontend · styles · framework
last modified date: 2026-06-04
---

# framework/seg.css — Segmented toggle atom (rp-seg)

## Purpose

The **segmented toggle** — a 2+-option pill switcher. A content-sized
`inline-flex` track holding flat buttons; the `.is-active` button gets a raised
surface fill so it reads as the selected segment. Part of the framework atom
extraction (CAS_37B2E1BF); ported **verbatim** from the legacy `.rt-seg` family
(`styles/panel.css`) — only the selector is renamed, so the cutover is a
zero-visual-change diff.

**CSS-only atom — no JS builder.** The behavior lives in the existing
class-agnostic `mountRailSeg()` ([rail-controls.js](../../scripts/rail-controls.md)),
which keys off `data-rail-seg` on the buttons + the passed element (not class
names): it click→persist→syncs `.is-active` and seeds from a pref. Consumers
mount that helper directly against an `.rp-seg` element — the CSS and the
behavior are decoupled.

## Public surface

| selector | role |
|---|---|
| `.rp-seg` | base track — `inline-flex`, sized to content (~6rem) |
| `.rp-seg button` | a flat segment (transparent, dim text) |
| `.rp-seg button.is-active` | the selected segment (raised `--rp-surface` fill, bold) |
| `.rp-seg--rail` | variant — full-width (`flex; width:100%`) for a narrow side rail |
| `.rp-seg--rail button` | equal-flex icon+label segment, tighter type |
| `.rp-seg--rail button i` | the leading icon (0.75rem) |

Composes **no other atom** — it is itself a foundation atom. `--rail` is a true
atom variant (`--`), matching the `atoms.css` convention (`--` for variants,
single-hyphen for sub-parts).

## How it works

- **Active state is class-driven** (`.is-active`), not `:checked`/radio — the
  paired `mountRailSeg()` toggles `.is-active` on the button whose
  `data-rail-seg` matches the current value. The atom only paints; the helper
  owns the value/persistence.
- **Base vs `--rail`**: the base is content-sized (the AND/OR filter toggle, the
  workspace filter-card combo). `--rail` stretches to the full rail width with
  two equal icon+label pills (Cases Internal/External, Workspace
  Data/Dashboards). Pages add only a placement `margin` on top in their own
  sheet — never the shape.

## Drift-prone areas

- **`.rp-rail-views` carries its own copy.** The committed framework rail
  ([rail.css](rail.md)) **inlined** the merged `rt-seg + rt-seg--rail` styling
  into `.rp-rail-views` (full-width, icon+label, `display:none` on collapse). Do
  **not** try to reconcile the two now — `rp-seg` is the standalone atom for the
  cases source-switcher + the filter AND/OR toggle. A **future cleanup** could
  have `.rp-rail-views` compose `.rp-seg --rail` instead of duplicating it; that
  is deferred (don't disturb the committed rail).
- **`.rt-group-card-combo`** (panel.css, workspace filter builder) is a
  **consumer composition** of the base `.rt-seg`, not part of this atom — it
  overrides width to 60% + equal-flex buttons. At cutover it composes `.rp-seg`
  and keeps its own combo override in the page sheet.
- The legacy `.rt-seg`/`.rt-seg--rail` rules in `panel.css` (referenced by
  `rail.css` + `cases.css` placement comments) retire at the shell cutover; until
  then the framework twin coexists with them.

## Related

- [rail-controls.js](../../scripts/rail-controls.md) — `mountRailSeg()`, the
  class-agnostic behavior every `rp-seg` consumer reuses.
- [framework/rail.css](rail.md) — the rail's `.rp-rail-views` inlined the same
  seg styling (future-compose candidate).
- [framework/atoms.css](atoms.md) — the foundation atom sheet (`--` variant
  convention this follows).
