/* Purpose: Chart-tile framework component — the ECharts-backed chart card shared across pages.
   Doc: docs/internal/code/frontend/scripts/framework/chart.md */
// ── Chart tile (framework component, CAS_37B2E1BF) ──────────────────────────
// The ECharts-backed chart TILE: a glass card with a small uppercase title
// above a fixed-height ECharts mount slot. Shared across Home / Monitoring /
// Cases board / Workspace landing. Generic + data-driven: mountChartTile(host,
// {title, option}) emits the rp-chart-card structure and, when an `option` +
// window.echarts are present, mounts an ECharts instance into the canvas and
// wires a resize handler. With no option (or no echarts on the page) it renders
// the faded rp-chart-card--empty placeholder instead — the "lego brick".
//
// Composes, not duplicates:
//   - rp-title atom (atoms.css A6) for the title text — .rp-chart-title is the
//     chart-context sizing override on top of the atom base, NOT a new class.
// Render path mirrors the echarts-kpi.js idiom (ensureRegisteredThemes() then
// window.echarts.init(el, theme || chartTheme())) so the tile picks up the
// RedPash Mocha/Latte themes like every other chart.
//
// SECURITY: the title (the only caller-supplied string reaching innerHTML) is
// escaped via esc() before insertion. The `option` is an ECharts config object
// passed to setOption() — never interpolated into HTML.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";
import { ensureRegisteredThemes, chartTheme } from "/scripts/echarts-theme.js";

// ── config shape ─────────────────────────────────────────────────────────────
//   title  : string                 → rp-chart-title (optional; omit for a
//                                      title-less canvas-only card)
//   option : ECharts option object   → setOption() target. Absent/null → the
//                                      faded rp-chart-card--empty placeholder.
//   theme  : string (optional)       → overrides chartTheme() in echarts.init
//   id     : string (optional)       → set on the canvas (the createListCharts
//                                      mount-lookup contract: querySelector('#'+id))

/**
 * Build + (optionally) wire a chart tile into `host`.
 * `host` becomes the `.rp-chart-card` element. Returns a small controller:
 *   { el, canvas, chart, resize(), setOption(opt), dispose() }.
 * `chart` is the live ECharts instance, or null for an empty/echarts-less tile.
 */
export function mountChartTile(host, config = {}) {
  if (!host) return null;
  const { title, option, theme, id } = config;
  const hasEcharts = !!(typeof window !== "undefined" && window.echarts);
  const empty = !option || !hasEcharts;

  host.className = "rp-chart-card" + (empty ? " rp-chart-card--empty" : "");
  // Empty slots deliberately OMIT the canvas id so the createListCharts
  // mount-lookup never targets them (view.querySelector('#'+id)).
  const idAttr = !empty && id ? ' id="' + esc(id) + '"' : "";
  host.innerHTML =
      (title ? '<div class="rp-chart-title rp-title">' + esc(title) + "</div>" : "")
    + '<div class="rp-chart-canvas"' + idAttr + "></div>";

  const canvas = host.querySelector(".rp-chart-canvas");

  // Empty / no-echarts → CSS-only faded placeholder (the ::after em-dash). No
  // instance, no resize binding — a failed/absent chart never blanks the page.
  if (empty) {
    return {
      el: host,
      canvas,
      chart: null,
      resize() {},
      setOption() {},
      dispose() {},
    };
  }

  // ── ECharts instance ───────────────────────────────────────────────────────
  // ensureRegisteredThemes() is fire-and-forget (memoized; first cold paint may
  // use the ECharts default theme for a few ms — accepted, per echarts-theme.js).
  ensureRegisteredThemes();
  const chart = window.echarts.init(canvas, theme || chartTheme());
  chart.setOption(option);

  // ── resize ───────────────────────────────────────────────────────────────
  // Reflow the instance when the viewport changes. Bound per-tile and removed
  // on dispose() so a torn-down tile leaks neither the listener nor the canvas.
  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);

  return {
    el: host,
    canvas,
    chart,
    /** Reflow this tile's chart (e.g. after a host layout change). */
    resize() { chart.resize(); },
    /** Replace the chart option in place. */
    setOption(opt) { chart.setOption(opt); },
    /** Tear down the instance + drop the resize listener. */
    dispose() {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}

register("chart", mountChartTile);
