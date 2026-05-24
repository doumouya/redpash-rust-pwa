// echarts-kpi.js — small chart wrappers for KPI cards across Home,
// Monitoring, Profile. Each function takes a DOM element + the data
// shape that surface naturally has + an opts bag, inits ECharts with
// the requested theme (default: redpash-mocha — registered globally
// from /echarts-themes/builtin/), and returns the instance so the
// caller can dispose / resize later.
//
// Why a separate module: the Designer's buildOption() is rich and
// chart-spec-bound. KPI cards want a thinner contract — pass in
// {label: count} or [{ts, value}], get a chart back. This module is
// that contract. Designer charts and KPI cards still share the
// underlying ECharts instance + registered themes, just the option-
// building shortcut differs.
//
// Themes: default to "redpash-mocha" so cards inherit the brand
// palette. Anyone wanting a different look passes `{ theme: "v5" }`
// or similar. Theme names match the keys in designer.js THEMES
// (vintage / latte / mocha / macarons / roma / shine / infographic /
// dark / tech-blue / v5 / gray / redpash-mocha / redpash-latte).

const DEFAULT_THEME = "redpash-mocha";

// Initialize an ECharts instance against the requested theme. The
// theme name is passed straight to echarts.init — registered themes
// drive their own palette + axis treatment. Caller is responsible
// for dispose() on teardown.
function initChart(el, theme) {
  if (!el || !window.echarts) return null;
  return window.echarts.init(el, theme || DEFAULT_THEME);
}

// kpiDonut — categorical breakdown (e.g. by_plan, by_stage, by_role).
// data: { [label: string]: number } OR Array<{name, value}>.
// opts: { theme, title, label }   (label = show category labels on
//                                   slices — defaults to false for
//                                   compact KPI cards).
export function kpiDonut(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  const items = normalizeKV(data);
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { show: items.length <= 6, bottom: 0, type: "scroll" },
    series: [{
      type:   "pie",
      radius: ["48%", "70%"],
      center: ["50%", items.length <= 6 ? "46%" : "50%"],
      data:   items,
      label:  { show: !!opts.label, formatter: "{b}\n{d}%" },
      labelLine: { show: !!opts.label },
      itemStyle: { borderWidth: 1 },
    }],
  });
  return inst;
}

// kpiPie — same data shape as kpiDonut but solid pie (no hole). Use
// when the category count is small (≤5) and the share is the story.
export function kpiPie(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  const items = normalizeKV(data);
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { show: items.length <= 6, bottom: 0, type: "scroll" },
    series: [{
      type:   "pie",
      radius: ["0%", "72%"],
      center: ["50%", items.length <= 6 ? "46%" : "50%"],
      data:   items,
      label:  { show: !!opts.label, formatter: "{b}\n{d}%" },
    }],
  });
  return inst;
}

// kpiRose — Nightingale rose chart (slice radius scales with value).
// Good for small-N categorical breakdowns where you want value
// magnitude visible alongside share (e.g. by_role with very uneven
// counts).
export function kpiRose(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  const items = normalizeKV(data);
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "item", formatter: "{b}: {c}" },
    legend: { show: items.length <= 6, bottom: 0, type: "scroll" },
    series: [{
      type:     "pie",
      radius:   ["22%", "76%"],
      center:   ["50%", items.length <= 6 ? "46%" : "50%"],
      roseType: "area",
      data:     items,
      label:    { show: !!opts.label },
    }],
  });
  return inst;
}

// kpiBar — vertical bar from {label: count} or [{name, value}].
// opts: { theme, title, sort: "value" | "label" | null, top }
//   sort defaults to "value" desc; top truncates to the N largest.
export function kpiBar(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  let items = normalizeKV(data);
  if (opts.sort !== "label") items.sort((a, b) => b.value - a.value);
  if (opts.top) items = items.slice(0, opts.top);
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid:   { left: 32, right: 16, top: opts.title ? 38 : 14, bottom: 28, containLabel: true },
    xAxis:  { type: "category", data: items.map((i) => i.name) },
    yAxis:  { type: "value" },
    series: [{ type: "bar", data: items.map((i) => i.value), barWidth: "60%",
               itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  });
  return inst;
}

// kpiBarH — horizontal bar; same data shape as kpiBar. Better when
// labels are long (e.g. step kinds) or there are 6+ categories.
export function kpiBarH(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  let items = normalizeKV(data);
  if (opts.sort !== "label") items.sort((a, b) => b.value - a.value);
  if (opts.top) items = items.slice(0, opts.top);
  // Horizontal bars read top-to-bottom; reverse so the largest is
  // at the top of the canvas (ECharts draws yAxis bottom-up).
  items.reverse();
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid:   { left: 8, right: 24, top: opts.title ? 38 : 14, bottom: 18, containLabel: true },
    xAxis:  { type: "value" },
    yAxis:  { type: "category", data: items.map((i) => i.name) },
    series: [{ type: "bar", data: items.map((i) => i.value), barWidth: "60%",
               itemStyle: { borderRadius: [0, 4, 4, 0] } }],
  });
  return inst;
}

// kpiLine — smooth line from [{ts: string|Date, value: number}, …]
// or two arrays via opts.x / opts.y. opts.area drops a soft fill
// under the curve for the headline-metric look.
export function kpiLine(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  let labels, values;
  if (Array.isArray(data) && data.length && typeof data[0] === "object") {
    labels = data.map((d) => d.ts);
    values = data.map((d) => Number(d.value) || 0);
  } else {
    labels = opts.x || [];
    values = opts.y || [];
  }
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "axis" },
    grid:   { left: 32, right: 16, top: opts.title ? 38 : 14, bottom: 24, containLabel: true },
    xAxis:  { type: "category", data: labels, boundaryGap: false },
    yAxis:  { type: "value" },
    series: [{
      type: "line",
      data: values,
      smooth: true,
      symbol: "circle",
      symbolSize: 5,
      lineStyle: { width: 2.4 },
      ...(opts.area ? { areaStyle: { opacity: 0.18 } } : {}),
    }],
  });
  return inst;
}

// kpiGauge — single-value progress gauge. value in [0, max], renders
// with a coloured arc that progresses with the value. Theme controls
// the band colours (Gus's redpash-mocha defines green/yellow/red
// stops; other themes inherit ECharts defaults).
// opts: { theme, max, title, unit }   max defaults to 100 (percent).
export function kpiGauge(el, value, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  const max  = opts.max ?? 100;
  const v    = Number(value) || 0;
  const unit = opts.unit ?? "";
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    series: [{
      type:    "gauge",
      min:     0,
      max,
      radius:  "85%",
      center:  ["50%", "60%"],
      pointer: { length: "60%", width: 4 },
      progress:{ show: true, width: 12 },
      detail:  { formatter: "{value}" + unit, fontSize: 18, offsetCenter: [0, "40%"] },
      data:    [{ value: Math.round(v * 100) / 100, name: opts.title || "" }],
    }],
  });
  return inst;
}

// Normalise the two common KPI inputs to ECharts pie/bar data shape.
// Accepts { label: count } object OR an [{name, value}] array
// directly (passthrough).
function normalizeKV(input) {
  if (Array.isArray(input)) return input.filter((d) => d && d.name);
  if (!input || typeof input !== "object") return [];
  return Object.entries(input)
    .filter(([, v]) => typeof v === "number" && !Number.isNaN(v))
    .map(([name, value]) => ({ name, value }));
}
