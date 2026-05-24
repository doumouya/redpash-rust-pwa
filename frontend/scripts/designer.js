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

// ── chart themes (separate from chrome theme) ────────────────────────
// Vintage is the ECharts builtin (warm/muted); Latte + Mocha mirror
// the app's chrome palettes so a chart can read consistent with the
// surrounding UI when wanted.
const THEMES = {
  vintage: { name: "Vintage",
    series: ["#d87c7c","#919e8b","#d7ab82","#6e7074","#61a0a8","#efa18d","#787464","#cc7e63"],
    text: "#333333", axis: "#333333", split: "#dcdcdc", bg: "#fef8ef" },
  latte:   { name: "Latte",
    series: ["#1e66f5","#8839ef","#179299","#fe640b","#d20f39","#df8e1d"],
    text: "#4c4f69", axis: "#9ca0b0", split: "rgba(76,79,105,.12)", bg: "transparent" },
  mocha:   { name: "Mocha",
    series: ["#89b4fa","#cba6f7","#94e2d5","#fab387","#f38ba8","#f9e2af"],
    text: "#cdd6f4", axis: "#6c7086", split: "rgba(255,255,255,.08)", bg: "transparent" },
};

// Chart kinds — grouped by family. Picking a type in one family
// switches the kind too (cartesian/pie/barh have different ECharts
// shapes). Family vocab + buildOption logic ported from the
// prototype's TYPES + buildOption.
const TYPES = {
  cartesian: [["bar","bi-bar-chart","Bar"], ["line","bi-graph-up","Line"], ["area","bi-graph-up-arrow","Area"]],
  pie:       [["pie","bi-pie-chart-fill","Pie"], ["donut","bi-circle","Donut"]],
  barh:      [["barh","bi-bar-chart-steps","Bar"]],
};
const TYPE_TO_KIND = {};
Object.entries(TYPES).forEach(([kind, list]) => list.forEach(([t]) => { TYPE_TO_KIND[t] = kind; }));

// Defaults applied to a new chart cfg. Mirrors the prototype's D.
const DEFAULTS = {
  legend: false, legendPos: "bottom",
  tooltip: true, splitLines: true, axisLine: true,
  theme: "vintage",
};

export function mountDesigner(designerEl, ctx) {
  // state — tiles[] holds one entry per chart in the canvas. For
  // C2 / single-chart there's at most one entry (the open CHT_
  // file). The shape generalises to multi-tile when dashboards land.
  let tiles = [];        // [{ rid, chart, cfg, inst, tileEl }]
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
    const inst = window.echarts?.init(tileEl.querySelector(".ds-chart"));
    if (inst) inst.setOption(buildOption(cfg, THEMES[cfg.theme] || THEMES.vintage));
    const entry = { rid: chart.redpash_id, chart, cfg, inst, tileEl, widget: widget || null };
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
    const typeBtns = (TYPES[cfg.kind] || []).map(([t, icon, label]) =>
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
          (cfg.kind === "pie"
            ? '<p class="ds-muted">Axes don\'t apply to pie charts.</p>'
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
          '<span class="ds-lbl">Chart theme</span>'
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

  // ── ECharts option builder — ported from the prototype ────────────
  // Handles cartesian (bar/line/area), pie (with donut variant), and
  // horizontal bar. Reads theme tokens for color/text/axis/split/bg.
  function buildOption(cfg, t) {
    const leg = {
      show: cfg.legend, type: "scroll", icon: "roundRect",
      itemWidth: 14, itemHeight: 9, textStyle: { color: t.text },
    };
    leg[cfg.legendPos] = cfg.legendPos === "top" ? 4 : 0;
    const base = {
      color: t.series, backgroundColor: t.bg,
      textStyle: { color: t.text, fontFamily: "system-ui" },
      legend: leg,
      tooltip: { show: cfg.tooltip, trigger: cfg.kind === "pie" ? "item" : "axis" },
      animationDuration: 600,
    };
    const padT = cfg.legend && cfg.legendPos === "top" ? 34 : 14;
    const padB = cfg.legend && cfg.legendPos === "bottom" ? 34 : 10;
    // Source data: re-use the previously-baked option's series/data
    // when present (the chart was saved with concrete numbers). Falls
    // back to a tiny placeholder so the canvas isn't empty on a
    // freshly-created chart.
    const baked = cfg.option || null;
    const fallbackX = ["A","B","C","D","E"];
    const fallbackY = [12, 19, 8, 15, 22];
    if (cfg.kind === "pie") {
      const data = (baked?.series?.[0]?.data) || [
        { name: "A", value: 12 }, { name: "B", value: 19 }, { name: "C", value: 8 },
      ];
      return { ...base, series: [{
        type: "pie",
        radius: cfg.type === "donut" ? ["52%", "76%"] : ["0%", "72%"],
        center: ["50%", cfg.legend && cfg.legendPos === "bottom" ? "44%" : "50%"],
        data, label: { color: t.text },
        itemStyle: { borderColor: t.bg === "transparent" ? "rgba(0,0,0,0)" : t.bg, borderWidth: 2 },
      }]};
    }
    if (cfg.kind === "barh") {
      const cats = (baked?.yAxis?.data) || fallbackX;
      const data = (baked?.series?.[0]?.data) || fallbackY;
      return { ...base,
        grid: { left: 6, right: 18, top: padT, bottom: padB, containLabel: true },
        xAxis: { type: "value",
          axisLine: { show: cfg.axisLine, lineStyle: { color: t.axis } },
          splitLine: { show: cfg.splitLines, lineStyle: { color: t.split } },
          axisLabel: { color: t.text } },
        yAxis: { type: "category", data: cats, axisTick: { show: false },
          axisLine: { show: cfg.axisLine, lineStyle: { color: t.axis } },
          axisLabel: { color: t.text } },
        series: [{ type: "bar", data, barWidth: "56%",
          itemStyle: { borderRadius: [0, 4, 4, 0] } }],
      };
    }
    // cartesian
    const xData  = (baked?.xAxis?.data) || fallbackX;
    const series = baked?.series?.length
      ? baked.series.map((s) => ({ name: s.name, data: s.data }))
      : [{ name: cfg.agg_fn + "(" + cfg.agg_col + ")", data: fallbackY }];
    return { ...base,
      grid: { left: 6, right: 14, top: padT, bottom: padB, containLabel: true },
      xAxis: { type: "category", data: xData, boundaryGap: cfg.type === "bar",
        axisTick: { show: false }, splitLine: { show: false },
        axisLine: { show: cfg.axisLine, lineStyle: { color: t.axis } },
        axisLabel: { color: t.text } },
      yAxis: { type: "value",
        axisLine: { show: cfg.axisLine, lineStyle: { color: t.axis } },
        splitLine: { show: cfg.splitLines, lineStyle: { color: t.split } },
        axisLabel: { color: t.text } },
      series: series.map((s) => ({
        name: s.name, data: s.data,
        type: cfg.type === "area" ? "line" : cfg.type,
        smooth: cfg.type !== "bar",
        areaStyle: cfg.type === "area" ? { opacity: 0.18 } : undefined,
        barWidth: "56%",
        itemStyle: cfg.type === "bar" ? { borderRadius: [4, 4, 0, 0] } : undefined,
        lineStyle: cfg.type !== "bar" ? { width: 2.6 } : undefined,
        symbol: "circle", symbolSize: 7,
      })),
    };
  }

  // ── rerender / dirty / save ───────────────────────────────────────
  function rerender(entry) {
    if (!entry?.inst) return;
    const t = THEMES[entry.cfg.theme] || THEMES.vintage;
    entry.inst.setOption(buildOption(entry.cfg, t), true);
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
    if (["legend", "tooltip", "splitLines", "axisLine"].includes(key)) {
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

  // ── lifecycle hooks ───────────────────────────────────────────────
  function resize() { tiles.forEach((t) => t.inst?.resize?.()); }
  function unmount() {
    teardown();
    designerEl.innerHTML = "";
  }

  // Initial empty state until load(...) fires.
  renderCanvasEmpty();

  return { load, resize, unmount, addChartWidget, getOpenDashboardRid };
}

// ─── helpers ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
