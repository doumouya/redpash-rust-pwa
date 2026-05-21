/* ─────────────────────── Shared redtable pager ───────────────────────
 *
 * One source of truth for the redtable page-button strip, so the
 * cleaner / objects / reports tables all render an identical pager.
 *
 * `pagerMarkup(cur, total)` returns the inner HTML for a `.rp-rt-pages`
 * slot: a ‹ prev chevron, a smart-windowed run of page buttons
 * ([1, …, cur-1, cur, cur+1, …, last]), and a › next chevron. Every
 * button carries `data-pg="<n>"`; the caller wires the click to its own
 * page setter — keeping each page's existing navigation intact:
 *
 *   slot.innerHTML = pagerMarkup(page, totalPages);
 *   slot.querySelectorAll("button[data-pg]").forEach((b) => {
 *     b.addEventListener("click", () => goToPage(Number(b.dataset.pg)));
 *   });
 *
 * Returns "" when there is a single page (the slot collapses to nothing).
 * Markup mirrors the cleaner page's pager, which is the canonical look.
 * ─────────────────────────────────────────────────────────────────────── */

// [1, …, cur-1, cur, cur+1, …, total] — ≤ 7 pages lists every page.
function pageWindow(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  if (cur > 3) out.push("…");
  for (let p = Math.max(2, cur - 1); p <= Math.min(total - 1, cur + 1); p++) out.push(p);
  if (cur < total - 2) out.push("…");
  out.push(total);
  return out;
}

export function pagerMarkup(cur, total) {
  const pages = Math.max(1, total | 0);
  if (pages <= 1) return "";
  const c = Math.min(pages, Math.max(1, (cur | 0) || 1));
  const nav = (target, left, label) =>
    `<button type="button" class="rp-rt-pg" data-pg="${target}"` +
    `${(left ? c === 1 : c === pages) ? " disabled" : ""}` +
    ` title="${label}" aria-label="${label}">` +
    `<i class="bi bi-chevron-${left ? "left" : "right"}"></i></button>`;
  const body = pageWindow(c, pages).map((p) =>
    p === "…"
      ? `<span class="rp-rt-pg rp-rt-pg-gap">…</span>`
      : `<button type="button" class="rp-rt-pg${p === c ? " on" : ""}" data-pg="${p}">${p}</button>`
  ).join("");
  return nav(c - 1, true, "Previous page") + body + nav(c + 1, false, "Next page");
}
