---
title: frontend/styles/framework/activity.css
source: ../../../../../../frontend/styles/framework/activity.css
owner: Torv
section: Internal · Code · Frontend · styles · framework
last modified date: 2026-06-05
---

# framework/activity.css — Activity-timeline styles

## Purpose

The CSS twin of `frontend/scripts/framework/activity.js` (`rp-activity`). A connected
vertical timeline: a fixed lead column (a kind-toned `rp-activity-dot` or an
`rp-avatar`) plus a body (`rp-activity-text` + a relative `rp-activity-time`), with a
1px connector rail drawn behind the markers and omitted on the last row so it never
dangles. The dot is ringed in `--rp-surface` so it punches cleanly through the rail.

Built entirely on the two-tier `--rp-*` tokens — `--rp-sp-*` spacing, `--rp-text-*`
type, `--rp-radius-pill`, and the dot tones map to `--rp-ok` / `--rp-accent-2` /
`--rp-warn` via `data-tone` — so it themes across all four themes (dark · light ·
catppuccin-mocha · catppuccin-latte) with zero per-sheet change. One framework class
per element (`rp-activity*`); the `rp-status` pill + `rp-avatar` marker are composed
atoms. Imported in `main.css`.

## Public surface

- `rp-activity` — the `<ol>` list (column flex, `--rp-sp-3` gap).
- `rp-activity-event` — a row (`1.5rem` lead column + `1fr` body); its
  `:not(:last-child)::before` draws the connector rail.
- `rp-activity-dot[data-tone="ok|info|warn"]` — the kind-toned marker (else neutral
  `--rp-text-mute`); ringed in `--rp-surface`. `rp-activity-event > .rp-avatar` is the
  actor-present variant.
- `rp-activity-body` → `rp-activity-text` (+ `b` for the actor, + a composed
  `rp-status` pill) and `rp-activity-time` (relative label). `rp-activity-empty` is the
  empty state.

## Drift-prone areas

- The rail's `left: 0.6875rem` is hand-aligned to the **centre of the `1.5rem` lead
  column** and the `rp-activity-dot` size — change the lead column width or the dot
  size and the rail must be re-centered.
- Dot tones (`--rp-ok` / `--rp-accent-2` / `--rp-warn`) must stay in sync with the
  `TONE`→`PILL` mapping in `activity.js`, or a kind's dot and pill disagree in colour.
- Pure-token build (no hardcoded hex) — that's what makes it theme across all four
  themes; a literal colour here would break one theme silently.
