---
title: 0007 — Column drag-reorder cluster (4 layers)
section: Internal
order: 7
last modified date: 2026-05-31
---

# 0007 — Column drag-reorder cluster (4 layers)

**Date:** 2026-05-31 · **Area:** frontend / `list-page.js` + `home.js` + `table.css` (Home + Monitoring data tables) · **Status:** resolved (commits `c6ced6c`, `0ae04f0`, `c7ca6e6`, `2b8b12d`)

## Problem Statement

Em: *"the drag to reorder column feature is not working as expected on the datatables, can you look into this?"* — then, after the first fix: *"it didn't picked the list bro"* — then *"I feel like the bug is caused by the first column"* — then a screenshot showing the data under each header shifted by one slot — then *"Users tab, the only editable field is the joined date, which ironically shouldn't be editable but made by the system/db."*

Four distinct bugs all sitting on top of the column drag-reorder feature on Home tabs. Each surfaced as a different visible symptom; the diagnostic arc peeled them one at a time.

| Layer | Symptom | Visible on |
|---|---|---|
| 1 | After drag-reorder + paginate / sort / search, every column header showed data intended for a different column | Any Home tab with > 1 page of data |
| 2 | Dragging the FIRST column showed a visually weak / collapsing drop indicator at the table edge | First (and last) column edge |
| 3 | Headers and cells re-mis-aligned by one column after drag-reorder on tabs that declare `spec.hideMeta` | Users / Memberships / Files / Companies / Cases / Projects / Charts |
| 4 | Toggling edit mode tagged the wrong cell `contenteditable` — on Users, "Joined" (system-generated date) instead of "Job" | Any tab with `editable: true` cols + a custom column reorder |

## Troubleshooting steps

Important meta-note for future debugging: **Layer 1 was fixable from static analysis; Layers 2–4 only surfaced from live debugging via Playwright MCP** (chrome-devtools-mcp's profile was held by another Torv, so Playwright was the parallel option — see [[playwright-parallel-chrome]]).

### Layer 1 — `applyColumnOrder` early-return on misaligned thead/tbody

1. Grepped for `applyColumnOrder` references. Found the function in `list-page.js` and the consumer hooks in `home.js` / `monitoring.js`.
2. Read the function body. Noticed an early-return: `if (targetKeys.every((k, i) => currentKeys[i] === k)) return;`.
3. Traced the call paths. Two: the drop handler calls it directly (tbody is in lockstep with thead); the post-fetchList hook calls it on a freshly painted tbody (in **spec order**, even when thead is in **target order** from a prior reorder).
4. The early-return saw THs matching target and short-circuited — but tbody was in spec order, so the data cells stayed mis-aligned with the headers.

### Layer 2 — drop indicator visually collapses at table edges

1. Em pushed back: "it's going to be hard to debug without seeing it yourself." Switched to Playwright MCP (chrome-devtools-mcp's profile was locked by another agent — no contention with Playwright since it forks its own browser per session).
2. Verified Layer 1's fix worked: drag → paginate → cells aligned. Em still saw a bug.
3. Em: "I feel like the bug is caused by the first column."
4. Probed the CSS: the indicator was `box-shadow: inset 0.1875rem 0 0 var(--rp-accent-2)` — a 3px stripe on the inside-left of the target TH. On interior columns it sits *between* two columns and reads as "drop here." On the first column's left edge there is no column to the left to bracket against — the stripe collapses against the table boundary and reads as "edge of table."
5. Symmetric problem for `drop-after` on the last column.

### Layer 3 — `appendChild` of data THs shoves trailing sentinel to position 0

1. Em sent a screenshot showing the data row's `member` / `owner` badges sitting under the "Joined" header. Clear off-by-one shift across the whole row.
2. Inspected `headRow.children` and `tbody tr.children` via `browser_evaluate`:
   - thead = `[rp-home-hide-th (no key, width 341), display_name, …, redpash_id]` — 12 children, hide-action sentinel at position **0**.
   - tbody row = `[display_name TD, email TD, …, redpash_id TD]` — 11 children, no hide TD.
   - Mismatch: thead position N corresponds to tbody position N-1.
3. Read `home.js:1881` — the hide TH is supposed to be inserted *at the end* via `insertAdjacentHTML(headRow, "beforeend", …)`. So how did it end up at position 0?
4. Re-read `reorderColumnDOM` in `list-page.js`. It did `targetKeys.forEach((k) => headRow.appendChild(byKey.get(k)))`. Every `appendChild` moves the data TH to the *last* position — and on every iteration that shoves the trailing sentinel one slot to the left. After N appends, the trailing sentinel ends up at position 0.

### Layer 4 — `decorateEditMode` indexes by spec position, not DOM position

1. Em: *"Users tab, the only editable field is the joined date, which ironically shouldn't be editable but made by the system/db."*
2. Read the Users spec: only `job_title` has `editable: true` (at index 4 of `spec.columns`). "Joined" (= `created_at`) is index 9 and has no editable flag.
3. Read `decorateEditMode` in `home.js`: `cols.forEach((col, i) => { … const td = tds[i + offset]; … })`. Maps `spec.columns[i]` → `tds[i + offset]`.
4. After Em's drag-reorder, DOM position 4 of tbody was `created_at` (whichever column he'd dragged there), not `job_title`. The editable flag landed on the wrong cell.

## RCA

Four distinct mistakes all sitting in the same neighborhood — but each is a different *kind* of mistake:

| Layer | Mistake class | What was assumed | What was actually true |
|---|---|---|---|
| 1 | State-dependent early-return | thead ↔ tbody column-alignment | tbody was in spec order, thead in target order, both passed individual identity checks |
| 2 | Insufficient visual escape | inset 3px reads as "between" anywhere | at a row's edge, "between" needs *overhang*, not *inset* |
| 3 | `appendChild` in a loop with sibling framing nodes | "move all of these to the end" is the same as "put them in this order at the end" | each `appendChild` displaces every later child by one — so a trailing framing node walks N positions left |
| 4 | Spec-position indexing of a reorderable DOM | `spec.columns[i]` matches `tds[i]` | only true at the *exact* moment of `tbody.innerHTML =` (before reorder) — falls out of sync the instant the user drags |

Common theme across all four: **the DOM structure changes more than the spec does, and any code that reads positional state has to read it from the DOM, not from the spec.**

## Solution

| Layer | Commit | Fix |
|---|---|---|
| 1 | `c6ced6c` | `applyColumnOrder` always treats tbody as spec-ordered (the canonical state right after `fetchList` paints `tbody.innerHTML`). Extracted a `reorderColumnDOM(headRow, tbody, currentOrder, targetKeys, byKey)` helper. The drop handler calls the helper directly with the *live* DOM order, since at drop time tbody and thead are in lockstep. Consumers (home + monitoring) swap their hook order so `_applyColumnOrder` runs before `_applyHiddenColumns`. |
| 2 | `0ae04f0` | Replaced the `inset` box-shadow with a `::before` / `::after` pseudo-element insertion bar that overhangs the column edge by 2px (`left:-2px` / `right:-2px`) and extends 2px above/below the row. Reads as a clear insertion marker regardless of position. |
| 3 | `c7ca6e6` | Introduced `SENTINEL_LEADING_CELL`, `SENTINEL_TRAILING_TH`, `SENTINEL_TRAILING_CELL` constants. `reorderColumnDOM` detects the first trailing sentinel TH (no `data-col-key`, comes after at least one data-col-key TH) and `insertBefore`s data THs instead of `appendChild`-to-end. Same idea for tbody — sentinels filtered out of the data-cell set and reattached after the reorder. |
| 4 | `2b8b12d` | `decorateEditMode` builds a `keyToPos` Map from the *live* thead's `data-col-key` order and indexes tbody by `pos + offset` instead of `i + offset`. Hook chain reordered: `_decorateSelectMode` → `_applyColumnOrder` → `_applyHiddenColumns` → `_decorateEditMode` (was: select → edit → order → hidden). |

## Post Checking

Verified live via Playwright (`mcp__plugin_playwright_playwright__browser_*`) on `/home` after each commit:

1. Drag any column → cells move with the header (Layer 1 fix). ✓
2. Drag onto the first column's left half → a clear blue bar projects 2px past the column boundary (Layer 2 fix). ✓
3. After drag-reorder on a tab with `spec.hideMeta` (Users, Cases, etc.), `headRow.children` + `tbody tr.children` length parity holds, sentinel stays at right edge (Layer 3 fix). ✓
4. Toggle edit mode on Users with a custom column reorder → "Job" gets `contenteditable`, not "Joined" (Layer 4 fix). ✓
5. Em confirmed live: *"perfect, working now."*

## The discipline this updates

For any code path that touches a reorderable DOM row:

- **Read positional state from the DOM, not from the spec.** `spec.columns[i]` is the *original* order; after a user reorder, only `th.dataset.colKey` tells you the *current* order. Build a `keyToPos` Map from the live thead before indexing tbody.
- **Never `appendChild` in a loop when the parent has framing children to preserve.** Detect the first trailing framing node and `insertBefore` it. Names: `SENTINEL_LEADING_CELL`, `SENTINEL_TRAILING_TH`, `SENTINEL_TRAILING_CELL` (in `list-page.js`).
- **Hook order is part of the contract.** When pass B reads state that pass A produces, document the dependency at both ends — in the consumer's hook chain and in the producer's atomic doc.
- **Drop indicators need overhang at row edges.** `box-shadow: inset Npx` collapses against the row boundary on the first/last column; use a `::before` / `::after` pseudo-element with negative offsets so 2px projects past the edge.
- **For drag-and-drop column features, *always* verify live in a browser** — the off-by-one bugs in Layer 3 / 4 are invisible from static analysis. If `chrome-devtools-mcp` is locked, switch to Playwright MCP (see [[playwright-parallel-chrome]]).

### Follow-ups worth a pass

- **Reuse the sentinel pattern.** If a future feature adds another framing column (row handle, multiselect column on the right, etc.), add its class to the `SENTINEL_*` constants block in `list-page.js`. The drift note in `docs/internal/code/frontend/scripts/list-page.md` already calls this out.
- **Audit:** a `tools/runbook-audit/` that scans `git log` for fix-commits without a runbook backlink would catch the original sin behind this entry — *we found four bugs and the only durable record was the commit messages.* Decided 2026-05-31 with Em.
- **Consider a `decorateColumnState` consolidator** so `_applyColumnOrder` / `_applyHiddenColumns` / `_decorateEditMode` share one entry point with a documented ordering. Today the dependency is enforced by call-site ordering in `home.js`, which is fragile to reorder.

## Linked

- The four fixes — `c6ced6c`, `0ae04f0`, `c7ca6e6`, `2b8b12d`.
- The reorder helper — [`frontend/scripts/list-page.js`](../../../frontend/scripts/list-page.js) (atomic doc: [list-page.md](../code/frontend/scripts/list-page.md)).
- The hook-chain order — [`frontend/scripts/pages/home.js`](../../../frontend/scripts/pages/home.js) (atomic doc: [home.md](../code/frontend/scripts/pages/home.md)).
- The drop-indicator atom — [`frontend/styles/table.css`](../../../frontend/styles/table.css).
- The cadence this runbook codifies — [bug-case-runbook-cadence.md](../processes/bug-case-runbook-cadence.md).
- **Case ID:** TBD — `case_create` MCP returned HTTP 401 (`no session cookie`) on 2026-05-31; backend auth on the cases MCP is broken (same issue blocking earlier work). Open the case manually once the MCP is restored and amend this section with the `CAS_<rid>`.
