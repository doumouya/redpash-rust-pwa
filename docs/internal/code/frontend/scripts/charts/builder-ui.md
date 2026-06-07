---
title: frontend/scripts/charts/builder-ui.js
source: ../../../../../frontend/scripts/charts/builder-ui.js
owner: Torv
section: Internal · Code · Frontend · scripts/charts
last modified date: 2026-06-07
---

# builder-ui.js

## Purpose

Chart-spec authoring accordion. Slice C of the chart-pipeline unification. Lifts the right-side accordion (Chart type / Data / Axes / Legend / Tooltip / Style) out of designer.js so the Settings Monitoring chart picker can mount the same UI.

## Public surface

- mountBuilder(el, ctx) — paints the 6-section accordion.
- Each section: tight form with the cfg-vocabulary inputs.

## Drift-prone areas

- Cfg vocabulary contract with build.js; new chart-kind features need cfg + UI on both sides.
- **Class family is `rp-dash-*`** (migrated from `ds-*` on 2026-06-07, alongside designer.js — the dedup renamed the CSS but left the emitter behind). The internal accordion-body hook is `id="rp-dash-acc-body"`. Emitting a retired `ds-*` name again **fails `tools/retired-class-audit`** (runbook 0017).
- **The dedup also normalized this file's STATE classes to the `is-*` convention** (migrated 2026-06-07, caught by the adversarial review): accordion section `open → is-open` (emit + the `.rp-dash-sec-head` click-toggle must stay in lockstep), and the type-button / theme-option active state `active → is-active`. The `<option … selected>` form attributes are NOT classes — left as-is.

## Related

- [Frontend pillar landing](../../../index.md)
