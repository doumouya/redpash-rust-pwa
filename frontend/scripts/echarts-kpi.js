// echarts-kpi.js — small chart wrappers for KPI cards across Home,
// Monitoring, Profile. Each function takes a DOM element + the data
// shape that surface naturally has + an opts bag, inits ECharts
// against the chrome-matching RedPash theme (or whatever theme the
// caller picks), and returns the instance so the caller can dispose
// / resize / wire .on("click") later.
//
// Why a separate module: the Designer's buildOption() is rich and
// chart-spec-bound. KPI cards want a thinner contract — pass in
// {label: count} or [{ts, value}], get a chart back. This module is
// that contract. Designer charts and KPI cards share the same
// registered themes via /scripts/echarts-theme.js, just the option-
// building shortcut differs.
//
// Theme defaults to the chrome-matching RedPash theme (mocha when
// the page is dark, latte when light) via chartTheme(). Override
// per-chart by passing `{ theme: "v5" }` etc. — any name registered
// in the global ECharts theme registry works.

import { ensureRegisteredThemes, chartTheme } from "/scripts/echarts-theme.js";

// Initialize an ECharts instance against the requested theme. The
// theme name is passed straight to echarts.init — registered themes
// drive their own palette + axis treatment. Caller is responsible
// for dispose() on teardown.
//
// Side effect: kicks off the one-time RedPash theme registration so
// every chart in the app shares the same loader. Memoized — calling
// from N initChart sites still only fetches the JSON files once.
function initChart(el, theme) {
  if (!el || !window.echarts) return null;
  ensureRegisteredThemes();
  return window.echarts.init(el, theme || chartTheme());
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
// opts:
//   theme, title, sort, top    — same as kpiBar.
//   colorByData                — true: each bar gets a different
//                                palette colour (ECharts colorBy:
//                                "data"). Default: one colour for
//                                the whole series.
//   showValueLabels            — true: emit "{c}" next to each bar.
//   cursor                     — e.g. "pointer" when the caller
//                                wires .on("click", …) for nav.
// Items can carry arbitrary extra fields (e.g. profile's `hash` for
// click-to-navigate); kpiBarH preserves them in the series data so
// the click handler can read params.data.hash.
export function kpiBarH(el, data, opts = {}) {
  const inst = initChart(el, opts.theme);
  if (!inst) return null;
  let items = normalizeKV(data);
  // sort: "label" means "preserve caller's order, already arranged
  // bottom-to-top for the display I want" (Profile passes Projects
  // last because it wants Projects on top). Default behaviour:
  // sort DESC by value + reverse so the largest paints at the top
  // of the canvas (ECharts category axis paints bottom-up — the
  // last element of yAxis.data is the topmost bar).
  const presort = opts.sort === "label";
  if (!presort) items.sort((a, b) => b.value - a.value);
  if (opts.top) items = items.slice(0, opts.top);
  if (!presort) items.reverse();
  inst.setOption({
    title: opts.title ? { text: opts.title, left: "center", top: 6, textStyle: { fontSize: 12.5, fontWeight: 600 } } : undefined,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid:   { left: 8, right: 24, top: opts.title ? 38 : 14, bottom: 18, containLabel: true },
    xAxis:  { type: "value", min: 0 },
    yAxis:  { type: "category", data: items.map((i) => i.name) },
    series: [{
      type: "bar",
      // Pass full item objects (not just numbers) so extra fields
      // like `hash` survive into the click event's params.data.
      data: items.map((i) => ({ ...i })),
      barWidth: "60%",
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      ...(opts.colorByData      ? { colorBy: "data" } : {}),
      ...(opts.showValueLabels  ? { label: { show: true, position: "right", formatter: "{c}", fontWeight: 600 } } : {}),
      ...(opts.cursor           ? { cursor: opts.cursor } : {}),
      emphasis: { itemStyle: { opacity: 0.85 } },
    }],
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
