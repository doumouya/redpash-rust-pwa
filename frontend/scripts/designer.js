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
// surrounding UI when wanted. Macarons / Roma / Shine / Infographic
// are palettes lifted from the Apache ECharts theme builder bundles
// — keeping them as plain THEMES entries avoids registering with
// ECharts at runtime, but the bundled scripts are the canonical
// source if anyone wants to enrich (e.g. gauge axis bands).
const THEMES = {
  vintage:     { name: "Vintage",
    series: ["#d87c7c","#919e8b","#d7ab82","#6e7074","#61a0a8","#efa18d","#787464","#cc7e63"],
    text: "#333333", axis: "#333333", split: "#dcdcdc", bg: "#fef8ef" },
  latte:       { name: "Latte",
    series: ["#1e66f5","#8839ef","#179299","#fe640b","#d20f39","#df8e1d"],
    text: "#4c4f69", axis: "#9ca0b0", split: "rgba(76,79,105,.12)", bg: "transparent" },
  mocha:       { name: "Mocha",
    series: ["#89b4fa","#cba6f7","#94e2d5","#fab387","#f38ba8","#f9e2af"],
    text: "#cdd6f4", axis: "#6c7086", split: "rgba(255,255,255,.08)", bg: "transparent" },
  // These four were inline palettes; the full Apache-ECharts themes
  // self-register via /echarts-themes/builtin/{name}.js loaded in
  // index.html. Marking them registered: true flips buildOption into
  // pass-through so the registered theme drives axis/tooltip/gauge
  // bands/candlestick — not just the palette. `series` stays only
  // for the swatch preview in the Style picker.
  macarons:    { name: "Macarons", registered: true,
    series: ["#2ec7c9","#b6a2de","#5ab1ef","#ffb980","#d87a80","#8d98b3","#e5cf0d","#97b552"] },
  roma:        { name: "Roma", registered: true,
    series: ["#E01F54","#001852","#f5e8c8","#b8d2c7","#c6b38e","#a4d8c2","#f3d999","#d3758f"] },
  shine:       { name: "Shine", registered: true,
    series: ["#c12e34","#e6b600","#0098d9","#2b821d","#005eaa","#339ca8","#cda819","#32a487"] },
  infographic: { name: "Infographic", registered: true,
    series: ["#C1232B","#27727B","#FCCE10","#E87C25","#B5C334","#FE8463","#9BCA63","#FAD860"] },
  // Gus's full ECharts themes — palette + axis + tooltip + gauge
  // bands + candlestick + boxplot defaults baked into the JSON.
  // `registered: true` flips buildOption into pass-through mode
  // (no explicit color/text/axis settings — let the theme drive)
  // and tells mount/rerender to dispose+reinit when swapping.
  "redpash-mocha": { name: "RedPash Mocha", registered: true,
    series: ["#89b4fa","#cba6f7","#94e2d5","#fab387","#f38ba8","#f9e2af","#a6e3a1","#74c7ec"] },
  "redpash-latte": { name: "RedPash Latte", registered: true,
    series: ["#1e66f5","#8839ef","#179299","#fe640b","#d20f39","#df8e1d","#40a02b","#04a5e5"] },
  // Four more from apache/echarts theme/ — dark is the official
  // ECharts dark theme (darkMode: true so it knows to flip
  // tooltip surfaces too); tech-blue, v5 (the default ECharts 5
  // styled theme), and gray fill the remaining picker slots.
  dark:        { name: "Dark", registered: true,
    series: ["#4992ff","#7cffb2","#fddd60","#ff6e76","#58d9f9","#05c091","#ff8a45","#8d48e3"] },
  "tech-blue": { name: "Tech Blue", registered: true,
    series: ["#4d4d4d","#3a5897","#007bb6","#7094db","#0080ff","#b3b3ff","#00bdec","#33ccff"] },
  v5:          { name: "ECharts v5", registered: true,
    series: ["#5470c6","#91cc75","#fac858","#ee6666","#73c0de","#3ba272","#fc8452","#9a60b4"] },
  gray:        { name: "Gray", registered: true,
    series: ["#757575","#c7c7c7","#dadada","#8b8b8b","#b5b5b5","#e9e9e9"] },
};

// One-time registration of Gus's themes. Loads the JSON files
// from /echarts-themes/ and calls echarts.registerTheme — must run
// before any chart that uses one is initialised. The promise is
// awaited by mountDesigner so the first paint already has the theme
// in place; subsequent mounts skip the fetch via the cache.
let themesReadyP = null;
function ensureRegisteredThemes() {
  if (themesReadyP) return themesReadyP;
  if (!window.echarts) return Promise.resolve();
  const wanted = ["redpash-mocha", "redpash-latte"];
  themesReadyP = Promise.all(wanted.map(async (name) => {
    try {
      const r = await fetch("/echarts-themes/" + name + ".json");
      if (!r.ok) return;
      const json = await r.json();
      window.echarts.registerTheme(name, json);
    } catch {
      /* silent — theme falls through to vintage in buildOption */
    }
  }));
  return themesReadyP;
}

// Chart kinds — grouped by family. Picking a type sets both the
// type AND the kind it belongs to (cartesian/pie/barh/etc. each
// have different ECharts shapes). The Type section in the accordion
// flattens all families into one grid so the user can switch any
// chart to any other kind without leaving the picker.
const TYPES = {
  cartesian: [
    ["bar",        "bi-bar-chart",         "Bar"],
    ["line",       "bi-graph-up",          "Line"],
    ["area",       "bi-graph-up-arrow",    "Area"],
  ],
  barh: [
    ["barh",       "bi-bar-chart-steps",   "Horizontal"],
  ],
  scatter: [
    ["scatter",    "bi-circle",            "Scatter"],
  ],
  pie: [
    ["pie",        "bi-pie-chart-fill",    "Pie"],
    ["donut",      "bi-circle",            "Donut"],
    ["half_donut", "bi-circle-half",       "Half-donut"],
    ["rose",       "bi-flower2",           "Rose"],
  ],
  radar: [
    ["radar",      "bi-pentagon",          "Radar"],
  ],
  gauge: [
    ["gauge",      "bi-speedometer",       "Gauge"],
  ],
  pictorial: [
    ["pictorial",  "bi-dice-3",            "Pictorial"],
  ],
};
const TYPE_TO_KIND = {};
Object.entries(TYPES).forEach(([kind, list]) => list.forEach(([t]) => { TYPE_TO_KIND[t] = kind; }));
// Flat ordered list of all types — drives the Type grid (one button
// per type, family-grouped by adjacency).
const TYPE_LIST = Object.values(TYPES).flat();
// Kinds that respect the smooth modifier (line family).
const SMOOTHABLE = new Set(["line", "area"]);

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

  // ── ECharts option builder ────────────────────────────────────────
  // Routes by kind to a per-family branch. Each branch reads theme
  // tokens for color/text/axis/split/bg + the baked data from a
  // previously-saved spec.option (so re-renders survive type/theme
  // changes). On a fresh chart with no baked data, a small fallback
  // dataset keeps the canvas from looking blank.
  function buildOption(cfg, t) {
    // Registered themes (Gus's redpash-mocha / redpash-latte) carry
    // their own color / text / axis defaults via echarts.registerTheme.
    // Skip the explicit settings in that mode so the theme drives —
    // otherwise our setOption color/text/etc. would override the
    // registered defaults and the theme would lose most of its value.
    const reg = !!t.registered;
    const leg = {
      show: cfg.legend, type: "scroll", icon: "roundRect",
      itemWidth: 14, itemHeight: 9,
      ...(reg ? {} : { textStyle: { color: t.text } }),
    };
    leg[cfg.legendPos] = cfg.legendPos === "top" ? 4 : 0;
    const base = {
      ...(reg ? {} : {
        color: t.series, backgroundColor: t.bg,
        textStyle: { color: t.text, fontFamily: "system-ui" },
      }),
      legend: leg,
      tooltip: { show: cfg.tooltip,
        trigger: (cfg.kind === "pie" || cfg.kind === "gauge" || cfg.kind === "radar") ? "item" : "axis" },
      animationDuration: 600,
    };
    // Per-axis color helpers — return the theme's color when explicit,
    // empty object when registered (so the registered theme's axis
    // defaults stick). axisShow keeps the show toggle in both modes
    // since that's a user preference, not a colour.
    const axisLineStyle  = (show) => reg
      ? { show }
      : { show, lineStyle: { color: t.axis } };
    const splitLineStyle = (show) => reg
      ? { show }
      : { show, lineStyle: { color: t.split } };
    const axisLabelStyle = reg ? {} : { color: t.text };
    const padT = cfg.legend && cfg.legendPos === "top" ? 34 : 14;
    const padB = cfg.legend && cfg.legendPos === "bottom" ? 34 : 10;
    // Source data: read from the previously-baked option when present,
    // else fall back to a small placeholder so the canvas isn't empty
    // on a freshly-created chart that hasn't fetched its data yet.
    const baked = cfg.option || null;
    const fallbackX = ["A","B","C","D","E"];
    const fallbackY = [12, 19, 8, 15, 22];
    // Pull cartesian-shaped data (labels + values) wherever it lives
    // — used by bar / line / area / scatter / radar / gauge / pictorial.
    const labels = baked?.xAxis?.data || baked?.yAxis?.data || fallbackX;
    const values = baked?.series?.[0]?.data?.length
      ? baked.series[0].data.map((v) => (typeof v === "object" && v && "value" in v) ? v.value : v)
      : fallbackY;
    // Pie-shaped data — list of { name, value } objects.
    const pieData = (baked?.series?.[0]?.data?.length
        && typeof baked.series[0].data[0] === "object")
      ? baked.series[0].data
      : labels.map((n, i) => ({ name: String(n), value: Number(values[i]) || 0 }));

    if (cfg.kind === "pie") {
      // Variants: pie | donut | half_donut | rose. radius + startAngle
      // / endAngle + roseType drive the visual; data shape is the
      // same { name, value }[].
      const isDonut = cfg.type === "donut" || cfg.type === "half_donut";
      const isHalf  = cfg.type === "half_donut";
      const isRose  = cfg.type === "rose";
      const radius  = isDonut ? ["52%", "76%"] : isRose ? ["20%", "78%"] : ["0%", "72%"];
      const angles  = isHalf ? { startAngle: 180, endAngle: 360 } : {};
      return { ...base, series: [{
        type: "pie",
        radius,
        ...angles,
        roseType: isRose ? "area" : undefined,
        center: ["50%", isHalf ? "70%" : (cfg.legend && cfg.legendPos === "bottom" ? "44%" : "50%")],
        data: pieData,
        ...(reg ? {} : {
          label: { color: t.text },
          itemStyle: { borderColor: t.bg === "transparent" ? "rgba(0,0,0,0)" : t.bg, borderWidth: 2 },
        }),
      }]};
    }

    if (cfg.kind === "barh") {
      return { ...base,
        grid: { left: 6, right: 18, top: padT, bottom: padB, containLabel: true },
        xAxis: { type: "value",
          axisLine: axisLineStyle(cfg.axisLine),
          splitLine: splitLineStyle(cfg.splitLines),
          axisLabel: axisLabelStyle },
        yAxis: { type: "category", data: labels, axisTick: { show: false },
          axisLine: axisLineStyle(cfg.axisLine),
          axisLabel: axisLabelStyle },
        series: [{ type: "bar", data: values, barWidth: "56%",
          itemStyle: { borderRadius: [0, 4, 4, 0] } }],
      };
    }

    if (cfg.kind === "scatter") {
      // Two-numeric-axis scatter. We don't have a paired (x,y) shape
      // in the single-agg spec — plot value vs row index. Future:
      // when multi-agg charts land, x can come from the second agg.
      const points = values.map((v, i) => [i, Number(v) || 0]);
      return { ...base,
        grid: { left: 6, right: 14, top: padT, bottom: padB, containLabel: true },
        xAxis: { type: "value",
          axisLine: axisLineStyle(cfg.axisLine),
          splitLine: splitLineStyle(cfg.splitLines),
          axisLabel: axisLabelStyle },
        yAxis: { type: "value",
          axisLine: axisLineStyle(cfg.axisLine),
          splitLine: splitLineStyle(cfg.splitLines),
          axisLabel: axisLabelStyle },
        series: [{ type: "scatter", data: points, symbolSize: 10 }],
      };
    }

    if (cfg.kind === "radar") {
      // One series, multiple indicators (one per category). Max per
      // indicator = the overall max so the polygon fits.
      const max = Math.max(...values.map((v) => Number(v) || 0)) || 1;
      return { ...base,
        radar: {
          indicator: labels.map((n) => ({ name: String(n), max })),
          ...(reg ? {} : {
            axisLine:  { lineStyle: { color: t.split } },
            splitLine: { lineStyle: { color: t.split } },
            splitArea: { areaStyle: { color: ["transparent"] } },
            axisName:  { color: t.text },
          }),
        },
        series: [{ type: "radar", data: [{ value: values, name: cfg.title || "series",
          areaStyle: { opacity: 0.22 }, lineStyle: { width: 2 } }] }],
      };
    }

    if (cfg.kind === "gauge") {
      // Single-value KPI gauge. Uses the FIRST baked value when
      // available; otherwise the sum of values (matches user
      // expectations for "what's the headline number?"). Registered
      // themes ship richer gauge axis bands; we keep our flat band
      // only in inline mode so we don't clobber Gus's stops.
      const v = Number(values[0]) || values.reduce((a, b) => a + (Number(b) || 0), 0);
      const max = Math.max(v, ...values.map((x) => Number(x) || 0)) * 1.25 || 100;
      return { ...base,
        series: [{
          type: "gauge",
          min: 0, max,
          ...(reg ? {} : {
            axisLine: { lineStyle: { width: 14, color: [[1, t.series[0]]] } },
            detail:   { formatter: "{value}", color: t.text, fontSize: 18 },
          }),
          pointer: { length: "60%" },
          progress: { show: true, width: 14 },
          data: [{ value: Math.round(v * 100) / 100, name: cfg.title || "" }],
        }],
      };
    }

    if (cfg.kind === "pictorial") {
      // Bar replaced with repeated symbols (or one stretched symbol).
      // Defaults to a circle "dotted bar" — symbol + symbol_repeat
      // pickers come in a follow-up.
      return { ...base,
        grid: { left: 6, right: 14, top: padT, bottom: padB, containLabel: true },
        xAxis: { type: "category", data: labels,
          axisTick: { show: false }, splitLine: { show: false },
          axisLine: axisLineStyle(cfg.axisLine),
          axisLabel: axisLabelStyle },
        yAxis: { type: "value",
          axisLine: axisLineStyle(cfg.axisLine),
          splitLine: splitLineStyle(cfg.splitLines),
          axisLabel: axisLabelStyle },
        series: [{
          type: "pictorialBar",
          symbol: cfg.symbol || "circle",
          symbolRepeat: cfg.symbol_repeat !== false,
          symbolSize: [14, 14],
          data: values,
        }],
      };
    }

    // cartesian — bar / line / area
    const xData  = baked?.xAxis?.data || labels;
    const series = baked?.series?.length
      ? baked.series.map((s) => ({ name: s.name, data: s.data }))
      : [{ name: cfg.agg_fn + "(" + cfg.agg_col + ")", data: values }];
    return { ...base,
      grid: { left: 6, right: 14, top: padT, bottom: padB, containLabel: true },
      xAxis: { type: "category", data: xData, boundaryGap: cfg.type === "bar",
        axisTick: { show: false }, splitLine: { show: false },
        axisLine: axisLineStyle(cfg.axisLine),
        axisLabel: axisLabelStyle },
      yAxis: { type: "value",
        axisLine: axisLineStyle(cfg.axisLine),
        splitLine: splitLineStyle(cfg.splitLines),
        axisLabel: axisLabelStyle },
      series: series.map((s) => ({
        name: s.name, data: s.data,
        type: cfg.type === "area" ? "line" : cfg.type,
        smooth: SMOOTHABLE.has(cfg.type) ? !!cfg.smooth : false,
        areaStyle: cfg.type === "area" ? { opacity: 0.18 } : undefined,
        barWidth: "56%",
        itemStyle: cfg.type === "bar" ? { borderRadius: [4, 4, 0, 0] } : undefined,
        lineStyle: cfg.type !== "bar" ? { width: 2.6 } : undefined,
        symbol: "circle", symbolSize: 7,
      })),
    };
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

// ─── helpers ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
