/* chart/render.js — chart spec → live ECharts instance, + the data-shaping
   helpers that turn `/group/preview` rows into the `cfg.option` shape buildOption
   reads. Ported from the prerelease chart pipeline; the prerelease monitoring-stats
   data source is dropped (the lean cut removed it) — the Designer's data comes
   from the file aggregation engine, shaped by synthesizeOption() into cfg.option,
   then rendered here. */

import { THEMES, buildOption } from "./build.js";
import { ensureRegisteredThemes } from "./theme.js";

// ── shape aggregated rows ({name,value}[] | {label:number} | label/value
//    columns) into the cfg.option shape buildOption reads. ──────────────────
export function synthesizeOption(data, kind) {
  if (data == null) return null;
  if (typeof data === "number") return { series: [{ data: [data] }] };
  if (kind === "pie" || kind === "radar") {
    return { series: [{ data: normaliseToNameValue(data) }] };
  }
  const { labels, values } = normaliseToLabelsValues(data);
  return {
    xAxis: { data: labels },
    yAxis: { data: labels }, // barh reads from yAxis; harmless on others
    series: [{ data: values }],
  };
}

function normaliseToNameValue(input) {
  if (Array.isArray(input)) {
    return input
      .filter((d) => d && (d.name || d.label) != null)
      .map((d) => ({ name: String(d.name ?? d.label), value: Number(d.value ?? d.count ?? 0) }));
  }
  if (input && typeof input === "object") {
    return Object.entries(input)
      .filter(([, v]) => typeof v === "number" && !Number.isNaN(v))
      .map(([name, value]) => ({ name, value }));
  }
  return [];
}

function normaliseToLabelsValues(input) {
  const items = normaliseToNameValue(input);
  return { labels: items.map((i) => i.name), values: items.map((i) => i.value) };
}

// ── renderChart: build the option from cfg + mount/replace the instance. ────
// `el` is the slot; `spec` = { cfg, ... } (cfg.option already carries the data,
// stamped by synthesizeOption upstream); `themeName` defaults to cfg.theme.
// Returns the ECharts instance so the caller owns dispose/resize.
export function renderChart(el, spec, themeName) {
  if (!el || !window.echarts) return null;
  ensureRegisteredThemes();
  const cfg = { ...(spec.cfg || {}) };
  const themeKey = themeName || cfg.theme || "vintage";
  const t = THEMES[themeKey] || THEMES.vintage;
  const themeForInit = t.registered ? themeKey : undefined;
  // One ECharts instance per DOM node — dispose any existing before re-init.
  const existing = window.echarts.getInstanceByDom(el);
  if (existing) { try { existing.dispose(); } catch { /* already gone */ } }
  const inst = window.echarts.init(el, themeForInit);
  inst.setOption(buildOption(cfg, t));
  return inst;
}
