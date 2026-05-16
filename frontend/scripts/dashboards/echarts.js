// ECharts lazy loader + RedPash theme.
//
// We don't ship ECharts in the main bundle (it's ~1 MB) — the script
// is injected from a CDN the first time a chart widget mounts. Once
// `loadECharts()` resolves, callers get the `echarts` global with the
// `redpash` theme already registered.

let echartsPromise = null;
let ecStatPromise  = null;

export function loadECharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsPromise) return echartsPromise;
  echartsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
    s.async = true;
    s.onload  = () => { registerTheme(window.echarts); resolve(window.echarts); };
    s.onerror = () => reject(new Error("Failed to load ECharts from CDN"));
    document.head.appendChild(s);
  });
  return echartsPromise;
}

// echarts-stat — small companion library for regressions, clustering,
// histograms. Loaded only when a chart actually needs it (e.g. scatter
// + linear/exponential regression overlay).
export function loadECStat() {
  if (window.ecStat) return Promise.resolve(window.ecStat);
  if (ecStatPromise) return ecStatPromise;
  ecStatPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/echarts-stat@1.2.0/dist/ecStat.min.js";
    s.async = true;
    s.onload  = () => resolve(window.ecStat);
    s.onerror = () => reject(new Error("Failed to load echarts-stat from CDN"));
    document.head.appendChild(s);
  });
  return ecStatPromise;
}

function registerTheme(echarts) {
  // Pulls RedPash CSS variables so the chart palette matches the app's
  // theme tokens — including dark mode via `prefers-color-scheme`.
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
  echarts.registerTheme("redpash", {
    color: [
      v("--rp-accent",   "#b3001b"),
      v("--rp-success",  "#1f7a3a"),
      v("--rp-warning",  "#b06d00"),
      "#4a6cf0",
      "#9c27b0",
      "#0091ea",
      "#ff8a00",
      "#5d4037",
    ],
    backgroundColor: "transparent",
    textStyle: {
      color: v("--rp-text", "#1a1a1f"),
      fontFamily: v("--rp-font", "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif"),
    },
    axisPointer: {
      lineStyle: { color: v("--rp-border-strong", "#c8c8d0") },
      crossStyle: { color: v("--rp-border-strong", "#c8c8d0") },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: v("--rp-border", "#e3e3e8") } },
      axisLabel: { color: v("--rp-text-muted", "#5f5f6b") },
      splitLine: { lineStyle: { color: v("--rp-border", "#e3e3e8") } },
    },
    valueAxis: {
      axisLine: { lineStyle: { color: v("--rp-border", "#e3e3e8") } },
      axisLabel: { color: v("--rp-text-muted", "#5f5f6b") },
      splitLine: { lineStyle: { color: v("--rp-border", "#e3e3e8") } },
    },
    legend: { textStyle: { color: v("--rp-text", "#1a1a1f") } },
    tooltip: {
      backgroundColor: v("--rp-surface", "#ffffff"),
      borderColor:     v("--rp-border", "#e3e3e8"),
      textStyle: { color: v("--rp-text", "#1a1a1f") },
    },
  });
}
