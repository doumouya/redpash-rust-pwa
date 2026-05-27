// Designer — the chart/dashboard authoring surface.
//
// Ported from the prototype at red-front/designer.html (commit
// 6729f80 in that repo). Same shape:
//   - canvas (12-col grid of tiles)
//   - right-side accordion (Chart type / Data / Axes / Legend /
//     Tooltip / Style)
//   - three chart themes (Vintage / Latte / Mocha) authored
//     separately from the app's chrome theme
// Rewired for redpash-app: tiles render REAL CHT_ files via
// /api/charts; spec edits write back through PUT /api/charts/:rid.
//
// Slice scope (today): one tile = the open CHT_ file (single-chart
// canvas). Dashboard files (multi-tile, project_files.file_type=
// 'dashboard') need a new file_type + spec shape; that's Phase 2.
//
// ctx: { designerEl, getSource() → { rid, columns }, onSaved(chart) }
//   - designerEl: container DOM element (.rt-designer) where the
//                 canvas + accordion render
//   - getSource:  () => { rid, columns } for the chart's source
//                 data file (so the Data section + future live
//                 preview have something to render against)
//   - onSaved:    callback after a successful PUT /charts/:rid

import { api } from "/scripts/api.js";
import { ensureRegisteredThemes } from "/scripts/echarts-theme.js";
import { esc } from "/scripts/dom.js";
// THEMES / TYPE_TO_KIND / TYPE_LIST / SMOOTHABLE / buildOption lifted
// into /scripts/charts/build.js (Slice A of the chart-pipeline
// unification — Em 2026-05-27). Pure refactor; this module imports
// what it used to define locally so the Settings-driven Monitoring
// chart picker (Slice D) can share the same vocabulary.
import {
  THEMES, TYPE_TO_KIND, TYPE_LIST, SMOOTHABLE, buildOption,
} from "/scripts/charts/build.js";

// Defaults applied to a new chart cfg. Mirrors the prototype's D
// plus the modifiers added in C3.1 (smooth for line/area).
const DEFAULTS = {
  legend: false, legendPos: "bottom",
  tooltip: true, splitLines: true, axisLine: true,
  theme: "vintage",
  smooth: false,
};

export function mountDesigner(designerEl, ctx) {
  // Kick off theme registration once per page so the first chart
  // init that uses redpash-mocha / redpash-latte already has them
  // loaded. Fire-and-forget — failed loads fall through to the
  // inline themes silently.
  ensureRegisteredThemes();

  // state — tiles[] holds one entry per chart in the canvas. For
  // C2 / single-chart there's at most one entry (the open CHT_
  // file). The shape generalises to multi-tile when dashboards land.
  let tiles = [];        // [{ rid, chart, cfg, inst, tileEl, themeName }]
  let sel   = null;      // currently-selected tile entry
  let dirty = false;     // any unsaved spec changes
  let busy  = false;     // PUT in flight

  // Build the static shell once. Tiles + accordion content render
  // into stable children so toggles + edits don't re-create the
  // ECharts instances.
  designerEl.innerHTML = ''
    + '<div class="ds-canvas">'
    +   '<div class="ds-grid" id="dsGrid"></div>'
    + '</div>'
    + '<aside class="ds-config" id="dsConfig">'
    +   '<div class="ds-config-head">'
    +     '<span class="ds-config-title"><i class="bi bi-sliders"></i> Chart</span>'
    +     '<button class="ds-config-save rt-btn rt-btn--accent" type="button" disabled>'
    +       '<i class="bi bi-save"></i> Save'
    +     '</button>'
    +   '</div>'
    +   '<div class="ds-config-body" id="dsAcc"></div>'
    + '</aside>';
  const gridEl = designerEl.querySelector("#dsGrid");
  const accEl  = designerEl.querySelector("#dsAcc");
  const saveBtn = designerEl.querySelector(".ds-config-save");

  // ── load ──────────────────────────────────────────────────────────
  // Called from workspace.js when a chart or dashboard file opens.
  //   payload = { type: "chart", chart }
  //     → single-tile canvas, the open CHT_ takes the full row.
  //   payload = { type: "dashboard", dashboard }
  //     → multi-tile canvas, one tile per chart-kind widget.
  //       Widgets are { slot, kind, spec: { chart_id, ... } }; we
  //       fetch each chart in parallel via /api/charts/:id, then
  //       render. Other widget kinds (kpi/table/text/report) defer.
  //   payload = null → teardown to empty state.
  let dashboard = null;
  async function load(payload) {
    teardown();
    if (!payload) { renderCanvasEmpty(); return; }
    if (payload.type === "chart") {
      mountChartTile(payload.chart, /* span */ "span-12", /* selected */ true);
      return;
    }
    if (payload.type === "dashboard") {
      dashboard = payload.dashboard;
      const widgets = (dashboard?.spec?.widgets || []).filter((w) => w.kind === "chart");
      if (!widgets.length) {
        renderCanvasEmpty();
        if (gridEl) gridEl.innerHTML = '<p class="ds-empty">Empty dashboard. Use <i>Add chart</i> to add a widget.</p>';
        return;
      }
      // Fetch every chart in parallel — multi-tile dashboards open
      // faster when the fetches go simultaneous rather than serial.
      // Failed fetches render an error placeholder tile; one bad
      // chart doesn't blank the whole canvas.
      gridEl.innerHTML = '<p class="ds-empty">Loading widgets…</p>';
      const fetches = widgets.map((w) =>
        api.get("/charts/" + encodeURIComponent(w.spec?.chart_id || "")).catch((err) => ({ __err: err, widget: w })));
      const results = await Promise.all(fetches);
      gridEl.innerHTML = "";
      results.forEach((res, i) => {
        const w = widgets[i];
        if (res?.__err) {
          gridEl.appendChild(makeErrorTile(w, res.__err));
          return;
        }
        // Default span — alternate 6/6 for now. Slot/template-aware
        // sizing comes when the template registry lands.
        const span = "span-6";
        mountChartTile(res, span, /* selected */ false, w);
      });
      // Select the first successfully-loaded tile so the accordion
      // has content.
      if (tiles.length) selectTile(tiles[0]);
      return;
    }
  }

  // Mount a chart-kind tile into the canvas + push to the tiles[]
  // registry. Returns the entry. Used by both single-chart and
  // dashboard load paths.
  function mountChartTile(chart, spanClass, selected, widget) {
    if (!chart) return null;
    const cfg = mergeCfg(chart);
    const tileEl = makeTile(chart, cfg, !!selected, spanClass || "span-12");
    gridEl.appendChild(tileEl);
    const t = THEMES[cfg.theme] || THEMES.vintage;
    const themeName = t.registered ? cfg.theme : undefined;
    const inst = window.echarts?.init(tileEl.querySelector(".ds-chart"), themeName);
    if (inst) inst.setOption(buildOption(cfg, t));
    const entry = { rid: chart.redpash_id, chart, cfg, inst, tileEl,
                    widget: widget || null, themeName };
    tiles.push(entry);
    return entry;
  }

  function makeErrorTile(widget, err) {
    const el = document.createElement("div");
    el.className = "ds-tile ds-tile--error span-6";
    el.innerHTML = ''
      + '<div class="ds-tile-head"><span class="ds-tile-title">Chart unavailable</span></div>'
      + '<div class="ds-tile-body"><div class="ds-tile-err">'
      +   '<i class="bi bi-exclamation-triangle"></i> '
      +   esc(err?.body?.message || err?.message || "couldn\'t fetch widget")
      + '</div></div>';
    return el;
  }

  function teardown() {
    tiles.forEach((t) => t.inst?.dispose?.());
    tiles = [];
    sel = null;
    dashboard = null;
    dirty = false;
    busy = false;
    if (gridEl) gridEl.innerHTML = "";
    if (accEl)  accEl.innerHTML  = "";
    if (saveBtn) saveBtn.disabled = true;
  }

  function renderCanvasEmpty() {
    if (gridEl) gridEl.innerHTML = '<p class="ds-empty">No chart loaded.</p>';
    if (accEl)  accEl.innerHTML  = "";
    if (saveBtn) saveBtn.disabled = true;
  }

  // Merge the saved chart.spec with display defaults so the
  // accordion always has values to render against. Storage shape:
  //   chart.spec = { kind, type, title, legend, legendPos, tooltip,
  //                  splitLines, axisLine, theme, option }
  // Older charts (saved by the inline strip from C1) carry only
  // { kind, group_by, agg_col, agg_fn, title, option }. We project
  // those into the richer shape so they still render.
  function mergeCfg(chart) {
    const s = chart?.spec || {};
    const type = s.type || s.kind || "bar";
    const kind = TYPE_TO_KIND[type] || "cartesian";
    return {
      kind,
      type,
      title: s.title || chart?.title || "Untitled chart",
      legend:     s.legend     ?? DEFAULTS.legend,
      legendPos:  s.legendPos  || DEFAULTS.legendPos,
      tooltip:    s.tooltip    ?? DEFAULTS.tooltip,
      splitLines: s.splitLines ?? DEFAULTS.splitLines,
      axisLine:   s.axisLine   ?? DEFAULTS.axisLine,
      smooth:     s.smooth     ?? DEFAULTS.smooth,
      theme:      s.theme      || DEFAULTS.theme,
      // Keep around so the prior baked option can render until the
      // user re-saves (live re-build replaces it on any edit).
      option:     s.option     || null,
      // Carry the data-shape fields too — the Data section reads
      // them; future preview-from-source uses them to /group/preview.
      group_by: s.group_by || "",
      agg_col:  s.agg_col  || "*",
      agg_fn:   s.agg_fn   || "count",
    };
  }

  // ── canvas / tiles ────────────────────────────────────────────────
  function makeTile(chart, cfg, selected, spanClass) {
    const el = document.createElement("div");
    el.className = "ds-tile" + (selected ? " selected" : "") + " " + (spanClass || "span-12");
    el.dataset.rid = chart.redpash_id;
    el.innerHTML = ''
      + '<div class="ds-tile-head">'
      +   '<span class="ds-tile-title">' + esc(cfg.title) + '</span>'
      +   '<span class="ds-tile-menu"><i class="bi bi-three-dots"></i></span>'
      + '</div>'
      + '<div class="ds-tile-body"><div class="ds-chart"></div></div>';
    return el;
  }

  // ── accordion ─────────────────────────────────────────────────────
  // Six sections — type / data / axes / legend / tooltip / style.
  // Re-rendered on selection change so values reflect the picked
  // tile; per-section edits write through to sel.cfg + rerender.
  function renderAccordion() {
    if (!sel) { accEl.innerHTML = ""; return; }
    const cfg = sel.cfg;
    // Flattened type grid — every kind in one place so the user can
    // switch any chart to any other shape without leaving the picker.
    // Family grouping is implicit in adjacency (cartesian first, then
    // barh, scatter, pie variants, radar, gauge, pictorial).
    const typeBtns = TYPE_LIST.map(([t, icon, label]) =>
      '<button type="button" class="ds-type-btn' + (t === cfg.type ? " active" : "") + '"'
      + ' data-type="' + esc(t) + '"><i class="bi ' + esc(icon) + '"></i>' + esc(label)
      + '</button>').join('');
    const themeRows = Object.entries(THEMES).map(([key, t]) =>
      '<button type="button" class="ds-theme-opt' + (key === cfg.theme ? " active" : "") + '"'
      + ' data-theme="' + esc(key) + '">'
      + '<span class="ds-sw">' + t.series.slice(0, 5).map((c) =>
          '<i style="background:' + c + '"></i>').join('') + '</span>'
      + '<span>' + esc(t.name) + '</span>'
      + (key === cfg.theme ? '<i class="bi bi-check2 ds-check"></i>' : '')
      + '</button>').join('');
    const src = ctx.getSource?.() || { rid: null, columns: [] };
    const sourceLabel = src.rid ? src.rid : "(no source bound)";
    accEl.innerHTML = ''
      + section("type",    "bi-bar-chart",      "Chart type", true,
          '<div class="ds-type-grid">' + typeBtns + '</div>'
          + '<span class="ds-lbl">Title</span>'
          + '<input class="ds-input" data-key="title" value="' + esc(cfg.title) + '" />')
      + section("data",    "bi-database",       "Data", false,
          '<span class="ds-lbl">Source view</span>'
          + '<div class="ds-source"><i class="bi bi-filetype-csv"></i> ' + esc(sourceLabel) + '</div>'
          + '<span class="ds-lbl">Group by</span>'
          + '<div class="ds-chip-row">'
          +   (cfg.group_by
                ? '<span class="ds-chip">' + esc(cfg.group_by) + '</span>'
                : '<span class="ds-muted">— not set</span>')
          + '</div>'
          + '<span class="ds-lbl">Measure</span>'
          + '<div class="ds-chip-row">'
          +   '<span class="ds-chip">' + esc(cfg.agg_fn) + '('
          +     esc(cfg.agg_col === "*" ? "*" : cfg.agg_col) + ')</span>'
          + '</div>')
      + section("axes",    "bi-rulers",         "Axes", false,
          (["pie", "gauge", "radar"].includes(cfg.kind)
            ? '<p class="ds-muted">Axes don\'t apply to this chart kind.</p>'
            : toggleRow("splitLines", cfg.splitLines, "Show split lines")
              + toggleRow("axisLine", cfg.axisLine, "Show axis line")))
      + section("legend",  "bi-list-ul",        "Legend", false,
          toggleRow("legend", cfg.legend, "Show legend")
          + '<span class="ds-lbl">Position</span>'
          + '<select class="ds-input" data-key="legendPos">'
          +   '<option value="bottom"' + (cfg.legendPos === "bottom" ? " selected" : "") + '>Bottom</option>'
          +   '<option value="top"'    + (cfg.legendPos === "top"    ? " selected" : "") + '>Top</option>'
          + '</select>')
      + section("tooltip", "bi-chat-square-text", "Tooltip", false,
          toggleRow("tooltip", cfg.tooltip, "Show tooltip on hover"))
      + section("style",   "bi-palette",        "Style", false,
          (SMOOTHABLE.has(cfg.type)
            ? toggleRow("smooth", cfg.smooth, "Smooth lines")
            : "")
          + '<span class="ds-lbl">Chart theme</span>'
          + '<div class="ds-theme-opts">' + themeRows + '</div>');
  }
  function section(name, icon, label, open, body) {
    return '<div class="ds-sec' + (open ? " open" : "") + '" data-sec="' + esc(name) + '">'
      + '<button class="ds-sec-head" type="button">'
      +   '<i class="bi bi-chevron-down ds-sec-caret"></i>'
      +   '<i class="bi ' + esc(icon) + ' ds-sec-icon"></i>'
      +   '<span class="ds-sec-label">' + esc(label) + '</span>'
      + '</button>'
      + '<div class="ds-sec-body">' + body + '</div>'
      + '</div>';
  }
  function toggleRow(key, on, label) {
    return '<label class="ds-toggle-row">'
      + '<input type="checkbox" data-key="' + esc(key) + '"' + (on ? " checked" : "") + ' /> '
      + esc(label) + '</label>';
  }

  // ── selection ─────────────────────────────────────────────────────
  function selectTile(entry) {
    sel = entry;
    tiles.forEach((t) => t.tileEl.classList.toggle("selected", t === entry));
    renderAccordion();
  }

  // ── rerender / dirty / save ───────────────────────────────────────
  // Theme swap requires dispose+reinit when EITHER the old or new
  // theme is registered (ECharts can't swap themes after init).
  // Same-theme rerenders just setOption.
  function rerender(entry) {
    if (!entry?.tileEl) return;
    const t = THEMES[entry.cfg.theme] || THEMES.vintage;
    const nextThemeName = t.registered ? entry.cfg.theme : undefined;
    if (entry.themeName !== nextThemeName) {
      entry.inst?.dispose?.();
      const el = entry.tileEl.querySelector(".ds-chart");
      if (el) el.innerHTML = "";
      entry.inst = window.echarts?.init(el, nextThemeName);
      entry.themeName = nextThemeName;
    }
    entry.inst?.setOption?.(buildOption(entry.cfg, t), true);
  }
  function setDirty(on) {
    dirty = on;
    if (saveBtn) saveBtn.disabled = !on || busy;
  }

  async function save() {
    if (!sel || busy) return;
    busy = true; saveBtn.disabled = true;
    try {
      const baked = sel.inst?.getOption?.() || null;
      const body = {
        source_file_id: sel.chart.source_file_id,
        title:          sel.cfg.title,
        spec: {
          kind:       sel.cfg.kind,
          type:       sel.cfg.type,
          title:      sel.cfg.title,
          legend:     sel.cfg.legend,
          legendPos:  sel.cfg.legendPos,
          tooltip:    sel.cfg.tooltip,
          splitLines: sel.cfg.splitLines,
          axisLine:   sel.cfg.axisLine,
          smooth:     sel.cfg.smooth,
          theme:      sel.cfg.theme,
          group_by:   sel.cfg.group_by,
          agg_col:    sel.cfg.agg_col,
          agg_fn:     sel.cfg.agg_fn,
          option:     baked,
        },
      };
      const saved = await api.put("/charts/" + encodeURIComponent(sel.rid), body);
      sel.chart = saved;
      ctx.onSaved?.(saved);
      setDirty(false);
    } catch (err) {
      console.warn("[designer] save failed:", err);
    } finally {
      busy = false;
      if (saveBtn) saveBtn.disabled = !dirty;
    }
  }

  // ── handlers ──────────────────────────────────────────────────────
  // Canvas: click a tile to select.
  gridEl.addEventListener("click", (e) => {
    const t = e.target.closest(".ds-tile");
    if (!t) return;
    const entry = tiles.find((x) => x.tileEl === t);
    if (entry) selectTile(entry);
  });

  // Accordion: section toggle + type-grid + theme + form fields.
  accEl.addEventListener("click", (e) => {
    const head = e.target.closest(".ds-sec-head");
    if (head) { head.parentElement.classList.toggle("open"); return; }
    const tBtn = e.target.closest(".ds-type-btn");
    if (tBtn && sel) {
      sel.cfg.type = tBtn.dataset.type;
      sel.cfg.kind = TYPE_TO_KIND[sel.cfg.type] || sel.cfg.kind;
      renderAccordion();
      rerender(sel);
      setDirty(true);
      return;
    }
    const themeBtn = e.target.closest(".ds-theme-opt");
    if (themeBtn && sel) {
      sel.cfg.theme = themeBtn.dataset.theme;
      renderAccordion();
      rerender(sel);
      setDirty(true);
      return;
    }
  });
  accEl.addEventListener("input", (e) => {
    if (!sel) return;
    const fld = e.target.closest("[data-key]");
    if (!fld) return;
    const key = fld.dataset.key;
    if (key === "title") {
      sel.cfg.title = e.target.value;
      sel.tileEl.querySelector(".ds-tile-title").textContent = e.target.value || "Untitled chart";
      setDirty(true);
    }
  });
  accEl.addEventListener("change", (e) => {
    if (!sel) return;
    const fld = e.target.closest("[data-key]");
    if (!fld) return;
    const key = fld.dataset.key;
    if (["legend", "tooltip", "splitLines", "axisLine", "smooth"].includes(key)) {
      sel.cfg[key] = e.target.checked;
    } else if (key === "legendPos") {
      sel.cfg.legendPos = e.target.value;
    }
    rerender(sel);
    setDirty(true);
  });

  saveBtn.addEventListener("click", () => void save());

  // ── dashboard mutations ───────────────────────────────────────────
  // Append a chart widget to the open dashboard's spec + persist via
  // PUT /api/dashboards/:rid + mount the new tile. No-op when not in
  // dashboard mode (the workspace falls back to creating a standalone
  // chart in that case).
  async function addChartWidget(chart) {
    if (!dashboard || !chart) return false;
    const widgets = [...(dashboard.spec?.widgets || []), {
      slot: "w" + ((dashboard.spec?.widgets?.length || 0) + 1),
      kind: "chart",
      spec: { chart_id: chart.redpash_id },
    }];
    const nextSpec = { ...(dashboard.spec || { template_id: "" }), widgets };
    try {
      const saved = await api.put("/dashboards/" + encodeURIComponent(dashboard.redpash_id), {
        project_redpash_id: dashboard.project_redpash_id,
        title:              dashboard.title,
        spec:               nextSpec,
        description:        dashboard.description || null,
        folder:             dashboard.folder || null,
      });
      dashboard = saved;
      // Clear the "Empty dashboard" placeholder on first add.
      if (tiles.length === 0 && gridEl) gridEl.innerHTML = "";
      const entry = mountChartTile(chart, "span-6", true);
      if (entry) selectTile(entry);
      return true;
    } catch (err) {
      console.warn("[designer] addChartWidget failed:", err);
      return false;
    }
  }

  // Reveal the dashboard id (useful for the workspace's create-chart
  // helper — it needs to know whether to add the new chart as a
  // widget or just open it standalone).
  function getOpenDashboardRid() { return dashboard?.redpash_id || null; }
  // Full dashboard object — workspace reads project_redpash_id from
  // it when resolving a source data file for + Add chart.
  function getOpenDashboard() { return dashboard; }

  // ── lifecycle hooks ───────────────────────────────────────────────
  function resize() { tiles.forEach((t) => t.inst?.resize?.()); }
  function unmount() {
    teardown();
    designerEl.innerHTML = "";
  }

  // Initial empty state until load(...) fires.
  renderCanvasEmpty();

  return { load, resize, unmount, addChartWidget, getOpenDashboardRid, getOpenDashboard };
}

