---
title: frontend/scripts/framework/virtual-rows.js
source: ../../../../../../frontend/scripts/framework/virtual-rows.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/virtual-rows.js — RedTable virtualization layer (B3)

## Purpose

The **windowing controller** for the `rp-redtable` (the centerpiece interactive
data table). It mounts only the rows near the viewport (+overscan) into the
`<tbody>`; everything off-window is represented by two spacer `<tr>`s carrying
the missing height, so the DOM node count stays **constant (~visible + 2×overscan
≈ 40 `<tr>`)** instead of scaling with the row count. A 200k-row sorted file
holds ~40 rows of live markup, not 200k. Ported VERBATIM from the legacy
`frontend/scripts/virtual-rows.js` (perf-critical rAF hot loop) — the only change
is the spacer class rename (`rt-vrow-spacer` → `rp-redtable-spacer`). It is a
**factory, not a registered component** — there is no `register()` call and it
owns no CSS family.

## Public surface

- `createVirtualRows({ scroller, tbody, rowHeight, renderRow, overscan = 8, pauseWhile })`
  → `{ setRows(next), refresh(), remeasure(h), get rowHeight, destroy() }`.
  Throws if `scroller` / `tbody` / `renderRow` are missing. ESM named export; no
  side-effects on import.

### Params

| param | shape | role |
|---|---|---|
| `scroller` | the scroll-host element | geometry reads `clientHeight` (viewport) + `scrollTop` every frame; `setRows` writes `scrollTop = 0`. Caller resolves it (live workspace: `table.closest('.rt-table-wrap')`). |
| `tbody` | the `<tbody>` element | the virtualizer OWNS its `innerHTML`; the `<thead>` is the caller's and is never touched (sticky-header / windowed-body separation is a hard contract). |
| `rowHeight` | number (px) | uniform row height for the active density; default `max(1, rowHeight \|\| 36)`. |
| `renderRow` | `(row, index) => string` | the caller's `<tr>…</tr>` markup, **byte-identical to the non-virtual path**. `index` is the position in the backing array (1-based row number + per-row state lookup). |
| `overscan` | number (default 8) | extra rows rendered above + below the viewport to mask scroll latency. |
| `pauseWhile` | `() => bool` | edit-safety guard: when it returns true the scroll-frame repaint is skipped (don't recycle a focused/editing cell mid-edit). |

### Returned API

| method | effect |
|---|---|
| `setRows(next)` | swap the backing array, reset `scrollTop = 0`, force a repaint. Called on every new file / new sort order / new page. |
| `refresh()` | re-render the current window in place (force) — call after a selection / mode / value-edit change so recycled rows reflect new live state via `renderRow`. |
| `remeasure(h)` | update `rowH` (if `h > 0`) + force a repaint — call after a density change or the first-real-row measurement. |
| `get rowHeight` | current uniform row height. |
| `destroy()` | remove the scroll listener + cancel a pending rAF. |

## How it works

- **Windowing** (`geometry()`): computes `[start, end)` = `[first − overscan,
  first + visible + overscan)` clamped to `[0, total]`, where
  `visible = ceil(viewport / rowH)`. Emits only window rows + up to 2 spacers.
- **Spacer technique**: top spacer height = `topPx` (positions the window at the
  scroll offset); bottom spacer = `max(0, scrollH − topPx − (end−start)*rowH)`.
  `colspan=999` spans whatever the real column count is (the browser clamps);
  the height lives on the `<td>` (a row's height = max of its cells).
- **rAF-coalesced scroll** (`onScroll`, a plain `passive` `scroll` listener — NOT
  IntersectionObserver): the `if (frame) return` guard caps repaints at one per
  animation frame regardless of the scroll-event flood. Inside the rAF it checks
  `pauseWhile()` then `paint(false)`.
- **Paint short-circuit**: `paint(force)` early-returns when `!force` and
  `start/end/topPx` all match the last paint — no DOM write when the window
  didn't move. `setRows()` forces a repaint by resetting the `last*` to `-1`.
- **Float32 SCALED mode** (the subtle perf trick): `MAX_SCROLL_PX = 12_000_000`.
  Browsers composite layers in float32, exact only to 2^24 px (~16.7M); past that
  rows paint blurry / mispositioned (measured: the grid "goes weird" ~row 261k at
  comfortable density). When `total*rowH > MAX_SCROLL_PX` the scrollable height is
  capped at `MAX_SCROLL_PX` and the (≤12M px) scroll range maps **proportionally**
  onto the full row range with sub-row positioning. Below the cap it is exact,
  native 1:1 (`first = floor(scrollTop / rowH)`). `topPx` is always
  `< MAX_SCROLL_PX`, so painted rows stay float32-safe.

## SEAMs (composition, no re-implementation)

- **rp-table base** ([framework/table.css](../../../styles/framework/table.md)):
  already carries `.rp-table tbody tr { content-visibility: auto;
  contain-intrinsic-size: auto 2.25rem }` and the `white-space: nowrap` cell rule.
  The virtualizer composes that base; the **spacer's inline
  `content-visibility:visible` is the explicit counter to that rule** — a matched
  pair authored in two files. The `nowrap` rule is the silent uniform-height
  contract the single `rowH` rests on.
- **cell-editor.js** ([framework/cell-editor.js](cell-editor.md)): `pauseWhile`
  exists to protect a focused cell from being recycled mid-edit. When the
  rp-redtable adopts cell-editor, its "is a cell being edited?" predicate feeds
  `pauseWhile` — do NOT re-implement edit detection here; consume the editor's
  predicate. (Live workspace passes
  `() => tbody.contains(document.activeElement) && document.activeElement.isContentEditable`.)
- **Selection / edit / sort state lives in the CALLER**, never on the DOM: rows
  are recycled, so the caller keys state by row identity (the absolute `data-idx`)
  in its own Set / mode-class and reflects it through `renderRow` + `refresh()`.

## The `rp-redtable-spacer` class (CSS-less, inline-styled)

There is **no CSS rule** for `.rp-redtable-spacer` (the legacy `.rt-vrow-spacer`
had none either — verified by grep across all sheets). It is styled entirely
inline in the `SPACER()` template literal:

```js
'<tr class="rp-redtable-spacer" aria-hidden="true" style="content-visibility:visible">' +
'<td colspan="999" style="height:' + h + 'px;padding:0;border:0"></td></tr>'
```

The inline `content-visibility:visible` is **load-bearing** — it opts the spacer
out of the rp-table base `tbody tr { content-visibility:auto }`, otherwise an
offscreen spacer would collapse to its intrinsic size and wreck the scroll
height. The class is also the **first-real-row measurement hook**: a caller finds
the first real row via `tr:not(.rp-redtable-spacer)` (the legacy workspace
queried `tr:not(.rt-vrow-spacer)`; the rename is the one change in the port).
A CSS-only port would miss this class — the styling lives in the JS, not a sheet.

## Drift-prone areas

- **PERF HOT LOOP — do not add work to `paint()`.** It runs the `renderRow`
  string-concat loop on every scroll frame (rAF) for the whole window (~40 rows ×
  60fps). `renderRow` MUST stay a pure synchronous string builder; an extra
  escaping pass, per-row state lookup, or framework render layer here is a
  regression. The caller escapes every dynamic value via `esc()` BEFORE it reaches
  `renderRow`; the JS↔Rust / JS-owns-pixels boundary is stressed exactly here.
- **`tbody.innerHTML = html`** is the perf-critical write path; `SPACER(h)`
  interpolates only the internally-computed numeric `h`. Do not introduce a
  sanitizer pass — it breaks the verbatim-port + no-frameworks contract.
- **SCALED-mode geometry is byte-for-byte sacred.** The proportional
  scroll-range→row-range mapping (`MAX_SCROLL_PX`, sub-row positioning) is
  browser-quirk-driven (2^24 compositing limit, measured ~row 261k) and has NO
  test harness. A "cleaner" rewrite risks reintroducing the blurry-rows-past-260k
  bug. Verification is a manual >200k-row scroll spike, not a unit test.
- **`destroy()` is wired but unused by the legacy single-page consumer**
  (`vrows` is created once per page-mount and lives the page lifetime). A
  generalized rp-redtable that mounts/unmounts repeatedly MUST call `destroy()`
  or it leaks one scroll listener per mount — a latent bug the current consumer
  never hits.
- **CSP coupling**: the spacer relies on inline `style=` attributes (height +
  content-visibility). A future CSP that bans inline styles would break it; the
  inline approach is the simplest correct technique — flag the coupling if CSP
  tightens.

## Related

- [framework/table.css](../../../styles/framework/table.md) — the rp-table base
  (`content-visibility:auto` + `white-space:nowrap`) the spacer's inline override
  is paired with.
- [framework/table.js](table.md) — the SIMPLE read-only table; explicitly has NO
  virtualization. This virtualizer is the missing interactive layer of the
  separate `rp-redtable` that shares the same rp-table base.
- [framework/cell-editor.js](cell-editor.md) — the inline-edit layer whose
  "editing?" predicate feeds `pauseWhile`.
- [component-registry](component-registry.md) · [framework index](index.md) —
  NOTE: virtual-rows is a factory, NOT a registered component (no `register()`).
