/* chart/build.js — chart-spec → ECharts option translator (the Designer's
   chart vocabulary). A chart `cfg` carries kind/type + the chrome toggles
   (legend/legendPos/tooltip/splitLines/axisLine/smooth/theme) + the baked
   `option` (last rendered data, so a type/theme switch survives) + the
   group_by/agg_fn/agg_col data binding. THEMES is the palette set; the
   `registered:true` ones drive their own ECharts axis/tooltip/gauge defaults
   (registered via chart/theme.js) so buildOption stays in pass-through for
   them. Ported from the prerelease chart pipeline. Pure (no imports). */

// ── chart themes (separate from the app chrome theme) ────────────────
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
  // Registered themes self-register via chart/theme.js (the redpash-* JSON) or
  // the echarts-themes/builtin/*.js scripts. `registered:true` flips buildOption
  // into pass-through (no explicit color/text/axis) so the theme drives; `series`
  // stays only for the Style-picker swatch.
  macarons:    { name: "Macarons", registered: true,
    series: ["#2ec7c9","#b6a2de","#5ab1ef","#ffb980","#d87a80","#8d98b3","#e5cf0d","#97b552"] },
  roma:        { name: "Roma", registered: true,
    series: ["#E01F54","#001852","#f5e8c8","#b8d2c7","#c6b38e","#a4d8c2","#f3d999","#d3758f"] },
  shine:       { name: "Shine", registered: true,
    series: ["#c12e34","#e6b600","#0098d9","#2b821d","#005eaa","#339ca8","#cda819","#32a487"] },
  infographic: { name: "Infographic", registered: true,
    series: ["#C1232B","#27727B","#FCCE10","#E87C25","#B5C334","#FE8463","#9BCA63","#FAD860"] },
  "redpash-mocha": { name: "RedPash Mocha", registered: true,
    series: ["#89b4fa","#cba6f7","#94e2d5","#fab387","#f38ba8","#f9e2af","#a6e3a1","#74c7ec"] },
  "redpash-latte": { name: "RedPash Latte", registered: true,
    series: ["#1e66f5","#8839ef","#179299","#fe640b","#d20f39","#df8e1d","#40a02b","#04a5e5"] },
  // The app's primary themes (chart/theme.js registers the JSON; chartTheme()
  // returns one of these per html[data-theme]) — listed so the editor's theme
  // dropdown can offer the same identity the rest of the app wears.
  "redpash-newdark": { name: "RedPash Dark", registered: true,
    series: ["#89b4fa","#cba6f7","#94e2d5","#fab387","#f38ba8","#f9e2af","#a6e3a1","#74c7ec"] },
  "redpash-newlight": { name: "RedPash Light", registered: true,
    series: ["#1e66f5","#8839ef","#179299","#fe640b","#d20f39","#df8e1d","#40a02b","#04a5e5"] },
  dark:        { name: "Dark", registered: true,
    series: ["#4992ff","#7cffb2","#fddd60","#ff6e76","#58d9f9","#05c091","#ff8a45","#8d48e3"] },
  "tech-blue": { name: "Tech Blue", registered: true,
    series: ["#4d4d4d","#3a5897","#007bb6","#7094db","#0080ff","#b3b3ff","#00bdec","#33ccff"] },
  v5:          { name: "ECharts v5", registered: true,
    series: ["#5470c6","#91cc75","#fac858","#ee6666","#73c0de","#3ba272","#fc8452","#9a60b4"] },
  gray:        { name: "Gray", registered: true,
    series: ["#757575","#c7c7c7","#dadada","#8b8b8b","#b5b5b5","#e9e9e9"] },
};

// Chart kinds grouped by family — picking a type sets both the type AND its kind.
export const TYPES = {
  cartesian: [
    ["bar",        "bi-bar-chart",         "Bar"],
    ["line",       "bi-graph-up",          "Line"],
    ["area",       "bi-graph-up-arrow",    "Area"],
  ],
  barh:      [["barh",       "bi-bar-chart-steps",   "Horizontal"]],
  scatter:   [["scatter",    "bi-circle",            "Scatter"]],
  pie: [
    ["pie",        "bi-pie-chart-fill",    "Pie"],
    ["donut",      "bi-circle",            "Donut"],
    ["half_donut", "bi-circle-half",       "Half-donut"],
    ["rose",       "bi-flower2",           "Rose"],
  ],
  radar:     [["radar",      "bi-pentagon",          "Radar"]],
  gauge:     [["gauge",      "bi-speedometer",       "Gauge"]],
  pictorial: [["pictorial",  "bi-dice-3",            "Pictorial"]],
};
export const TYPE_TO_KIND = {};
Object.entries(TYPES).forEach(([kind, list]) => list.forEach(([t]) => { TYPE_TO_KIND[t] = kind; }));
export const TYPE_LIST = Object.values(TYPES).flat();
export const SMOOTHABLE = new Set(["line", "area"]);

// ── ECharts option builder — routes by kind; reads theme tokens + the baked
//    data (cfg.option) so re-renders survive type/theme changes; a small
//    fallback dataset keeps a fresh canvas from looking blank. ──────────────
export function buildOption(cfg, t) {
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
  const axisLineStyle  = (show) => reg ? { show } : { show, lineStyle: { color: t.axis } };
  const splitLineStyle = (show) => reg ? { show } : { show, lineStyle: { color: t.split } };
  const axisLabelStyle = reg ? {} : { color: t.text };
  const padT = cfg.legend && cfg.legendPos === "top" ? 34 : 14;
  const padB = cfg.legend && cfg.legendPos === "bottom" ? 34 : 10;
  const baked = cfg.option || null;
  const fallbackX = ["A","B","C","D","E"];
  const fallbackY = [12, 19, 8, 15, 22];
  const labels = baked?.xAxis?.data || baked?.yAxis?.data || fallbackX;
  const values = baked?.series?.[0]?.data?.length
    ? baked.series[0].data.map((v) => (typeof v === "object" && v && "value" in v) ? v.value : v)
    : fallbackY;
  const pieData = (baked?.series?.[0]?.data?.length && typeof baked.series[0].data[0] === "object")
    ? baked.series[0].data
    : labels.map((n, i) => ({ name: String(n), value: Number(values[i]) || 0 }));

  if (cfg.kind === "pie") {
    const isDonut = cfg.type === "donut" || cfg.type === "half_donut";
    const isHalf  = cfg.type === "half_donut";
    const isRose  = cfg.type === "rose";
    const radius  = isDonut ? ["52%", "76%"] : isRose ? ["20%", "78%"] : ["0%", "72%"];
    const angles  = isHalf ? { startAngle: 180, endAngle: 360 } : {};
    return { ...base, series: [{
      type: "pie", radius, ...angles,
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
      xAxis: { type: "value", axisLine: axisLineStyle(cfg.axisLine),
        splitLine: splitLineStyle(cfg.splitLines), axisLabel: axisLabelStyle },
      yAxis: { type: "category", data: labels, axisTick: { show: false },
        axisLine: axisLineStyle(cfg.axisLine), axisLabel: axisLabelStyle },
      series: [{ type: "bar", data: values, barWidth: "56%",
        itemStyle: { borderRadius: [0, 4, 4, 0] } }],
    };
  }

  if (cfg.kind === "scatter") {
    const points = values.map((v, i) => [i, Number(v) || 0]);
    return { ...base,
      grid: { left: 6, right: 14, top: padT, bottom: padB, containLabel: true },
      xAxis: { type: "value", axisLine: axisLineStyle(cfg.axisLine),
        splitLine: splitLineStyle(cfg.splitLines), axisLabel: axisLabelStyle },
      yAxis: { type: "value", axisLine: axisLineStyle(cfg.axisLine),
        splitLine: splitLineStyle(cfg.splitLines), axisLabel: axisLabelStyle },
      series: [{ type: "scatter", data: points, symbolSize: 10 }],
    };
  }

  if (cfg.kind === "radar") {
    const max = Math.max(...values.map((v) => Number(v) || 0)) || 1;
    return { ...base,
      radar: { indicator: labels.map((n) => ({ name: String(n), max })),
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
    const v = Number(values[0]) || values.reduce((a, b) => a + (Number(b) || 0), 0);
    const max = Math.max(v, ...values.map((x) => Number(x) || 0)) * 1.25 || 100;
    return { ...base,
      series: [{ type: "gauge", min: 0, max,
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
    return { ...base,
      grid: { left: 6, right: 14, top: padT, bottom: padB, containLabel: true },
      xAxis: { type: "category", data: labels, axisTick: { show: false }, splitLine: { show: false },
        axisLine: axisLineStyle(cfg.axisLine), axisLabel: axisLabelStyle },
      yAxis: { type: "value", axisLine: axisLineStyle(cfg.axisLine),
        splitLine: splitLineStyle(cfg.splitLines), axisLabel: axisLabelStyle },
      series: [{ type: "pictorialBar", symbol: cfg.symbol || "circle",
        symbolRepeat: cfg.symbol_repeat !== false, symbolSize: [14, 14], data: values }],
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
      axisLine: axisLineStyle(cfg.axisLine), axisLabel: axisLabelStyle },
    yAxis: { type: "value", axisLine: axisLineStyle(cfg.axisLine),
      splitLine: splitLineStyle(cfg.splitLines), axisLabel: axisLabelStyle },
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
