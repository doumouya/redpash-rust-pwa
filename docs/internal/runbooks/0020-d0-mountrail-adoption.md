---
title: 0020 — Slice D / D0': Workspace + Dashboard adopt the framework mountRail (not a new project-rail.js) — regressions caught by adversarial verify
date: 2026-06-07
area: frontend/scripts/framework/rail.js + styles/framework/rail.css + pages/{dashboard,workspace}.js
---

# 0020 — D0': the two holdout pages adopt mountRail

## Context

Slice D's D0' was planned as "extract the common rail core into a NEW
`framework/project-rail.js` that Workspace + Dashboard compose." A pre-work map found
`framework/rail.js` **already** exports the canonical data-driven `mountRail(host, config)`,
used by **admin-console / sheetwise / database**. So a new module would have been a **3rd
parallel rail** — the exact debt trap. Em chose: **adopt `mountRail`** for the two
pre-framework holdouts instead. Dashboard first (lean rail), then Workspace (the rich rail).

## What shipped

- **`mountRail` extension + latent fixes** (committed `7702999` with the dashboard slice):
  per-row tab `actions` + a generic delegator default-case (`on[action]`); mark renders via
  `background: var(--mark)` + `initials` (was an empty colourless square — latently broken on
  admin/sheetwise too); tab `dot` as the `.is-*` state class.
- **Dashboard** → `mountRail` (groups data-model + `setGroups`), `?source=` deep-link intact.
- **Workspace** → `mountRail` (the rich rail: rename, hide + hidden-recovery, `overview`
  pseudo-tab, per-row Visualize `actions`, upload ghosts, deep-link, prewarm). The page is now
  a config-supplier + a `cachedProjects`/`filesByGroup`/`expanded`/`uploadGhosts` data-model;
  a re-render is `refreshRail() = rail.setGroups(buildGroups(), buildHidden(), emptyText)`.

## Regressions caught + fixed (a 15-agent adversarial verify workflow + Em's live eye)

The migration is behaviour-parity; verification surfaced 10 real regressions vs the old
hand-built rails — all fixed before commit:

1. **Affordance glyphs broken (Em, live).** `tabHTML`/`groupHTML` emitted rename/hide/`actions`
   as `<button class="rp-btn-icon rp-rail-tab-rename">` — invalid (a `<button>` nested inside the
   tab `<button>`) AND oversized (`rp-btn-icon` = 2rem `min-width`/padded; the
   `.rp-rail-*-{rename,hide,visualize}` atoms only set 1.25rem). Workspace was the FIRST page with
   **per-tab** affordances → the boxes broke the tab row + squeezed the stage dot. **Fix:** emit
   the affordances as bare `<span>`s (no `rp-btn-icon`, no nested button) — exactly like the
   hand-built Monitoring/cases rails (Em's reference), which always rendered fine; the atom CSS
   styles the span directly, no CSS change needed. (A first pass tried bare `<button>` + CSS
   resets, but a `<button>`-in-`<button>` is still invalid; `<span>` is the right answer.)
   Verified fresh-Playwright: hide/rename/visualize are 22.5px span glyphs, 0 nested buttons.
2. **(HIGH) Stale rail on collapse→re-expand + broken Refresh.** The old code cleared the
   lazy-load gate on every expand so external writes (connector/Kafka/other-tab) appeared
   (a deliberate 2026-06-01 fix). The data-model `loadFilesForGroup` early-returns on
   `filesByGroup.has(rid)` and nothing invalidated it. **Fix:** `on.groupToggle` deletes the
   group's cache on expand; `#wsRefresh` does `filesByGroup.clear()`.
3. **(HIGH) First upload into an empty workspace left the new project invisible** — `openNewFile`
   never re-fetched the roster, so a server find-or-create project wasn't in `cachedProjects`.
   **Fix:** `openNewFile` calls `loadProjects()`; `doUpload` routes its success tail through it.
4. **`?project=`-only deep-link no longer opened the first file** (parked on Overview). **Fix:**
   the deep-link IIFE opens the project's first data file when `wantRid && !wantFile`.
5. **Mark colours reshuffled on filter** (coloured by filtered index). **Fix:** colour keyed to
   the project's index in the unfiltered `cachedProjects` (filter-invariant).
6. **Queued/failed upload ghosts** rendered as plain tabs; failed ghost vanished instantly with
   no error. **Fix:** seed ghost `state:"queued"` (dimmed base); keep failed ghosts ~6s with the
   error as the tab `title` (added `title` support to `mountRail`).
7. **Empty-filter "No projects match" feedback lost.** **Fix:** `refreshRail` passes `emptyText`
   to `setGroups` (added `emptyText` support to `mountRail`).

## Verify

- `node --check` both JS; `tools/retired-class-audit` clean; `sh tools/audit.sh` (uniformity 0 new).
- `tools/page-verify` 11 routes × 4 themes ALL PASS.
- Live (dev-login, HARD reload): affordance glyphs are 1.25rem hover-fade (computed 22.5px, no
  2rem boxes), stage dot renders; `?project=` opens the first file; filter-to-nothing shows the
  "No match" line; mark colours stable while filtering; per-tab rename/hide/visualize + Overview +
  hidden-recovery all work (the full D0' affordance walk).
- Re-ran the adversarial verify → the fixed paths confirmed.

## Lesson

A framework component's UNEXERCISED path is a latent trap: `mountRail` had carried `rp-btn-icon`
on its affordances + an empty/colourless mark for months because no consumer used per-tab
affordances or visible marks until D0'. Adopting a shared component on a NEW (richer) page is
itself a verification event — adversarially diff the new consumer's behaviour against what it
replaced, and eyeball the actual pixels (a passing `.click()` test fired on the oversized glyphs).
