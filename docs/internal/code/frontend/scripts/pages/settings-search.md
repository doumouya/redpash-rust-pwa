---
title: frontend/scripts/pages/settings-search.js
source: ../../../../../frontend/scripts/pages/settings-search.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-01
---

# settings-search.js

## Purpose

Settings v2 step 3 affordance — behavior-first search bar + tag chip
cloud above the Settings section view. Live-filters every rendered
pref row by label / hint / key / tags (80ms debounce); non-matching
rows pick up `.is-dim` (40% opacity, kept in place so the user sees
what they're filtering past); rail group badges switch from tab-count
to hit-count while a query is active.

`/` focuses the search input from anywhere on the page (guarded so it
doesn't hijack typing inside other inputs / textareas /
contentEditable). `Esc` clears the query + deselects every tag chip.

## Public surface

- `mountSearch(app)` — render + wire the affordance. Called once by
  `settings.js` after the rail is mounted (rail must exist so the
  hit-count badges are queryable). Returns `{ focus(), clear(),
  recompute() }` for tests / dev tools.

## How matching works

1. On first compute, build a `Map<rowEl, { spec, haystack }>` by
   scanning every `[data-pref]` element in the page and resolving its
   key against `eachPref` (from `prefs.js`).
2. `haystack` is `(label + hint + key + tags).toLowerCase()` — one
   `.includes()` call covers all four fields without per-row regex.
3. Tags from the registry deduplicate into a sorted chip cloud. Click
   toggles selection; the matcher does query AND tags (all selected
   tags must be present). Each tag is the shared `.rp-chip` atom (was a
   parallel `.rp-settings__tag`); the wrap-cloud `.rp-settings-tags`
   container gives the free-standing outline via ancestor context
   (`.rp-settings-tags .rp-chip`), not a 2nd class — the coherence rule
   (CAS_37B2E1BF). The old leading selection dot is dropped; the chip's
   `.is-active` fill is the selection cue.
4. Each row's `.is-dim` + `aria-hidden` is updated in one pass; rail
   badges recompute as the sum of section hits.

Rail badges:

- When inactive (no query, no selected tags): badge shows tab count
  (original behavior).
- When active: badge shows hit count across the group's tabs +
  `.is-hits` (accent color); the group head dims via `.is-no-hits`
  if the group has zero hits.

## A11y

- Search input: `role="searchbox"`, `aria-label="Search settings"`.
- Tag chips: native `<button>` (`.rp-chip`), `aria-pressed="true|false"`.
- Live region: `<div aria-live="polite">` announces "N of M settings
  match" as the user types (after the 80ms debounce settles).
- Non-matching rows: `aria-hidden="true"` so screen readers skip them.

## Drift-prone areas

- Non-pref rows (sentinels mount, share_sentinels, signout button,
  about brand, Cases stub) have no spec backing so they're outside
  the filter. They stay visible regardless of search — by intent;
  search filters PREFS, not navigation surfaces. Step 5 (Hidden
  Items tab) lives the same way: navigation surface, no filter.
- The `/` keybinding is global (`document.addEventListener`). If
  the user navigates away from Settings while the module is still
  in DOM (SPA route), the listener stays. Today the page mount
  re-runs on every route entry so the duplicate listener is
  harmless (focus() is idempotent), but a future cleanup pass
  should remove on unmount.
- `mountSearch` indexes `.rt-group-count` once on first compute.
  If the rail is rebuilt after mount (today only happens via
  `activate` which doesn't re-render the rail body), the badge
  index goes stale. Today no rebuild path exists; flagged for the
  step 5 / step 6 sequencing.
- Empty registry: when no spec carries tags, the chip row is
  omitted entirely (`hidden`-by-default + early-exit). Search
  still works on label / hint / key without tags — open-ended
  per [[data-format-open-ended]].

## Settings v2 rollout reference

Step 3 of the 7-step plan
(`~/.claude/plans/transient-dazzling-conway.md`). Steps 1-2 built the
open registry + registry-driven render this module reads from. Step
4 (chart-layouts control move), 5 (Hidden Items tab), 6 (26 new
prefs + read-site cutover + rail-view auto-toggle), 7 (SQL
backfill) extend the registry; this module's matcher picks them up
automatically — no edit here when new prefs land.

## Related

- [Frontend pillar landing](../../../index.md)
- [`pages/settings.js`](settings.md) — mounts this module.
- [`prefs.js`](../prefs.md) — the registry whose specs this module
  reads via `eachPref`.
- [Settings v2 plan](~/.claude/plans/transient-dazzling-conway.md)
