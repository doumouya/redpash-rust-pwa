/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/list-page.md */
// list-page.js — shared runtime for the rail-page list surfaces
// (Home + Monitoring). Both pages render the same shape: section
// head + optional chip strip + KPI tiles + chart cards + paged
// table + pager. They diverge only in id prefixes, chip semantics
// (per-spec vs. global window), and the data they fetch.
//
// This module hosts the pure HTML builders + the chart lifecycle.
// The page-specific orchestration (renderListBody + fetchList)
// stays per-page for now — they thread state through closures that
// don't generalise cleanly. T2-part-B may collapse them into a
// `mountListPage(viewSpec, hooks)` factory once both pages have
// proven out against the helpers.
//
// Scope of the extract (per js-refactor-targets.md T2):
//   - HTML builders: headHTML, kpiStripHTML, chartsStripHTML,
//     chipRowHTML, windowChipsHTML, listPanel, pagerBtn.
//   - Pager renderer: renderListPager (the elide-at-7-pages logic
//     was duplicated byte-for-byte across both pages).
//   - DOM mutation: setKpi.
//   - Chart lifecycle: createListCharts(view) factory + the
//     CHART_KINDS map + the lazy window-resize listener.
//
// Naming notes:
//   - tbodyId is page-local (rp-home-list-tbody / rp-mon-list-tbody)
//     so each page passes its own.
//   - CSS class `.rp-charts` is shared across both pages today
//     (a naming smell — both pages use the home prefix); renaming
//     to `.rp-list-charts` belongs in a separate CSS pass.

import { api } from "/scripts/api.js";
import { esc } from "/scripts/dom.js";
import { kpiDonut, kpiBar, kpiBarH, kpiGauge, kpiLine, kpiPie, kpiRose } from "/scripts/echarts-kpi.js";

// ── HTML builders ───────────────────────────────────────────────

export function headHTML(title, count) {
  return '<header class="rp-shell-head">'
    +   '<h2 class="rp-shell-head-title">' + esc(title) + '</h2>'
    +   '<span class="rp-shell-head-count">' + esc(count) + '</span>'
    + '</header>';
}

export function kpiStripHTML(tiles) {
  return '<div class="rp-kpi-strip">'
    + tiles.map((t) =>
        '<div class="rp-kpi">'
        + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
        + '<span class="rp-kpi-value" id="' + esc(t.id) + '">—</span>'
        + '</div>'
      ).join("")
    + '</div>';
}

// Baked-value variant of kpiStripHTML — tiles carry their value inline
// ({ label, value }) instead of an id filled later via setKpi. For
// surfaces that already hold the numbers at render time (Workspace
// landing, Cases board overview) so there's no async fill step. Same
// .rp-kpi-* atoms as kpiStripHTML, so the strip reads identically across
// every page.
export function kpiStripValuesHTML(tiles) {
  return '<div class="rp-kpi-strip">'
    + tiles.map((t) =>
        '<div class="rp-kpi">'
        + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
        + '<span class="rp-kpi-value">' + esc(String(t.value)) + '</span>'
        + '</div>'
      ).join("")
    + '</div>';
}

// 5-cell composite strip — the rich variant of (kpiStrip + chartsStrip).
// Layout per Em's spec (2026-05-25):
//   [chart 20%][chart 20%][stats 2×2 = 20%][chart 20%][chart 20%]
// Two charts flank a 2×2 KPI sub-grid + two more charts on the right.
// Empty chart slots reserve layout space so a tab with <4 charts still
// anchors its present charts at their natural columns.
//
// Consolidates two parallel implementations (Em flagged 2026-05-25):
// home.js's compositeStripHTML + monitoring.js's monCompositeStripHTML
// were identical except for a wrapper class name. Both now call this.
export function compositeStripHTML(tiles, charts) {
  const chartCard = (c) => c
    ? '<div class="rp-chart-card">'
    +   '<div class="rp-chart-title">' + esc(c.title || "") + '</div>'
    +   '<div class="rp-chart-canvas" id="' + esc(c.id) + '"></div>'
    + '</div>'
    : '<div class="rp-chart-card rp-chart-card--empty">'
    +   '<div class="rp-chart-canvas"></div>'
    + '</div>';
  const statsCells = tiles.map((t) =>
    '<div class="rp-kpi">'
    + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
    + '<span class="rp-kpi-value" id="' + esc(t.id) + '">—</span>'
    + '</div>'
  ).join("");
  return '<div class="rp-list-composite">'
    +   chartCard(charts[0])
    +   chartCard(charts[1])
    +   '<div class="rp-list-composite__stats">' + statsCells + '</div>'
    +   chartCard(charts[2])
    +   chartCard(charts[3])
    + '</div>';
}

// Hero strip — the overview variant of the composite strip, per Em's
// spec for the Cases/Workspace landings: one chart (40%) · a 2×2 stats
// grid (20%) · one chart (40%). Tiles carry baked { label, value } (the
// landing holds the numbers already); charts is [left, right] of
// { id, title } whose canvases createListCharts mounts into. Same
// .rp-chart-card / .rp-kpi atoms as the composite strip.
export function heroStripHTML(tiles, charts) {
  const chartCard = (c) => c
    ? '<div class="rp-chart-card">'
    +   '<div class="rp-chart-title">' + esc(c.title || "") + '</div>'
    +   '<div class="rp-chart-canvas" id="' + esc(c.id) + '"></div>'
    + '</div>'
    : '<div class="rp-chart-card rp-chart-card--empty">'
    +   '<div class="rp-chart-canvas"></div>'
    + '</div>';
  const cells = tiles.map((t) =>
    '<div class="rp-kpi">'
    + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
    + '<span class="rp-kpi-value">' + esc(String(t.value)) + '</span>'
    + '</div>'
  ).join("");
  return '<div class="rp-hero-strip">'
    +   chartCard(charts[0])
    +   '<div class="rp-hero-strip__stats">' + cells + '</div>'
    +   chartCard(charts[1])
    + '</div>';
}

// One card per chart in the spec. Each card carries a small title +
// a 180px-tall canvas; createListCharts().mount initialises ECharts
// against the canvas after the /stats fetch resolves.
export function chartsStripHTML(charts) {
  if (!charts || !charts.length) return "";
  return '<div class="rp-charts">'
    + charts.map((c) =>
        '<div class="rp-chart-card">'
        + '<div class="rp-chart-title">' + esc(c.title || "") + '</div>'
        + '<div class="rp-chart-canvas" id="' + esc(c.id) + '"></div>'
        + '</div>'
      ).join("")
    + '</div>';
}

// Per-spec chip row (Home): { name, label?, options: [{value, label}],
// default }. The page wires the click handler — chip flips set
// chipState[name] and refetch the list / charts.
export function chipRowHTML(chipRow, current) {
  return '<div class="rp-chip-row" data-chip-name="' + esc(chipRow.name) + '">'
    + (chipRow.label ? '<span class="rp-chip-row-label">' + esc(chipRow.label) + '</span>' : "")
    + chipRow.options.map((opt) =>
        '<button type="button" class="rp-chip' + (opt.value === current ? ' is-active' : '') + '"'
        + ' data-value="' + esc(opt.value) + '"'
        + (opt.disabled ? ' disabled' : '')
        + (opt.title ? ' title="' + esc(opt.title) + '"' : '')
        + '>' + esc(opt.label) + '</button>'
      ).join("")
    + '</div>';
}

// Global window chips (Monitoring): one of WINDOWS is active.
// data-window carries the chip's window key so the click handler
// can read it back.
export function windowChipsHTML(windows, active) {
  return '<div class="rp-chip-row">'
    + windows.map((w) =>
        '<button type="button" class="rp-chip' + (w === active ? ' is-active' : '') + '"'
        + ' data-window="' + esc(w) + '">' + esc(w) + '</button>'
      ).join("")
    + '</div>';
}

// `columns` accepts either a plain string (label only) OR an object
// `{ label, key, sortable }` so callers can flag which headers
// click-to-sort. Sortable headers get a data-sort attribute the
// page's delegated click handler reads. Backwards compatible: every
// existing caller passes a string array and renders identically.
export function listPanel(columns, tbodyId) {
  const th = columns.map((c) => {
    // `data-col-key` carries the column's logical identifier so the
    // columns-picker dropdown (decorateColsPicker in home.js) can hide
    // matching TH + nth-child TDs by id rather than by index. String-
    // column callers (no key set) fall back to the label as the key.
    // `draggable="true"` enables click-and-grab column reordering;
    // handlers + persistence live in home.js renderListBody.
    if (typeof c === "string") {
      return '<th draggable="true" data-col-key="' + esc(c) + '">' + esc(c) + '</th>';
    }
    const { label, key, sortable } = c;
    const ck = esc(key || label);
    if (!sortable) return '<th draggable="true" data-col-key="' + ck + '">' + esc(label) + '</th>';
    return '<th draggable="true" class="rp-list-sortable" data-col-key="' + ck + '" data-sort="' + ck + '">'
      + esc(label)
      + '<i class="bi bi-chevron-expand rp-list-sort-icon"></i>'
      + '</th>';
  }).join("");
  return '<section class="rt-table-wrap">'
    + '<table class="rt-table">'
    +   '<thead><tr>' + th + '</tr></thead>'
    +   '<tbody id="' + esc(tbodyId) + '"></tbody>'
    + '</table>'
    + '</section>';
}

// Toolbar shell — full Workspace-parity shape. Same button order +
// indices as workspace.html line 47-102. Em 2026-05-25 (after the
// rp-surface adoption fixed the cascade): "try to bring back the
// rt-mode buttons and all the buttons we removed". Same boring tab
// everywhere; controls disable in their natural state where the
// feature isn't wired yet, matching Workspace's no-file-open look.
//
// Wired today: search, modes (select + delete on tabs that declare
// them), refresh, rows-per-page dropdown, selection chip, sort
// chevrons in the table header.
// Disabled until their handlers land: edit mode (per-cell editing),
// row-numbers toggle (no rownum column yet on list views), columns
// picker (no prefs UI), undo/redo (no list-step history), export
// menu (no exporter), history toggle (no history panel).
//
// Spec carries:
//   { searchPlaceholder?: string|false, modes?: bool|{edit, select, delete} }
//
// `searchPlaceholder: false` suppresses the search box. `modes`
// defaults to true (all three render disabled — visual parity); object
// form enables the named modes; explicit false hides the whole group.
//
// Order mirrors workspace.html line 47-102:
//   search | edit/select/delete | undo redo refresh rownum | rowsDd
//   colsDd selChip | export history
//
// Button IDs are namespaced (#rp-list-toolbar-*) so home + monitoring
// renderers wire them via querySelector without colliding with #ws*.
export function listToolbarHTML(spec) {
  const s = spec || {};
  const parts = ['<div class="rt-toolbar rt-toolbar--data rp-list-toolbar">'];

  // filter-panel toggle — workspace puts this first in the toolbar
  // (workspace.html line 48). Opt-in via `filter: true` so Home tabs
  // (no filter panel) don't render an orphan button.
  if (s.filter) {
    parts.push(
      '<button class="rt-btn" id="rp-list-toolbar-filter" type="button" '
      +   'title="Filter panel"><i class="bi bi-funnel"></i></button>',
    );
  }

  // search
  if (s.searchPlaceholder !== false) {
    parts.push(
      '<div class="rt-search">'
      + '<i class="bi bi-search"></i>'
      + '<input type="search" id="rp-list-toolbar-search" '
      +   'placeholder="' + esc(s.searchPlaceholder || "Search…") + '" />'
      + '</div>',
      '<span class="rt-toolbar-sep"></span>',
    );
  }

  // modes — edit / select / delete.
  if (s.modes !== false) {
    const m = (typeof s.modes === "object") ? s.modes : {};
    const enable = (key) => (typeof s.modes === "object" ? !!m[key] : false);
    const dis = (key) => enable(key) ? "" : " disabled";
    parts.push(
      '<button class="rt-btn rt-mode" data-mode="edit"   type="button" '
      +   'title="Edit mode"' + dis("edit") + '><i class="bi bi-pencil"></i></button>',
      '<button class="rt-btn rt-mode" data-mode="select" type="button" '
      +   'title="Select mode"' + dis("select") + '><i class="bi bi-check2-square"></i></button>',
      '<button class="rt-btn rt-mode" data-mode="delete" type="button" '
      +   'title="Delete mode"' + dis("delete") + '><i class="bi bi-trash3"></i></button>',
      '<span class="rt-toolbar-sep"></span>',
    );
  }

  // undo / redo — list views don't model step history; render disabled,
  // matching workspace.html's no-file natural state.
  parts.push(
    '<button class="rt-btn" id="rp-list-toolbar-undo" type="button" disabled '
    +   'title="No history on list views"><i class="bi bi-arrow-return-left"></i></button>',
    '<button class="rt-btn" id="rp-list-toolbar-redo" type="button" disabled '
    +   'title="No history on list views"><i class="bi bi-arrow-return-right"></i></button>',
  );

  // refresh — wired (handler in renderListBody re-runs fetchList).
  // The row-numbers toggle that lives in workspace's #wsRownum slot
  // isn't shown here — Em 2026-05-25: "we can remove rows numbers
  // here, I don't think it will be needed". List views inventory
  // entities by name, not by sequential row index — a rownum column
  // is page-noise for that frame.
  parts.push(
    '<button class="rt-btn" id="rp-list-toolbar-refresh" type="button" '
    +   'title="Refresh"><i class="bi bi-arrow-clockwise"></i></button>',
    '<span class="rt-toolbar-sep"></span>',
  );

  // rows-per-page pill — wired to the rowsPerPageHome pref.
  parts.push(
    '<div class="rt-dd-wrap">'
    + '<button class="rt-pill" data-dd="rp-list-toolbar-rows-dd" type="button" '
    +   'title="Rows per page">'
    +   '<span id="rp-list-toolbar-rows-label">25 rows</span>'
    +   '<i class="bi bi-chevron-down chev"></i>'
    + '</button>'
    + '<div class="rt-dd" id="rp-list-toolbar-rows-dd">'
    +   '<div class="rt-dd-item" data-rows="10">10 rows</div>'
    +   '<div class="rt-dd-item" data-rows="25">25 rows</div>'
    +   '<div class="rt-dd-item" data-rows="50">50 rows</div>'
    +   '<div class="rt-dd-item" data-rows="100">100 rows</div>'
    +   '<div class="rt-dd-item" data-rows="250">250 rows</div>'
    +   '<div class="rt-dd-item" data-rows="500">500 rows</div>'
    +   '<div class="rt-dd-item" data-rows="1000">1k rows</div>'
    + '</div>'
    + '</div>',
  );

  // columns dropdown — disabled stub matching #wsColsDd's no-file state.
  parts.push(
    '<div class="rt-dd-wrap">'
    + '<button class="rt-btn" data-dd="rp-list-toolbar-cols-dd" type="button" '
    +   'title="Columns" disabled><i class="bi bi-layout-three-columns"></i></button>'
    + '<div class="rt-dd" id="rp-list-toolbar-cols-dd"><!-- columns picker — next slice --></div>'
    + '</div>',
  );

  // selection chip — shown only when a tab's modes include select.
  parts.push(
    '<span class="rt-sel-chip" id="rp-list-toolbar-sel-chip" hidden>'
    + '<i class="bi bi-check2-square"></i>'
    + '<span id="rp-list-toolbar-sel-count">0</span>&nbsp;selected'
    + '</span>',
    '<span class="rt-toolbar-sep"></span>',
  );

  // export dropdown — disabled stub. Wire when the per-tab exporter
  // lands (CSV first, XLSX/JSON next). Menu items declare data-fmt so
  // the wire-up only needs the click handler.
  parts.push(
    '<div class="rt-dd-wrap">'
    + '<button class="rt-btn" data-dd="rp-list-toolbar-export-dd" type="button" '
    +   'title="Export" disabled><i class="bi bi-download"></i></button>'
    + '<div class="rt-dd" id="rp-list-toolbar-export-dd">'
    +   '<div class="rt-dd-item" data-fmt="csv">Export as CSV</div>'
    +   '<div class="rt-dd-item" data-fmt="json">Export as JSON</div>'
    +   '<div class="rt-dd-item" data-fmt="xlsx" title="Needs backend round-trip — coming soon">'
    +     'Export as Excel <span class="rp-meta">(soon)</span>'
    +   '</div>'
    + '</div>'
    + '</div>',
  );

  // history dropdown — read-only session log of edits + deletes the
  // user has performed on the active tab. renderListBody populates
  // the dd body + enables the button when actionLog is non-empty.
  parts.push(
    '<div class="rt-dd-wrap">'
    + '<button class="rt-btn" data-dd="rp-list-toolbar-history-dd" type="button" '
    +   'title="Session history" disabled><i class="bi bi-clock-history"></i></button>'
    + '<div class="rt-dd" id="rp-list-toolbar-history-dd">'
    +   '<div class="rt-dd-item rp-meta">No actions yet</div>'
    + '</div>'
    + '</div>',
  );

  parts.push('</div>');
  return parts.join("");
}

// Wire the columns picker (show/hide + drag-reorder) and the export
// menu (CSV / JSON) on a list-page toolbar. Home + Monitoring render
// the identical listToolbarHTML + listPanel shape, so this wiring is
// shared here rather than duplicated per page (Em 2026-05-29: "wire
// columns and export in all the monitoring tables"). The dropdowns
// themselves open via the global bindDropdown delegate — this only
// fills + enables them and applies the persisted state.
//
// opts:
//   view        — page root element (scopes every query)
//   columns     — the spec's column list (string | {label,key,defaultHidden})
//   storageKey  — unique per tab; namespaces the persisted hidden-set
//                 (`rp-cols-hidden-<key>`) + order (`rp-cols-order-<key>`)
//   getRows     — () => rows[] — the current page's raw row objects, for
//                 export (the caller keeps this fresh on each fetch)
//   exportName  — base filename for exports (defaults to storageKey)
//
// Returns { applyHiddenColumns, applyColumnOrder } — call BOTH after
// every table repaint so freshly-rendered rows inherit the hide +
// order state (the caller wires these into its fetchList paint).
export function wireListColumnsExport(view, opts) {
  const { columns = [], storageKey, getRows = () => [], exportName } = opts || {};
  const name = exportName || storageKey;
  const colKey   = (c) => (typeof c === "string" ? c : (c.key || c.label));
  const colLabel = (c) => (typeof c === "string" ? c : (c.label || c.key));

  // ── hidden columns ──────────────────────────────────────────────
  // Per-tab persisted set of hidden col-keys. Untouched storage seeds
  // from the spec's `defaultHidden` flags; picker clicks override.
  const hiddenStorageKey = "rp-cols-hidden-" + storageKey;
  const hiddenRaw = localStorage.getItem(hiddenStorageKey);
  const hiddenCols = hiddenRaw === null
    ? new Set(columns.filter((c) => typeof c === "object" && c.defaultHidden).map(colKey))
    : new Set(JSON.parse(hiddenRaw));

  function applyHiddenColumns() {
    const table = view.querySelector(".rt-table");
    if (!table) return;
    [...table.querySelectorAll("thead th[data-col-key]")].forEach((th) => {
      const hide = hiddenCols.has(th.dataset.colKey);
      th.style.display = hide ? "none" : "";
      // Absolute index from the th's own position (a leading select-mode
      // checkbox column sits before the data-col-key THs when present).
      const absIdx = [...th.parentNode.children].indexOf(th) + 1;
      table.querySelectorAll(`tbody tr > *:nth-child(${absIdx})`).forEach((td) => {
        td.style.display = hide ? "none" : "";
      });
    });
  }

  function decorateColsPicker() {
    const dd  = view.querySelector("#rp-list-toolbar-cols-dd");
    const btn = view.querySelector('[data-dd="rp-list-toolbar-cols-dd"]');
    if (!dd || !btn) return;
    if (!columns.length) { btn.setAttribute("disabled", ""); return; }
    btn.removeAttribute("disabled");
    btn.title = "Show / hide columns";
    dd.innerHTML = columns.map((c) => {
      const visible = !hiddenCols.has(colKey(c));
      return '<div class="rt-dd-item' + (visible ? " selected" : "") + '" data-col-key="'
        + esc(colKey(c)) + '">' + esc(colLabel(c))
        + (visible ? '<i class="bi bi-check2 tick"></i>' : "") + '</div>';
    }).join("");
  }

  view.querySelector("#rp-list-toolbar-cols-dd")?.addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item[data-col-key]");
    if (!item) return;
    const key = item.dataset.colKey;
    if (hiddenCols.has(key)) hiddenCols.delete(key);
    else                     hiddenCols.add(key);
    localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenCols]));
    decorateColsPicker();
    applyHiddenColumns();
  });

  // ── column reorder (drag) ───────────────────────────────────────
  // Persisted at `rp-cols-order-<key>` as an ordered col-key list.
  // Reorders THs + each row's data cells; a leading .rp-list-sel
  // checkbox cell (select mode) stays anchored first.
  const orderStorageKey = "rp-cols-order-" + storageKey;
  function readColOrder() {
    try { return JSON.parse(localStorage.getItem(orderStorageKey)) || []; }
    catch { return []; }
  }
  // Resolve the live target order: persisted keys filtered to keys that
  // still live in the spec, plus any new keys (not yet persisted) appended
  // at the end so a spec growth doesn't force a hard reset.
  function targetColumnOrder(byKey) {
    const out = readColOrder().filter((k) => byKey.has(k));
    [...byKey.keys()].forEach((k) => { if (!out.includes(k)) out.push(k); });
    return out;
  }
  // Classes for non-data sentinel cells the reorder must preserve in
  // place: `.rp-list-sel` is the LEADING select-mode checkbox column,
  // `.rp-list-hide-th` / `.rp-list-hide-cell` is the TRAILING hide-from-
  // list action column (home tabs that declare `spec.hideMeta`). Neither
  // carries `data-col-key`, neither participates in reorder, and both
  // must stay at their original ends after the data cells move.
  const SENTINEL_LEADING_CELL  = "rp-list-sel";
  const SENTINEL_TRAILING_TH   = "rp-list-hide-th";
  const SENTINEL_TRAILING_CELL = "rp-list-hide-cell";
  // Reorder THs in `headRow` and each tbody row's data cells from
  // `currentOrder` (the order the data cells are CURRENTLY in) to
  // `targetKeys`. Idempotent — no-ops when both already match target.
  // Leading select-mode checkbox and trailing hide-action column stay
  // anchored at their original positions (see SENTINEL_* above).
  // 2026-05-31: pre-fix used `headRow.appendChild(byKey.get(k))` per
  // target key, which pushes each data TH to the very end of headRow —
  // when a trailing sentinel TH (e.g. `.rp-list-hide-th`) was already
  // there, every appendChild shoved it one column to the left, so after
  // N appends the trailing TH ended up at position 0. That made every
  // subsequent positional indexing in `applyHiddenColumns` off-by-one
  // and the header→cell mapping shift by one (data showing under the
  // wrong header). Now anchored via insertBefore the trailing sentinel.
  function reorderColumnDOM(headRow, tbody, currentOrder, targetKeys, byKey) {
    const currentTH = [...headRow.querySelectorAll("th[data-col-key]")]
      .map((th) => th.dataset.colKey);
    const thsAligned   = targetKeys.every((k, i) => currentTH[i] === k);
    const cellsAligned = targetKeys.every((k, i) => currentOrder[i] === k);
    if (thsAligned && cellsAligned) return;
    // Find a trailing sentinel TH (no data-col-key, comes after at least
    // one data-col-key TH) to anchor data TH insertions BEFORE it.
    let anchorTH = null;
    let seenDataKey = false;
    for (const child of headRow.children) {
      if (child.dataset.colKey) { seenDataKey = true; continue; }
      if (seenDataKey) { anchorTH = child; break; }
    }
    if (!thsAligned) {
      if (anchorTH) {
        targetKeys.forEach((k) => headRow.insertBefore(byKey.get(k), anchorTH));
      } else {
        targetKeys.forEach((k) => headRow.appendChild(byKey.get(k)));
      }
    }
    if (!tbody || cellsAligned) return;
    const currentIndex = new Map(currentOrder.map((k, i) => [k, i]));
    tbody.querySelectorAll("tr").forEach((tr) => {
      const selCell   = tr.querySelector("." + SENTINEL_LEADING_CELL);
      const hideCell  = tr.querySelector("." + SENTINEL_TRAILING_CELL);
      // Data cells are the children minus the sentinels — these are the
      // only ones the reorder touches.
      const dataCells = [...tr.children].filter((td) =>
        !td.classList.contains(SENTINEL_LEADING_CELL)
        && !td.classList.contains(SENTINEL_TRAILING_CELL)
      );
      const reordered = targetKeys.map((k) => dataCells[currentIndex.get(k)]);
      while (tr.firstChild) tr.removeChild(tr.firstChild);
      if (selCell)  tr.appendChild(selCell);
      reordered.forEach((cell) => cell && tr.appendChild(cell));
      if (hideCell) tr.appendChild(hideCell);
    });
  }
  // Post-fetchList hook. fetchList wholesale rewrites `tbody.innerHTML`,
  // so the freshly-painted data cells are in SPEC order even when THs
  // were left in a prior target order by an earlier drag-reorder. Pass
  // spec keys as `currentOrder` so the cell→position mapping is correct
  // regardless of TH state. (Pre-2026-05-30 bug: function early-returned
  // when THs matched target, leaving tbody in spec order — every column
  // showed the wrong data after any fetchList repaint.)
  function applyColumnOrder() {
    const table = view.querySelector(".rt-table");
    if (!table) return;
    const headRow = table.querySelector("thead tr");
    if (!headRow) return;
    const ths = [...headRow.querySelectorAll("th[data-col-key]")];
    if (ths.length === 0) return;
    const tbody = table.querySelector("tbody");
    const byKey = new Map(ths.map((th) => [th.dataset.colKey, th]));
    const specOrder  = columns.map(colKey).filter((k) => byKey.has(k));
    const targetKeys = targetColumnOrder(byKey);
    reorderColumnDOM(headRow, tbody, specOrder, targetKeys, byKey);
  }

  const headEl = view.querySelector(".rt-table thead");
  function clearDropIndicators() {
    headEl?.querySelectorAll("th.is-drop-before, th.is-drop-after")
      .forEach((el) => el.classList.remove("is-drop-before", "is-drop-after"));
  }
  headEl?.addEventListener("dragstart", (e) => {
    const th = e.target.closest("th[data-col-key]");
    if (!th) return;
    e.dataTransfer.setData("text/col-key", th.dataset.colKey);
    e.dataTransfer.effectAllowed = "move";
    th.classList.add("is-dragging");
  });
  headEl?.addEventListener("dragend", (e) => {
    e.target.closest("th[data-col-key]")?.classList.remove("is-dragging");
    clearDropIndicators();
  });
  headEl?.addEventListener("dragover", (e) => {
    const th = e.target.closest("th[data-col-key]");
    if (!th) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = th.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    clearDropIndicators();
    th.classList.add(before ? "is-drop-before" : "is-drop-after");
  });
  headEl?.addEventListener("drop", (e) => {
    const tgt = e.target.closest("th[data-col-key]");
    if (!tgt) return;
    e.preventDefault();
    const srcKey = e.dataTransfer.getData("text/col-key");
    const tgtKey = tgt.dataset.colKey;
    clearDropIndicators();
    if (!srcKey || srcKey === tgtKey) return;
    const rect = tgt.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    // Snapshot the CURRENT DOM order — at drop time tbody data cells and
    // THs are in lockstep (applyColumnOrder runs as the post-fetchList
    // hook and re-aligns them to the persisted target before any drag
    // begins, so `currentOrder` describes both halves).
    const ths = [...headEl.querySelectorAll("th[data-col-key]")];
    const currentOrder = ths.map((th) => th.dataset.colKey);
    const srcIdx = currentOrder.indexOf(srcKey);
    const tgtIdx = currentOrder.indexOf(tgtKey);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const newOrder = [...currentOrder];
    newOrder.splice(srcIdx, 1);
    const adjTgt = tgtIdx > srcIdx ? tgtIdx - 1 : tgtIdx;
    newOrder.splice(before ? adjTgt : adjTgt + 1, 0, srcKey);
    localStorage.setItem(orderStorageKey, JSON.stringify(newOrder));
    // Inline reorder — DOM matches `currentOrder` exactly here, so this
    // is the one call site where `applyColumnOrder()`'s spec-order
    // assumption would NOT hold; pass currentOrder explicitly instead.
    const byKey = new Map(ths.map((th) => [th.dataset.colKey, th]));
    const tbody = view.querySelector(".rt-table tbody");
    const headRow = headEl.querySelector("tr");
    reorderColumnDOM(headRow, tbody, currentOrder, newOrder, byKey);
  });

  // ── export (CSV / JSON) ─────────────────────────────────────────
  // Builds client-side from getRows() (the current page). Only visible
  // columns are exported. XLSX needs a backend round-trip — that menu
  // item stays a soft "coming soon" alert.
  const visibleColumns = () => columns.filter((c) => !hiddenCols.has(colKey(c)));
  const csvEscape = (val) => {
    if (val == null) return "";
    const s = String(val);
    return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const downloadBlob = (text, mime, filename) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  function exportCsv() {
    const cols = visibleColumns();
    const rows = getRows();
    if (!cols.length || !rows.length) return;
    const header = cols.map((c) => csvEscape(colLabel(c))).join(",");
    const lines  = rows.map((r) => cols.map((c) => csvEscape(r[colKey(c)])).join(","));
    downloadBlob([header, ...lines].join("\n"), "text/csv;charset=utf-8", name + "-" + stamp() + ".csv");
  }
  function exportJson() {
    const cols = visibleColumns();
    const rows = getRows();
    if (!cols.length || !rows.length) return;
    const keys = cols.map(colKey);
    const out  = rows.map((r) => { const o = {}; keys.forEach((k) => { o[k] = r[k] ?? null; }); return o; });
    downloadBlob(JSON.stringify(out, null, 2), "application/json", name + "-" + stamp() + ".json");
  }

  const exportBtn = view.querySelector('[data-dd="rp-list-toolbar-export-dd"]');
  if (exportBtn) { exportBtn.removeAttribute("disabled"); exportBtn.title = "Export current page"; }
  view.querySelector("#rp-list-toolbar-export-dd")?.addEventListener("click", (e) => {
    const item = e.target.closest(".rt-dd-item[data-fmt]");
    if (!item) return;
    switch (item.dataset.fmt) {
      case "csv":  exportCsv();  break;
      case "json": exportJson(); break;
      case "xlsx":
        alert("XLSX export needs a backend round-trip — coming soon. CSV / JSON work today.");
        break;
    }
  });

  // Initial paint.
  decorateColsPicker();
  applyHiddenColumns();
  applyColumnOrder();

  return { applyHiddenColumns, applyColumnOrder };
}

// Single pager button. Disabled buttons drop the data-page attr so
// the delegated click handler skips them naturally.
export function pagerBtn(label, page, active, disabled) {
  return '<button class="rt-pg' + (active ? " active" : "") + '" type="button"'
    + (disabled ? " disabled" : ' data-page="' + page + '"') + ">" + label + "</button>";
}

// ── DOM mutation ────────────────────────────────────────────────

// Set a KPI tile's value, no-op if the tile isn't mounted. View-
// scoped so this only touches the page's own DOM, not the global
// document (matters when N pages co-exist in tests).
export function setKpi(view, id, val) {
  const el = view.querySelector("#" + id);
  if (el) el.textContent = val;
}

// ── pager ───────────────────────────────────────────────────────

// Render the pager into <view #pagerId>. state = {
//   page, totalPages,
//   total?: number,   // total row count (drives the rows-info readout)
//   shown?: number,   // rows on the current page
//   pageSize?: number // rows-per-page (so we can compute the X–Y range)
// }
// Elides middle pages when totalPages > 7 (1, …, neighbours, …, N).
// Emits the Workspace-parity shape: .rt-rows-info on the left (uses
// `margin-right: auto` in pager.css to push the pages right) + .rt-pages
// on the right. When the optional fields are absent, the rows-info
// renders empty so the pages still anchor right via flex-end.
export function renderListPager(view, pagerId, state) {
  const el = view.querySelector("#" + pagerId);
  if (!el || state.totalPages < 1) { if (el) el.innerHTML = ""; return; }
  const p = state.page, last = state.totalPages;

  // rows-info readout — "Rows {from}–{to} of {total}" when we have the
  // counts; the empty span still reserves the flex slot so the layout
  // stays consistent across tabs.
  let info = "";
  if (state.total != null && state.pageSize != null) {
    const size = state.pageSize;
    const from = (p - 1) * size + 1;
    const to = state.shown != null ? Math.min((p - 1) * size + state.shown, state.total) : Math.min(p * size, state.total);
    if (state.total === 0) info = "No rows";
    else info = `Rows ${from.toLocaleString()}–${to.toLocaleString()} of ${state.total.toLocaleString()}`;
  }

  const out = [];
  out.push(pagerBtn("‹", p - 1, false, p === 1));
  if (last <= 7) {
    for (let i = 1; i <= last; i++) out.push(pagerBtn(String(i), i, i === p, false));
  } else {
    const want = new Set([1, last, p, p - 1, p + 1]);
    let prev = 0;
    for (let i = 1; i <= last; i++) {
      if (!want.has(i)) continue;
      if (i - prev > 1) out.push('<span class="rt-pg-gap">…</span>');
      out.push(pagerBtn(String(i), i, i === p, false));
      prev = i;
    }
  }
  out.push(pagerBtn("›", p + 1, false, p === last));
  el.innerHTML = '<span class="rt-rows-info">' + esc(info) + '</span>'
    + '<div class="rt-pages">' + out.join("") + '</div>';
}

// ── chart lifecycle ─────────────────────────────────────────────

// kind → helper map. Decoupled from the page specs so a tab's spec
// just declares `kind: "donut"` and we look up the function here.
const CHART_KINDS = {
  donut: kpiDonut, bar: kpiBar, barH: kpiBarH, gauge: kpiGauge,
  line:  kpiLine,  pie: kpiPie, rose:  kpiRose,
};

// Build the /stats URL — flat string or a function of chipState.
// Memberships' stats endpoint reads ?scope=…; others are flat.
// When `spec.chipRows` is declared but `spec.statsEndpoint` isn't,
// chip values are folded into the default `${endpoint}/stats` URL
// as query params.
export function statsUrlFor(spec, chipState) {
  if (typeof spec.statsEndpoint === "function") return spec.statsEndpoint(chipState || {});
  if (spec.statsEndpoint) return spec.statsEndpoint;
  const base = spec.endpoint + "/stats";
  const chips = spec.chipRows || [];
  if (!chips.length || !chipState) return base;
  const params = new URLSearchParams();
  chips.forEach((cr) => { if (chipState[cr.name]) params.set(cr.name, chipState[cr.name]); });
  const qs = params.toString();
  return qs ? base + "?" + qs : base;
}

// Per-page chart controller. Each page calls createListCharts(view)
// once, then mount/dispose around tab switches + chip flips. View is
// the DOM root the chart canvases live in. Resize handler attaches
// lazily on first mount and reflows the active set on window resize.
let resizeWired = false;
const allInstances = [];   // module-level so the resize handler can
                            // reach every page's instances at once.

export function createListCharts(view, opts = {}) {
  const tag = opts.logPrefix || "list-page";
  let instances = [];

  if (!resizeWired) {
    resizeWired = true;
    window.addEventListener("resize", () => {
      allInstances.forEach((inst) => { try { inst.resize(); } catch { /* ignore */ } });
    });
  }

  function dispose() {
    instances.forEach((inst) => {
      try { inst.dispose(); } catch { /* already gone */ }
      const i = allInstances.indexOf(inst);
      if (i >= 0) allInstances.splice(i, 1);
    });
    instances = [];
  }

  async function mount(spec, chipState) {
    if (!spec.charts || !spec.charts.length) return;
    const statsUrl = statsUrlFor(spec, chipState);
    let stats;
    try { stats = await api.get(statsUrl); }
    catch (err) {
      console.warn("[" + tag + "] stats fetch failed for", statsUrl, err);
      return;
    }
    mountData(spec, stats);
  }

  // Render charts from data already in hand — no /stats fetch. The
  // overview surfaces (Cases board, Workspace landing) hold the cases /
  // projects roster already, so their hero charts derive client-side via
  // each chart's data(stats) callback (e.g. reduce the roster by status)
  // instead of paying a second round-trip on every repaint.
  function mountData(spec, stats) {
    if (!spec.charts || !spec.charts.length) return;
    spec.charts.forEach((c) => {
      const el = view.querySelector("#" + c.id);
      if (!el) return;
      const fn = CHART_KINDS[c.kind];
      if (!fn) { console.warn("[" + tag + "] unknown chart kind:", c.kind); return; }
      const data = c.data ? c.data(stats) : stats;
      const inst = fn(el, data, c.opts || {});
      if (inst) { instances.push(inst); allInstances.push(inst); }
    });
  }

  // resize() can be called by the page when its own layout changes
  // (e.g. a side panel opens) — same effect as the global listener
  // but scoped to this controller's instances.
  function resize() {
    instances.forEach((inst) => { try { inst.resize(); } catch { /* ignore */ } });
  }

  return { mount, mountData, dispose, resize };
}
