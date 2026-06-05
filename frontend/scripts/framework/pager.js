/* Purpose: Pager framework component — the redtable footer (rows-info + windowed page buttons).
   Doc: docs/internal/code/frontend/scripts/framework/pager.md */
// ── Pager (framework component, CAS_37B2E1BF) ───────────────────────────────
// The redtable footer: a rows-info readout on the left + windowed page buttons
// (‹ 1 … n-1 n n+1 … N ›) on the right. UNIFIES the two divergent live
// renderers into one builder:
//   - workspace.js renderPager()/pgBtn() — closure state, emitted only the
//     pages into #wsPages (rows-info lived in a separate #wsRowsLabel).
//   - list-page.js renderListPager()/pagerBtn() — took a {page,totalPages,
//     total,shown,pageSize} state object, emitted BOTH the rp-rows-info span
//     and the rp-pages div.
// Both shared the SAME window+ellipsis algorithm (≤7 pages: show all; else
// {1, last, p-1, p, p+1} with `…` gaps). mountPager keeps that algorithm
// verbatim and emits the list-page.js shape (rows-info span + rp-pages div),
// which is the Workspace-parity layout — pager.css `margin-right:auto` on
// .rp-rows-info pushes the pages right, so the pages-only shape (no rows-info)
// still anchors right via the host's flex-end.
//
// The page-size selector is NOT part of the pager — it is a toolbar dropdown
// (rp-table-toolbar). The pager owns only the rows-info + page buttons.
//
// Composes, not duplicates:
//   - .rp-pager / .rp-rows-info / .rp-pages / .rp-pg / .rp-pg-gap (pager.css),
//     ported verbatim from the rp-pager family.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── render state (every optional field absent ⇒ rows-info renders empty) ─────
//   page       : number   — current 1-based page (required)
//   totalPages : number   — page count; < 1 ⇒ the pager renders empty (required)
//   total      : number?  — total row count (drives the rows-info readout)
//   shown      : number?  — rows on the current page (clamps the X–Y range)
//   pageSize   : number?  — rows-per-page (so we can compute the X–Y range)

/** Build + wire the pager into `host`. `host` becomes the `.rp-pager` element.
 *  opts.onPage(n) fires when a (non-disabled, non-current) page button is
 *  clicked. Returns { el, render(state) } — render is idempotent + re-callable
 *  after any data change (matches the live renderers' re-render-in-place use). */
export function mountPager(host, opts = {}) {
  if (!host) return null;
  const onPage = opts.onPage || null;
  host.className = "rp-pager";

  // One delegated click handler — survives re-renders of the buttons without
  // re-binding per element. Disabled buttons drop data-page, so they're skipped.
  host.addEventListener("click", (e) => {
    // Skip the current page (.active) — matches the legacy guard
    // `target === currentPage return` so a click on the current page no-ops.
    // Disabled prev/next drop data-page, and the window only emits in-range
    // pages, so .active is the only extra guard the legacy handlers needed.
    const btn = e.target.closest(".rp-pg[data-page]:not(.active)");
    if (!btn || !host.contains(btn)) return;
    const target = parseInt(btn.dataset.page, 10);
    if (!Number.isFinite(target)) return;
    onPage?.(target);
  });

  function render(state = {}) {
    if (!state || !(state.totalPages >= 1)) { host.innerHTML = ""; return; }
    const p = state.page, last = state.totalPages;

    // rows-info readout — "Rows {from}–{to} of {total}" when we have the
    // counts; the empty span still reserves the flex slot so the layout
    // stays consistent across tabs.
    let info = "";
    if (state.total != null && state.pageSize != null) {
      const size = state.pageSize;
      const from = (p - 1) * size + 1;
      const to = state.shown != null
        ? Math.min((p - 1) * size + state.shown, state.total)
        : Math.min(p * size, state.total);
      if (state.total === 0) info = "No rows";
      else info = `Rows ${from.toLocaleString()}–${to.toLocaleString()} of ${state.total.toLocaleString()}`;
    }

    // page buttons — compact window: always show 1 and last; show current ±1;
    // collapse the rest with `…` gaps. Disabled prev/next render as
    // <button disabled> so the CSS :disabled selector handles them.
    const out = [];
    out.push(pgBtn("‹", p - 1, false, p === 1));
    if (last <= 7) {
      for (let i = 1; i <= last; i++) out.push(pgBtn(String(i), i, i === p, false));
    } else {
      const want = new Set([1, last, p, p - 1, p + 1]);
      let prev = 0;
      for (let i = 1; i <= last; i++) {
        if (!want.has(i)) continue;
        if (i - prev > 1) out.push('<span class="rp-pg-gap">…</span>');
        out.push(pgBtn(String(i), i, i === p, false));
        prev = i;
      }
    }
    out.push(pgBtn("›", p + 1, false, p === last));

    host.innerHTML = '<span class="rp-rows-info">' + esc(info) + '</span>'
      + '<div class="rp-pages">' + out.join("") + '</div>';
  }

  return { el: host, render };
}

// Single pager button. Disabled buttons drop the data-page attr so the
// delegated click handler skips them naturally (it selects `.rp-pg[data-page]`).
function pgBtn(label, page, active, disabled) {
  return '<button class="rp-pg' + (active ? " active" : "") + '" type="button"'
    + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
}

register("pager", mountPager);
