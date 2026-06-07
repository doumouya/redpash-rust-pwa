/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/virtual-rows.md */
// ─────────────────────── virtual-rows ───────────────────────
//
// Windowed <tbody> renderer for the redtable. Mounts only the rows
// near the viewport (+overscan); the rest are represented by two
// spacer <tr>s that carry the off-window height so the scrollbar
// stays honest. DOM node count becomes constant (~visible + overscan)
// instead of scaling with the row count — a 1000-row page (or, later,
// a windowed-fetch infinite list) holds ~40 <tr>, not 1000.
//
// Why this composes with the WASM/vanilla architecture:
//   • No framework — direct DOM writes, the engine can keep owning the grid.
//   • The row markup is the CALLER's (renderRow), byte-identical to the
//     non-virtual path, so column alignment + delegated tbody handlers
//     (change/click/keydown/focusin) keep working on recycled rows.
//   • Per-render work is bounded to the window, so whatever feeds the
//     rows (in-memory page array now; windowed /page fetch later) only
//     ever materialises ~40 rows of markup per scroll frame.
//
// Assumptions:
//   • Uniform row height (redtable cells are `white-space: nowrap`,
//     one line each). Pass the height for the active density; call
//     `remeasure()` after a density change.
//   • A single scroll container (`.rp-table-wrap`) wraps the <table>.
//
// State that must NOT live on the DOM: selection / edit targets. Rows
// are recycled, so a row scrolled out and back is a fresh node. The
// caller tracks those by row identity (data-idx) in its own state and
// reflects them in `renderRow` — never by reading classes off the DOM.
//
// API:
//   const vr = createVirtualRows({ scroller, tbody, rowHeight, renderRow, overscan? });
//   vr.setRows(rows);     // swap the backing array; resets scroll to top
//   vr.refresh();         // re-render the current window in place (e.g. after a
//                         //   selection/edit-state change, or a value edit)
//   vr.remeasure(h);      // update row height (density change) + re-render
//   vr.destroy();         // detach the scroll listener
//
// renderRow(row, index) -> string   // the <tr>…</tr> outerHTML for one row.
//   `index` is the row's position in the backing array (use it for the
//   1-based row number and to look up per-row state).

export function createVirtualRows({ scroller, tbody, rowHeight, renderRow, overscan = 8, pauseWhile }) {
  if (!scroller || !tbody || typeof renderRow !== "function") {
    throw new Error("createVirtualRows: scroller, tbody, renderRow required");
  }

  let rows = [];
  let rowH = Math.max(1, rowHeight || 36);
  let lastStart = -1;
  let lastEnd = -1;
  let lastTopPx = -1;
  let frame = 0;

  // Browsers composite layers with float32 — exact only to 2^24 px (~16.7M). A
  // scroll OFFSET past that paints rows blurry / mispositioned, even though
  // layout + our index math stay correct (measured: the grid "goes weird"
  // ~row 261k at the comfortable density, 261k × ~64px ≈ 2^24). So we cap the
  // real scrollable height well under 2^24 and, for taller content, SCALE: the
  // scroll range maps proportionally onto the row range with sub-row
  // positioning, so it still scrolls smoothly — the only trade is "scroll
  // speed" (more rows per pixel), fine for the >200k-row lists that need it.
  // Below the cap nothing changes (exact, native 1:1 scroll).
  const MAX_SCROLL_PX = 12_000_000;

  // Spacer rows. colspan=999 spans whatever the real column count is
  // (browsers clamp to the actual number) so we never have to know it.
  // The height lives on the <td> — a table row's height is the max of
  // its cells, so an explicit-height cell sizes the spacer row exactly.
  // `content-visibility:visible` opts the spacer OUT of any global
  // `content-visibility:auto` on `tbody tr` — otherwise an offscreen
  // spacer would collapse to its intrinsic size and wreck the scroll
  // height. (The windowed real rows can keep cv:auto; they're on-screen.)
  const SPACER = (h) =>
    '<tr class="rt-vrow-spacer" aria-hidden="true" style="content-visibility:visible">' +
    '<td colspan="999" style="height:' + h + 'px;padding:0;border:0"></td></tr>';

  // Geometry for the current scroll position. Returns the window [start, end),
  // the top-spacer height, and the total scrollable height. In SCALED mode the
  // scroll range (≤ MAX_SCROLL_PX) maps proportionally onto the row range and
  // topPx tracks scrollTop (so the window stays in the viewport, sub-row
  // smooth); below the cap it's exact 1:1 (topPx = start*rowH, native scroll).
  // topPx is always < MAX_SCROLL_PX, so painted rows stay in the float32-safe zone.
  function geometry() {
    const total = rows.length;
    if (total === 0) return { start: 0, end: 0, topPx: 0, scrollH: 0 };
    const viewport = scroller.clientHeight || 0;
    const contentH = total * rowH;
    const scaled = contentH > MAX_SCROLL_PX;
    const scrollH = scaled ? MAX_SCROLL_PX : contentH;
    const visible = Math.ceil(viewport / rowH);

    let first, subRow;
    if (!scaled) {
      first  = Math.floor(scroller.scrollTop / rowH);
      subRow = scroller.scrollTop - first * rowH;       // 0..rowH (native smooth scroll)
    } else {
      const maxScroll = Math.max(1, scrollH - viewport);
      const f = Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
      const vScroll = f * Math.max(0, contentH - viewport); // virtual offset into the content
      first  = Math.floor(vScroll / rowH);
      subRow = vScroll - first * rowH;
    }
    const start = Math.max(0, first - overscan);
    const end   = Math.min(total, first + visible + overscan);
    // Position `start` so `first` lands at scrollTop-subRow (scrolled up by the
    // sub-row remainder → smooth). Clamp ≥ 0.
    const topPx = Math.max(0, scroller.scrollTop - subRow - (first - start) * rowH);
    return { start, end, topPx, scrollH };
  }

  function paint(force) {
    const { start, end, topPx, scrollH } = geometry();
    if (!force && start === lastStart && end === lastEnd && topPx === lastTopPx) return;
    lastStart = start;
    lastEnd = end;
    lastTopPx = topPx;

    let html = "";
    if (topPx > 0) html += SPACER(topPx);
    for (let i = start; i < end; i++) html += renderRow(rows[i], i);
    const bottomPx = Math.max(0, scrollH - topPx - (end - start) * rowH);
    if (bottomPx > 0) html += SPACER(bottomPx);

    tbody.innerHTML = html;
  }

  // rAF-coalesced scroll handler — at most one repaint per frame.
  function onScroll() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Don't recycle mid-edit: replacing the tbody while a cell is focused
      // would drop the in-progress edit. The next scroll after blur catches up.
      if (pauseWhile && pauseWhile()) return;
      paint(false);
    });
  }

  scroller.addEventListener("scroll", onScroll, { passive: true });

  return {
    setRows(next) {
      rows = Array.isArray(next) ? next : [];
      scroller.scrollTop = 0;
      lastStart = lastEnd = lastTopPx = -1; // force a repaint even if range matches
      paint(true);
    },
    refresh() {
      paint(true);
    },
    remeasure(h) {
      if (h && h > 0) rowH = h;
      paint(true);
    },
    get rowHeight() { return rowH; },
    destroy() {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
