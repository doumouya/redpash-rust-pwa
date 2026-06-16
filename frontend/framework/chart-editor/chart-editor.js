/* chart-editor — author a chart over a CSV file: pick a source file + a group-by
   column + a measure (agg fn/col) + a chart type + a theme, and see a LIVE preview
   that re-renders as you change anything. The data comes from the real aggregation
   engine (POST /api/group/preview), shaped into the chart cfg.option the chart
   subsystem reads. The editor holds the cfg; getPayload() returns the
   { source_file_id, title, spec } the Designer POSTs to /api/charts. Sole owner of
   .rp-ce-*. Composes select/atoms + chart/render + chart/build.

   mountChartEditor(host, { files:[{rid,filename}], initial?:{title,source_file_id,spec},
     onChange?(cfg) }) → { el, getPayload(), valid(), destroy } */

import { el } from "../boot/dom.js";
import { api } from "../boot/api.js";
import { register } from "../registry/component-registry.js";
import { mountSelect } from "../select/select.js";
import { input } from "../atoms/atoms.js";
import { TYPE_LIST, TYPE_TO_KIND, THEMES } from "../chart/build.js";
import { renderChart, synthesizeOption } from "../chart/render.js";

const AGG_FNS = [
  ["count", "Count"], ["sum", "Sum"], ["mean", "Average"],
  ["min", "Min"], ["max", "Max"], ["count_distinct", "Distinct"],
];

export function mountChartEditor(host, cfg = {}) {
  const files = cfg.files || [];
  // The live chart cfg (the spec we persist). Seeded from `initial.spec` when editing.
  const c = {
    kind: "cartesian", type: "bar", theme: "redpash-newdark",
    legend: true, legendPos: "top", tooltip: true, axisLine: true, splitLines: true,
    group_by: "", agg_fn: "count", agg_col: "", option: null,
    ...(cfg.initial?.spec || {}),
  };
  let sourceId = cfg.initial?.source_file_id || (files[0] && files[0].rid) || "";
  let title = cfg.initial?.title || "";
  let columns = [];          // the source file's columns
  let inst = null;           // the preview ECharts instance
  let seq = 0;               // guards rapid edits racing their /group/preview

  const root = el("div", { class: "rp-ce" });
  const form = el("div", { class: "rp-ce-form" });
  const preview = el("div", { class: "rp-ce-preview" });
  root.append(form, preview);
  host.append(root);

  const field = (label, controlHost) =>
    el("label", { class: "rp-ce-field" }, el("span", { class: "rp-ce-label" }, label), controlHost);

  // ── controls ────────────────────────────────────────────────────────────────
  const titleHost = el("span");
  titleHost.append(input({ placeholder: "Chart title", value: title, onInput: (v) => { title = v; } }));

  const sourceHost = el("span");
  const typeHost = el("span");
  const groupHost = el("span");
  const fnHost = el("span");
  const colHost = el("span");
  const themeHost = el("span");

  mountSelect(sourceHost, {
    options: files.map((f) => ({ value: f.rid, label: f.filename })),
    value: sourceId,
    onChange: async (v) => { sourceId = v; await loadColumns(); refreshDataControls(); rebuild(); },
  });
  mountSelect(typeHost, {
    options: TYPE_LIST.map(([t, , label]) => ({ value: t, label })),
    value: c.type,
    onChange: (v) => { c.type = v; c.kind = TYPE_TO_KIND[v] || "cartesian"; rebuild(); },
  });
  mountSelect(themeHost, {
    options: Object.entries(THEMES).map(([k, t]) => ({ value: k, label: t.name })),
    value: c.theme,
    onChange: (v) => { c.theme = v; rebuild(); },
  });

  form.append(
    field("Title", titleHost),
    field("Source file", sourceHost),
    field("Chart type", typeHost),
    field("Group by", groupHost),
    field("Measure", fnHost),
    field("Of column", colHost),
    field("Theme", themeHost),
  );

  // Group-by + agg-col selects are rebuilt whenever the source's columns change.
  function refreshDataControls() {
    groupHost.replaceChildren();
    colHost.replaceChildren();
    fnHost.replaceChildren();
    const colOpts = columns.map((k) => ({ value: k, label: k }));
    if (!columns.includes(c.group_by)) c.group_by = columns[0] || "";
    if (!columns.includes(c.agg_col)) c.agg_col = columns[0] || "";
    mountSelect(groupHost, { options: colOpts, value: c.group_by, onChange: (v) => { c.group_by = v; rebuild(); } });
    mountSelect(fnHost, { options: AGG_FNS.map(([v, l]) => ({ value: v, label: l })), value: c.agg_fn, onChange: (v) => { c.agg_fn = v; rebuild(); } });
    mountSelect(colHost, { options: colOpts, value: c.agg_col, onChange: (v) => { c.agg_col = v; rebuild(); } });
  }

  async function loadColumns() {
    if (!sourceId) { columns = []; return; }
    try {
      const page = await api.get(`/files/${sourceId}/page?offset=0&limit=1`);
      columns = page.columns || [];
    } catch { columns = []; }
  }

  // ── live preview: aggregate via /group/preview → shape → renderChart ─────────
  async function rebuild() {
    const my = ++seq;
    if (!sourceId || !c.group_by) return;
    // count = rows-per-group (no measure column needed); others need agg_col.
    const aggCol = c.agg_fn === "count" ? c.group_by : c.agg_col;
    if (!aggCol) return;
    const spec = {
      group_by: [c.group_by],
      aggregations: [{ col: aggCol, fn: c.agg_fn, alias: `${c.agg_fn} of ${aggCol}` }],
    };
    let out;
    try { out = await api.post(`/group/preview`, { file_id: sourceId, spec }); }
    catch { return; }
    if (my !== seq) return;
    const rows = out.rows || [];
    // first column = the group key; last = the aggregation.
    const data = rows.map((r) => ({ name: String(r[0]), value: Number(r[r.length - 1]) || 0 }));
    c.option = synthesizeOption(data, c.kind);
    inst?.dispose?.();
    inst = renderChart(preview, { cfg: c }, c.theme);
    cfg.onChange?.({ ...c });
  }

  // initial load + first preview
  (async () => { await loadColumns(); refreshDataControls(); rebuild(); })();

  return {
    el: root,
    /** The shape the Designer POSTs to /api/charts. */
    getPayload: () => ({ source_file_id: sourceId, title: title.trim(), spec: { ...c } }),
    valid: () => !!(sourceId && title.trim() && c.group_by),
    destroy: () => { inst?.dispose?.(); root.remove(); },
  };
}

register("chart-editor", mountChartEditor);
