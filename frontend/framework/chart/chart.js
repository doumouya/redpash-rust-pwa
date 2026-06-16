/* chart — the ECharts-backed chart TILE (framework component). A card with an
   optional small uppercase title above a fixed-height ECharts mount slot. Sole
   owner of the .rp-chart-* classes. Data-driven: mountChart(host, {title, option,
   theme?, id?}) mounts an ECharts instance into the canvas (when an `option` +
   window.echarts are present) and wires a resize handler; with no option (or no
   echarts on the page) it renders the faded .rp-chart-card--empty placeholder —
   never blanks the page. Picks up the RedPash themes via theme.js. Ported from
   the prerelease chart tile; rebuilt on lean's el()/register conventions. */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";
import { ensureRegisteredThemes, chartTheme } from "./theme.js";

/**
 * Build + (optionally) wire a chart tile into `host`.
 * cfg: { title?, option?, theme?, id? } — `option` is an ECharts option object
 * (never interpolated into HTML); absent/null → the empty placeholder.
 * Returns { el, canvas, chart, resize(), setOption(opt), dispose() }.
 */
export function mountChart(host, cfg = {}) {
  const { title, option, theme, id } = cfg;
  const hasEcharts = !!(typeof window !== "undefined" && window.echarts);
  const empty = !option || !hasEcharts;

  const card = el("div", { class: "rp-chart-card" + (empty ? " rp-chart-card--empty" : "") });
  if (title) card.append(el("div", { class: "rp-title" }, title));
  // Empty slots omit the canvas id (mount-lookup must never target them).
  const canvas = el("div", { class: "rp-chart-canvas", ...(!empty && id ? { id } : {}) });
  card.append(canvas);
  host.append(card);

  if (empty) {
    return { el: card, canvas, chart: null, resize() {}, setOption() {}, dispose() {}, destroy() {} };
  }

  // ensureRegisteredThemes() is fire-and-forget (memoized); a cold first paint
  // may use the ECharts default theme for a few ms — accepted.
  ensureRegisteredThemes();
  const chart = window.echarts.init(canvas, theme || chartTheme());
  chart.setOption(option);

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);

  return {
    el: card,
    canvas,
    chart,
    resize() { chart.resize(); },
    setOption(opt) { chart.setOption(opt); },
    dispose() { window.removeEventListener("resize", onResize); chart.dispose(); },
    destroy() { window.removeEventListener("resize", onResize); chart.dispose(); },
  };
}

register("chart", mountChart);
