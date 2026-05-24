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

export function listPanel(columns, tbodyId) {
  return '<section class="rp-mon-panel">'
    + '<table class="rp-mon-table">'
    +   '<thead><tr>' + columns.map((c) => '<th>' + esc(c) + '</th>').join("") + '</tr></thead>'
    +   '<tbody id="' + esc(tbodyId) + '"></tbody>'
    + '</table>'
    + '</section>';
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

// Render the pager into <view #pagerId>. state = { page, totalPages }.
// Elides middle pages when totalPages > 7 (1, …, neighbours, …, N).
export function renderListPager(view, pagerId, state) {
  const el = view.querySelector("#" + pagerId);
  if (!el || state.totalPages < 1) { if (el) el.innerHTML = ""; return; }
  const p = state.page, last = state.totalPages;
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
  el.innerHTML = '<div class="rt-pages">' + out.join("") + '</div>';
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
