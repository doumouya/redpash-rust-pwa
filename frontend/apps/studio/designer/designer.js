/* studio/designer — the Designer (chart/dashboard builder). D1: the 15×10
   dashboard-grid (editable: drag to move, drag a corner to resize) + a "+ Chart"
   flow that authors a chart over a real CSV (the chart-editor's /group/preview
   binding), persists it via POST /api/charts, and drops it onto the canvas. The
   demo tiles are a starting canvas; dashboard save/load (PUT /api/dashboards) +
   the controls/dropdown + standalone publish land in the next D1/D2/D3 slices.
   Page lane: composes framework components, no inline styles or framework-class
   literals (the grid + chart + editor own their geometry/classes). */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountDashboardGrid } from "../../../framework/dashboard-grid/dashboard-grid.js";
import { renderChart } from "../../../framework/chart/render.js";
import { chartTheme } from "../../../framework/chart/theme.js";
import { mountChartEditor } from "../../../framework/chart-editor/chart-editor.js";
import { openModal } from "../../../framework/modal/modal.js";
import { toast } from "../../../framework/toast/toast.js";
import { api } from "../../../framework/boot/api.js";
import { el } from "../../../framework/boot/dom.js";

const demoCfg = (kind, type) => ({
  kind, type, legend: true, legendPos: "top", tooltip: true,
  axisLine: true, splitLines: true, agg_fn: "count", agg_col: "value", option: null,
});

// A grid element that renders a chart from its cfg, filling the cell + reflowing
// on resize (the ResizeObserver covers initial layout AND drag-resize).
function chartCell(spec, theme) {
  return (body) => {
    const inst = renderChart(body, { cfg: spec }, theme || spec.theme);
    const ro = new ResizeObserver(() => inst?.resize?.());
    ro.observe(body);
    return { resize: () => inst?.resize?.(), destroy: () => { ro.disconnect(); inst?.dispose?.(); } };
  };
}

export default async function mount(root, ctx) {
  let grid = null;
  let files = [];
  try { files = (await api.get("/files")).items || []; } catch { files = []; }

  // "+ Chart": author a chart over a real file, persist it, drop it on the canvas.
  function openChartModal() {
    const body = el("div");
    let editor = null;
    const modal = openModal({
      title: "New chart",
      body,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: ({ close }) => close() },
        {
          label: "Add chart", variant: "accent",
          onClick: async ({ close }) => {
            if (!editor?.valid()) {
              toast({ message: "Pick a source file, a title, and a group-by", tone: "danger" });
              return;
            }
            const payload = editor.getPayload();
            try {
              const row = await api.post("/charts", payload);
              grid?.addElement({ id: row.redpash_id, x: 0, y: 0, w: 7, h: 4, mount: chartCell(payload.spec) });
              toast({ message: `“${payload.title}” added` });
              close();
            } catch (e) {
              toast({ message: e.message || "Couldn't create the chart", tone: "danger" });
            }
          },
        },
      ],
    });
    editor = mountChartEditor(body, { files });
    void modal;
  }

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "designer",
    title: "Designer",
    meta: "drag a tile to move · drag its corner to resize",
    actions: [{ label: "Chart", icon: "bi-plus-lg", onClick: openChartModal }],
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
      { id: "demo-bar", x: 0, y: 1, w: 8, h: 5, mount: chartCell(demoCfg("cartesian", "bar"), chartTheme()) },
      { id: "demo-pie", x: 8, y: 1, w: 7, h: 5, mount: chartCell(demoCfg("pie", "pie"), chartTheme()) },
    ],
  });

  return { destroy: () => { grid?.destroy(); page.destroy(); } };
}
