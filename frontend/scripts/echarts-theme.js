// ECharts global themes — RedPash Mocha + Latte.
//
// Palette mirrors designer.js:31-41 (Torv's hand-rolled chart themes);
// chrome colours come from frontend/styles/tokens.css. Theme is the
// runtime ECharts option shape (not the builder's editor schema), so
// it plugs straight into echarts.registerTheme().
//
// Lazy: themes register on first call to chartTheme(); zero work when
// the page never paints a chart.

const REGISTERED = { mocha: false, latte: false };

// ── Mocha (dark) — palette: Torv's THEMES.mocha.series verbatim,
//    padded to 8 with --rp-ok + a cool blue. Chrome from
//    tokens.css [data-theme=dark].
const REDPASH_MOCHA = {
  color: [
    "#89b4fa", "#cba6f7", "#94e2d5", "#fab387",
    "#f38ba8", "#f9e2af", "#a6e3a1", "#74c7ec",
  ],
  backgroundColor: "transparent",
  textStyle: {
    color: "#cdd6f4",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  title:  { textStyle: { color: "#cdd6f4", fontWeight: 600 }, subtextStyle: { color: "#a6adc8" } },
  legend: { textStyle: { color: "#a6adc8" }, icon: "roundRect", itemWidth: 14, itemHeight: 9 },
  tooltip: {
    backgroundColor: "#1e1e2e",
    borderColor:     "#313244",
    borderWidth:     1,
    textStyle:       { color: "#cdd6f4" },
    axisPointer: {
      type: "shadow",
      lineStyle:   { color: "#6c7086", width: 1 },
      shadowStyle: { color: "rgba(137, 180, 250, 0.10)" },
    },
  },
  categoryAxis: {
    axisLine:  { show: false, lineStyle: { color: "#313244" } },
    axisTick:  { show: false, lineStyle: { color: "#313244" } },
    axisLabel: { color: "#cdd6f4", fontSize: 12 },
    splitLine: { show: false, lineStyle: { color: ["#313244"] } },
  },
  valueAxis: {
    axisLine:  { show: false, lineStyle: { color: "#313244" } },
    axisTick:  { show: false, lineStyle: { color: "#313244" } },
    axisLabel: { color: "#6c7086", fontSize: 10 },
    splitLine: { show: true,  lineStyle: { color: ["#313244"], type: "dashed", opacity: 0.45 } },
  },
  logAxis:  { axisLine: { show: false, lineStyle: { color: "#313244" } }, axisTick: { show: false }, axisLabel: { color: "#6c7086", fontSize: 10 }, splitLine: { show: true, lineStyle: { color: ["#313244"], type: "dashed", opacity: 0.45 } } },
  timeAxis: { axisLine: { show: false, lineStyle: { color: "#313244" } }, axisTick: { show: false }, axisLabel: { color: "#6c7086", fontSize: 10 }, splitLine: { show: true, lineStyle: { color: ["#313244"], type: "dashed", opacity: 0.45 } } },
  line:    { lineStyle: { width: 2 }, symbolSize: 6, symbol: "circle", smooth: false },
  bar:     { itemStyle: { borderRadius: [0, 4, 4, 0] } },
  pie:     { itemStyle: { borderColor: "#181825", borderWidth: 1 } },
  scatter: { itemStyle: { borderWidth: 0 } },
  visualMap: { color: ["#f38ba8", "#fab387", "#f9e2af", "#a6e3a1", "#89b4fa"], textStyle: { color: "#a6adc8" } },
  dataZoom: {
    backgroundColor:     "rgba(0,0,0,0)",
    dataBackgroundColor: "rgba(255,255,255,0.10)",
    fillerColor:         "rgba(137, 180, 250, 0.18)",
    handleColor:         "#89b4fa",
    textStyle:           { color: "#6c7086" },
  },
};

// ── Latte (light) — Torv's THEMES.latte.series + tokens.css
//    [data-theme=light].
const REDPASH_LATTE = {
  color: [
    "#1e66f5", "#8839ef", "#179299", "#fe640b",
    "#d20f39", "#df8e1d", "#40a02b", "#04a5e5",
  ],
  backgroundColor: "transparent",
  textStyle: {
    color: "#4c4f69",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  title:  { textStyle: { color: "#4c4f69", fontWeight: 600 }, subtextStyle: { color: "#5c5f77" } },
  legend: { textStyle: { color: "#5c5f77" }, icon: "roundRect", itemWidth: 14, itemHeight: 9 },
  tooltip: {
    backgroundColor: "#e6e9ef",
    borderColor:     "#ccd0da",
    borderWidth:     1,
    textStyle:       { color: "#4c4f69" },
    axisPointer: {
      type: "shadow",
      lineStyle:   { color: "#8c8fa1", width: 1 },
      shadowStyle: { color: "rgba(30, 102, 245, 0.10)" },
    },
  },
  categoryAxis: {
    axisLine:  { show: false, lineStyle: { color: "#ccd0da" } },
    axisTick:  { show: false, lineStyle: { color: "#ccd0da" } },
    axisLabel: { color: "#4c4f69", fontSize: 12 },
    splitLine: { show: false, lineStyle: { color: ["#ccd0da"] } },
  },
  valueAxis: {
    axisLine:  { show: false, lineStyle: { color: "#ccd0da" } },
    axisTick:  { show: false, lineStyle: { color: "#ccd0da" } },
    axisLabel: { color: "#8c8fa1", fontSize: 10 },
    splitLine: { show: true,  lineStyle: { color: ["#ccd0da"], type: "dashed", opacity: 0.55 } },
  },
  logAxis:  { axisLine: { show: false, lineStyle: { color: "#ccd0da" } }, axisTick: { show: false }, axisLabel: { color: "#8c8fa1", fontSize: 10 }, splitLine: { show: true, lineStyle: { color: ["#ccd0da"], type: "dashed", opacity: 0.55 } } },
  timeAxis: { axisLine: { show: false, lineStyle: { color: "#ccd0da" } }, axisTick: { show: false }, axisLabel: { color: "#8c8fa1", fontSize: 10 }, splitLine: { show: true, lineStyle: { color: ["#ccd0da"], type: "dashed", opacity: 0.55 } } },
  line:    { lineStyle: { width: 2 }, symbolSize: 6, symbol: "circle", smooth: false },
  bar:     { itemStyle: { borderRadius: [0, 4, 4, 0] } },
  pie:     { itemStyle: { borderColor: "#ffffff", borderWidth: 1 } },
  scatter: { itemStyle: { borderWidth: 0 } },
  visualMap: { color: ["#d20f39", "#fe640b", "#df8e1d", "#40a02b", "#1e66f5"], textStyle: { color: "#5c5f77" } },
  dataZoom: {
    backgroundColor:     "rgba(0,0,0,0)",
    dataBackgroundColor: "rgba(0,0,0,0.10)",
    fillerColor:         "rgba(30, 102, 245, 0.18)",
    handleColor:         "#1e66f5",
    textStyle:           { color: "#8c8fa1" },
  },
};

// Reads <html data-theme>. Mirrors theme.js's currentTheme() return
// shape (light/dark/system → resolved). "system" + light OS → latte;
// any other path → mocha.
function resolveDark() {
  const t = document.documentElement.dataset.theme;
  if (t === "light") return false;
  if (t === "dark")  return true;
  return !window.matchMedia?.("(prefers-color-scheme: light)").matches;
}

/** Returns the registered theme name for the current page theme.
 *  Registers themes on first call so unused themes never pay. Pass
 *  the return value to echarts.init(el, name). */
export function chartTheme() {
  if (!window.echarts) return null;
  const dark = resolveDark();
  const key  = dark ? "redpash-mocha" : "redpash-latte";
  const slot = dark ? "mocha" : "latte";
  if (!REGISTERED[slot]) {
    window.echarts.registerTheme(key, dark ? REDPASH_MOCHA : REDPASH_LATTE);
    REGISTERED[slot] = true;
  }
  return key;
}
