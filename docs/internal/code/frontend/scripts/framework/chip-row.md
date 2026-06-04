---
title: frontend/scripts/framework/chip-row.js
source: ../../../../../../frontend/scripts/framework/chip-row.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/chip-row.js — Chip-row component (B2)

## Purpose

The horizontal meta/filter pill row: a flat flex container (`rp-chip-row`)
holding an optional muted label (`rp-chip-row-label`) before a run of `rp-chip`
atoms — the canonical segmented-control look (a rounded capsule whose active
option carries `.is-active`). The framework chip-row is **generic + data-driven**
— `mountChipRow(host, config)` emits the `rp-chip-row` structure from a config of
chips + an `onChip` handler, so a page just supplies the data and the builder
owns the structure + the delegated click (the "lego brick"). Part of the
framework extraction (CAS_37B2E1BF); the consolidation of the per-tab filter
rows the live app hand-builds with `list-page.js` `chipRowHTML` /
`windowChipsHTML` and the cases per-context rows.

The row is **just the flex container** — it COMPOSES the `rp-chip` atom
([atoms.css](../../../styles/framework/atoms.md) A4); chip styling is never
redeclared here.

## Public surface

- `mountChipRow(host, config)` → `{ el, setChips(chips), select(value) }`. `host`
  becomes the `.rp-chip-row`. Self-registers as `"chip-row"`. ESM; composes the
  `rp-chip` atom + the `esc` util. `setChips` re-renders the chips in place (async
  per-agent chips); `select(value)` marks a value active for pref-driven init.

### Config (every section optional)

| key | shape | renders |
|---|---|---|
| `label` | string | optional `rp-chip-row-label` prefix |
| `name` | string | `data-chip-name` on the row (Home's fetcher key) |
| `chips` | `[{value,label,active,disabled,title}]` | one `rp-chip` atom per option |
| `attr` | string (default `"value"`) | the chip's `data-<attr>` key (`window` → `data-window`, `chip-assignee` → `data-chip-assignee`) |
| `rowClass` | string | extra class(es) on the row → a CSS variant ancestor (`rp-cases-done-window`) |
| `chipClass` | string | extra class(es) on every chip (`rp-cases-done-chip`) |
| `role` / `ariaLabel` | string | a11y on the row (e.g. `role="group"` for the detail-path) |
| `onChip` | `(value, chip, row) => void` | delegated click handler |

## How it works

- **One delegated click handler** on the row routes every chip via
  `.closest('.rp-chip')`, so `setChips` can re-render without re-binding. On
  click it clears sibling `.is-active`, sets the clicked chip active, then calls
  `onChip(value, chip, row)` — the builder owns the toggle, the caller owns the
  fetch.
- **`data-*` is load-bearing + non-uniform.** Each context reads a different
  attribute (`data-value` Home, `data-window` Monitoring, `data-chip-assignee` /
  `data-chip-status` cases rail, `data-done-window` done-window,
  `data-path-status` detail-path, `data-activity-filter` activity). The builder
  keeps the caller's `attr` AND **always emits `data-value`** alongside it (unless
  `attr` already is `"value"`), so the cross-cutting **main.js audit
  MutationObserver** — which captures `data-value` off `.rp-chip.is-active` as a
  tab-switch event — keeps working for every variant.
- **Variants are CSS, not builders.** The cases flat-wrap (rail filter),
  done-window, and detail-path looks are ancestor-scoped overrides in
  [chip-row.css](../../../styles/framework/chip-row.md), reached by passing
  `rowClass` / `chipClass` + the right `attr`. There is no per-variant JS path.
- All dynamic content is escaped via `esc()` — same XSS-safe pattern as
  [rail.js](rail.md); the `data-<attr>` name is escaped too so a caller-supplied
  attr can't break out of the attribute.

## Drift-prone areas

- **Audit pipeline depends on the literal names.** main.js's MutationObserver
  (data-value off `.rp-chip.is-active`) and `audit/snapshot.js` (the `.rp-chip-row`
  / `.rp-chip` structural-snapshot selectors) read these classes/attributes.
  Renaming away from `rp-chip-row` / `rp-chip` / `data-value` breaks the audit
  tools — the component is already `rp-`prefixed, so the names stay verbatim.
- **`rp-cases-chip-row` is the OUTER WRAPPER, not a variant of the row.** It's a
  column wrapper holding a label ABOVE an inner `rp-chip-row`; the flat-wrap look
  comes from its child-combinator rule `.rp-cases-chip-row .rp-chip-row`. At
  cutover the page supplies that wrapper; `mountChipRow` builds only the inner row
  (pass `rowClass`/`chipClass` for the chip-level tweaks).
- **Foreign-prefix ancestor scopes.** The done-window's rail inset
  (`.rt-group-body > .rp-cases-done-window`) and compact-collapse
  (`.rt-nav.compact .rp-cases-done-window`) are keyed off `rt-` (rail.css)
  ancestors. They stay as `rt-` selectors in chip-row.css until rail.js's group
  body is ported — porting them as `.rp-rail` now would lose the inset (live
  markup still emits `.rt-group-body`).
- **`is-done` is a detail-path state, not an atom state.** The path hero's
  completed-step green tint (`.rp-cases-detail-path .rp-chip.is-done`) lives in
  chip-row.css, not the `rp-chip` atom; the caller toggles `.is-done` on
  left-of-current pills.
- **NOT the chart-designer's `.ds-chip-row`/`.ds-chip`** — that's a separate
  accent-soft monospace dimension-tag component (chart.css) and is deliberately
  not merged here.

## Related

- [framework/chip-row.css](../../../styles/framework/chip-row.md) — the chip-row's CSS (base capsule + label + the cases context-overrides).
- [framework/atoms.css](../../../styles/framework/atoms.md) — the `rp-chip` atom it composes (A4).
- [framework/rail.js](rail.md) — sibling component; the rail also composes `rp-chip` for its filter chips.
- [component-registry](component-registry.md) · [framework index](index.md).
