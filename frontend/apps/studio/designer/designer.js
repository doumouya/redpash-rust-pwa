/* studio/designer — the Designer (chart/dashboard builder). D1 SHELL: the 15×10
   dashboard-grid (editable: drag to move, drag a corner to resize) with a couple
   of demo elements (two charts + a text tile) so the canvas + ECharts rendering
   are live. The chart editor, the file data binding (/group/preview → cfg.option),
   the controls/dropdown, save/load, and the standalone publish land in the next
   D1/D2/D3 slices. Page lane: composes framework components, no inline styles or
   framework-class literals (the grid + chart own their geometry/classes). */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountDashboardGrid } from "../../../framework/dashboard-grid/dashboard-grid.js";
import { renderChart } from "../../../framework/chart/render.js";
import { chartTheme } from "../../../framework/chart/theme.js";
import { el } from "../../../framework/boot/dom.js";

// A demo chart cfg (no baked data → buildOption paints its small fallback set).
const demoCfg = (kind, type) => ({
  kind, type, legend: true, legendPos: "top", tooltip: true,
  axisLine: true, splitLines: true, agg_fn: "count", agg_col: "value", option: null,
});

// A grid element that renders an ECharts chart filling its cell. A ResizeObserver
// reflows the chart on initial layout AND on every drag-resize (no grid coupling).
function chartCell(kind, type) {
  return (body) => {
    const inst = renderChart(body, { cfg: demoCfg(kind, type) }, chartTheme());
    const ro = new ResizeObserver(() => inst?.resize?.());
    ro.observe(body);
    return { resize: () => inst?.resize?.(), destroy: () => { ro.disconnect(); inst?.dispose?.(); } };
  };
}

export default async function mount(root, ctx) {
  let grid = null;

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "designer",
    title: "Designer",
    meta: "drag a tile to move · drag its corner to resize",
    // The designer rail (GET /api/rail/designer — project → chart/dashboard files).
    // Opening a saved dashboard/chart into the canvas is a later slice.
    rail: { onRailTab: () => {} },
    sections: [{ key: "main" }],
  });

  grid = mountDashboardGrid(page.section("main"), {
    cols: 15,
    rows: 10,
    editable: true,
    elements: [
      { id: "title", x: 0, y: 0, w: 6, h: 1,
        mount: (b) => { b.append(el("div", { class: "pg-studio-designer-text" }, "Untitled dashboard")); return { destroy() {} }; } },
      { id: "demo-bar", x: 0, y: 1, w: 8, h: 5, mount: chartCell("cartesian", "bar") },
      { id: "demo-pie", x: 8, y: 1, w: 7, h: 5, mount: chartCell("pie", "pie") },
    ],
  });

  return { destroy: () => { grid?.destroy(); page.destroy(); } };
}
