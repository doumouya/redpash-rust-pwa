/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/charts/build.md */
// charts/build.js — chart-spec → ECharts option translator.
//
// Slice A of the chart-pipeline unification (Em 2026-05-27): lift
// the `buildOption` + `THEMES` + `TYPES` vocabulary out of
// `designer.js` so it can be reused by:
//   - the existing Designer (chart-builder mode in Workspace),
//   - list-page KPI charts (current path: `echarts-kpi.js` — its
//     own option shapes; migration is Slice B's job),
//   - the future Settings-driven Monitoring chart picker.
//
// This slice is a PURE refactor. Designer.js loses the local
// definitions and imports from here; everything else stays the
// same. No new chart kinds, no behaviour change.
//
// Vocabulary
// ----------
// A chart `cfg` is the spec being edited / rendered. Fields:
//   kind:      pie | barh | scatter | radar | gauge | pictorial |
//              cartesian — the family the option-builder branches
//              on.
//   type:      pie | donut | half_donut | rose | bar | line | area
//              | scatter | radar | gauge | barh | pictorial — the
//              specific variant within a family.
//   option:    last baked ECharts option from a prior save (so the
//              renderer survives a type / theme switch). When
//              absent, the renderer paints a small fallback dataset.
//   legend / legendPos / tooltip / splitLines / axisLine / smooth /
//   theme:     standard chrome toggles.
//
// A theme is the entry in THEMES — either an inline palette (we
// emit explicit color / text / axis options) or a registered theme
// (`registered: true` — flips the builder into pass-through so the
// registered theme drives its own defaults).

// ── chart themes (separate from chrome theme) ────────────────────────
// Vintage is the ECharts builtin (warm/muted); Latte + Mocha mirror
// the app's chrome palettes so a chart can read consistent with the
// surrounding UI when wanted. Macarons / Roma / Shine / Infographic
// are palettes lifted from the Apache ECharts theme builder bundles
// — keeping them as plain THEMES entries avoids registering with
// ECharts at runtime, but the bundled scripts are the canonical
// source if anyone wants to enrich (e.g. gauge axis bands).
export const THEMES = {
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

// Chart kinds — grouped by family. Picking a type sets both the
// type AND the kind it belongs to (cartesian/pie/barh/etc. each
// have different ECharts shapes). The Type section in the accordion
// flattens all families into one grid so the user can switch any
// chart to any other kind without leaving the picker.
export const TYPES = {
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
export const TYPE_TO_KIND = {};
Object.entries(TYPES).forEach(([kind, list]) => list.forEach(([t]) => { TYPE_TO_KIND[t] = kind; }));
// Flat ordered list of all types — drives the Type grid (one button
// per type, family-grouped by adjacency).
export const TYPE_LIST = Object.values(TYPES).flat();
// Kinds that respect the smooth modifier (line family).
export const SMOOTHABLE = new Set(["line", "area"]);

// ── ECharts option builder ────────────────────────────────────────
// Routes by kind to a per-family branch. Each branch reads theme
// tokens for color/text/axis/split/bg + the baked data from a
// previously-saved spec.option (so re-renders survive type/theme
// changes). On a fresh chart with no baked data, a small fallback
// dataset keeps the canvas from looking blank.
export function buildOption(cfg, t) {
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
