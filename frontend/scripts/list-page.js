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
//   - CSS class `.rp-home-charts` is shared across both pages today
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

// One card per chart in the spec. Each card carries a small title +
// a 180px-tall canvas; createListCharts().mount initialises ECharts
// against the canvas after the /stats fetch resolves.
export function chartsStripHTML(charts) {
  if (!charts || !charts.length) return "";
  return '<div class="rp-home-charts">'
    + charts.map((c) =>
        '<div class="rp-home-chart-card">'
        + '<div class="rp-home-chart-title">' + esc(c.title || "") + '</div>'
        + '<div class="rp-home-chart-canvas" id="' + esc(c.id) + '"></div>'
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
        + ' data-value="' + esc(opt.value) + '">' + esc(opt.label) + '</button>'
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
    if (typeof c === "string") return '<th>' + esc(c) + '</th>';
    const { label, key, sortable } = c;
    if (!sortable) return '<th>' + esc(label) + '</th>';
    return '<th class="rp-list-sortable" data-sort="' + esc(key || label) + '">'
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
// rt-surface adoption fixed the cascade): "try to bring back the
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
  parts.push(
    '<button class="rt-btn" id="rp-list-toolbar-refresh" type="button" '
    +   'title="Refresh"><i class="bi bi-arrow-clockwise"></i></button>',
  );

  // row-numbers toggle — list-view tables don't currently emit a
  // .col-rownum column. Disabled until that lands.
  parts.push(
    '<button class="rt-btn" id="rp-list-toolbar-rownum" type="button" disabled '
    +   'title="Row numbers (no rownum column on list views)">'
    +   '<i class="bi bi-list-ol"></i></button>',
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
    +   '<div class="rt-dd-item" data-rows="all">All rows</div>'
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
    +   '<div class="rt-dd-item" data-fmt="xlsx">Export as Excel</div>'
    +   '<div class="rt-dd-item" data-fmt="json">Export as JSON</div>'
    + '</div>'
    + '</div>',
  );

  // history toggle — disabled stub matching #wsHistoryToggle. List
  // views don't model an undoable history.
  parts.push(
    '<button class="rt-btn" id="rp-list-toolbar-history" type="button" disabled '
    +   'title="No history on list views"><i class="bi bi-clock-history"></i></button>',
  );

  parts.push('</div>');
  return parts.join("");
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

  return { mount, dispose, resize };
}
