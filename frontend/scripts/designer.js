// Designer — inline chart authoring in the workspace.
//
// When the workspace opens a chart-typed file, mountDesigner() takes
// over the chart area: a compact edit strip above the canvas (kind /
// group_by / agg col / agg fn / title), a live ECharts preview, and
// a Save button. The chart's source data file (chart.source_file_id)
// stays fixed for a given chart; the preview runs against it via
// POST /api/group/preview with a single-aggregation single-group
// spec, then bakes the resulting ECharts option into the chart's
// spec.option on save (so dashboards reading the saved option don't
// need to re-aggregate).
//
// C1 scope per Em's pick:
//   kinds:    bar | line | area | pie
//   spec:     { kind, group_by, agg_col, agg_fn, title, option }
//   wiring:   live preview + save (PUT /api/charts/:rid)
// Other kinds + modifiers (donut, stacked, smooth, …) land in C2+.

import { api } from "/scripts/api.js";

const CHART_KINDS = [
  ["bar",   "Bar",   "bi-bar-chart-line"],
  ["line",  "Line",  "bi-graph-up"],
  ["area",  "Area",  "bi-graph-up-arrow"],
  ["pie",   "Pie",   "bi-pie-chart"],
];

const AGG_FNS = [
  ["count",          "Count"],
  ["count_distinct", "Count distinct"],
  ["sum",            "Sum"],
  ["mean",           "Mean"],
  ["min",            "Min"],
  ["max",            "Max"],
];

const PREVIEW_DEBOUNCE_MS = 300;

// ctx: { stripEl, chartEl, getSource() → { rid, columns }, onSaved(chart) }
//   - stripEl:  DOM element where the edit strip mounts (already in HTML)
//   - chartEl:  DOM element where ECharts initialises
//   - getSource: returns { rid: source_file_id, columns: ColumnMeta[] }
//                for the chart's source data file (NOT the chart file)
//   - onSaved:  called after a successful PUT with the saved Chart
export function mountDesigner(stripEl, chartEl, ctx) {
  // chart: { redpash_id, source_file_id, title, spec, ... }
  let chart       = null;
  let chartInst   = null;       // echarts instance (window.echarts.init)
  let previewTimer = null;
  let dirty       = false;       // any unsaved spec edits
  let busy        = false;       // PUT in flight

  // Spec live in module state so handlers don't have to dig through
  // chart.spec every time. Defaults match an empty bar chart on the
  // first available column — the user picks a different shape next.
  let spec = blankSpec();

  function blankSpec(cols) {
    const firstCol = (cols && cols[0]?.name) || "";
    return {
      kind:     "bar",
      group_by: firstCol,
      agg_col:  "*",
      agg_fn:   "count",
      title:    "",
    };
  }

  // ── load ──────────────────────────────────────────────────────────
  // Bind a fresh chart into the designer. Called every time loadFile
  // opens a chart-typed file (or right after a create-then-open
  // sequence). Initialises the spec from chart.spec, then renders.
  function load(nextChart) {
    chart = nextChart || null;
    const src = ctx.getSource() || { rid: null, columns: [] };
    spec = mergeSpecDefaults(chart?.spec, src.columns);
    dirty = false;
    render();
    runPreview();
  }

  function mergeSpecDefaults(saved, cols) {
    const blank = blankSpec(cols);
    if (!saved) return blank;
    return {
      kind:     saved.kind     || blank.kind,
      group_by: saved.group_by || blank.group_by,
      agg_col:  saved.agg_col  || blank.agg_col,
      agg_fn:   saved.agg_fn   || blank.agg_fn,
      title:    saved.title    || "",
    };
  }

  // ── render — edit strip ───────────────────────────────────────────
  function render() {
    const src = ctx.getSource() || { rid: null, columns: [] };
    const cols = src.columns || [];
    if (!chart) {
      stripEl.innerHTML = '';
      stripEl.hidden = true;
      return;
    }
    stripEl.hidden = false;
    const kindBtns = CHART_KINDS.map(([v, l, icon]) =>
      '<button type="button" class="rt-designer-kind' + (v === spec.kind ? ' is-active' : '') + '"'
      + ' data-kind="' + esc(v) + '" title="' + esc(l) + '">'
      + '<i class="bi ' + esc(icon) + '"></i> ' + esc(l)
      + '</button>').join('');
    const colOpts = cols.length
      ? cols.map((c) =>
          '<option value="' + esc(c.name) + '"'
          + (c.name === spec.group_by ? ' selected' : '') + '>'
          + esc(c.name) + '</option>').join('')
      : '<option value="">(source file has no columns)</option>';
    const aggColOpts = '<option value="*"'
      + (spec.agg_col === "*" ? ' selected' : '') + '>(count *)</option>'
      + cols.map((c) =>
          '<option value="' + esc(c.name) + '"'
          + (c.name === spec.agg_col ? ' selected' : '') + '>'
          + esc(c.name) + '</option>').join('');
    const aggFnOpts = AGG_FNS.map(([v, l]) =>
      '<option value="' + esc(v) + '"'
      + (v === spec.agg_fn ? ' selected' : '') + '>'
      + esc(l) + '</option>').join('');
    stripEl.innerHTML =
        '<div class="rt-designer-row">'
      +   '<div class="rt-designer-kinds">' + kindBtns + '</div>'
      +   '<input class="rt-designer-title" type="text" placeholder="Untitled chart"'
      +     ' data-key="title" value="' + esc(spec.title || "") + '" />'
      +   '<button class="rt-btn rt-btn--accent rt-designer-save" type="button"'
      +     (dirty ? '' : ' disabled') + (busy ? ' disabled' : '') + '>'
      +     '<i class="bi bi-save"></i> Save'
      +     (dirty ? ' <span class="rt-designer-dot">●</span>' : '')
      +   '</button>'
      + '</div>'
      + '<div class="rt-designer-row rt-designer-row--fields">'
      +   '<label class="rt-designer-field">'
      +     '<span>X / category</span>'
      +     '<select data-key="group_by">' + colOpts + '</select>'
      +   '</label>'
      +   '<label class="rt-designer-field">'
      +     '<span>Y / column</span>'
      +     '<select data-key="agg_col">' + aggColOpts + '</select>'
      +   '</label>'
      +   '<label class="rt-designer-field">'
      +     '<span>Aggregation</span>'
      +     '<select data-key="agg_fn">' + aggFnOpts + '</select>'
      +   '</label>'
      + '</div>';
  }

  // ── handlers ──────────────────────────────────────────────────────
  stripEl.addEventListener("click", (e) => {
    const kind = e.target.closest("[data-kind]");
    if (kind) {
      spec.kind = kind.dataset.kind;
      dirty = true;
      render();
      runPreview();
      return;
    }
    if (e.target.closest(".rt-designer-save")) {
      void save();
    }
  });
  stripEl.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-key]");
    if (!sel) return;
    const key = sel.dataset.key;
    if (["kind", "group_by", "agg_col", "agg_fn"].includes(key)) {
      spec[key] = sel.value;
      dirty = true;
      previewSoon();
      render();
    }
  });
  stripEl.addEventListener("input", (e) => {
    const inp = e.target.closest('[data-key="title"]');
    if (!inp) return;
    spec.title = inp.value;
    dirty = true;
    // Title change is cosmetic — just rebuild the chart option for
    // the title text + flag the dirty state without re-rendering
    // the whole strip (keeps focus in the input).
    const dot = stripEl.querySelector(".rt-designer-dot");
    if (!dot) {
      const saveBtn = stripEl.querySelector(".rt-designer-save");
      if (saveBtn) { saveBtn.disabled = false; saveBtn.insertAdjacentHTML("beforeend", ' <span class="rt-designer-dot">●</span>'); }
    }
    previewSoon();
  });

  // ── preview — POST /api/group/preview → ECharts option ────────────
  function previewSoon() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
  }

  async function runPreview() {
    if (!chart || !chartEl) return;
    const src = ctx.getSource();
    if (!src?.rid) {
      renderChartState("Source file unavailable.");
      return;
    }
    if (!spec.group_by) {
      renderChartState("Pick an X / category column.");
      return;
    }
    try {
      const page = await api.post("/group/preview", {
        source_file_id: src.rid,
        spec: {
          group_by:       [spec.group_by],
          group_by_cols:  [],
          aggregations:   [
            spec.agg_col === "*" || spec.agg_fn === "count"
              ? { col: spec.agg_col || "*", fn: spec.agg_fn }
              : { col: spec.agg_col, fn: spec.agg_fn },
          ],
          filter:         null,
          show_details:   false,
          show_subtotals: true,
          show_total:     false,
          sort:           [],
          charts:         [],
          top_n:          null,
          windows:        [],
        },
      });
      const sub = page?.subtotals;
      if (!sub || !sub.rows?.length) {
        renderChartState("No rows in this preview.");
        return;
      }
      const labels = sub.rows.map((r) => fmtCell(r[0]));
      const values = sub.rows.map((r) => Number(r[1]) || 0);
      const opt    = buildOption(spec, labels, values);
      renderEcharts(opt);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Preview failed";
      renderChartState(msg);
    }
  }

  // Minimal ECharts option builder — covers the 4 C1 kinds. Other
  // kinds + modifiers (donut, smooth, stacked, …) extend per-kind
  // branches as they land.
  function buildOption(s, labels, values) {
    const title = s.title?.trim()
      ? { text: s.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
      : undefined;
    const topPad = title ? 36 : 12;
    if (s.kind === "pie") {
      return {
        title,
        tooltip: { trigger: "item" },
        series: [{
          type:   "pie",
          radius: ["0%", "62%"],
          data:   labels.map((name, i) => ({ name, value: values[i] })),
        }],
      };
    }
    const yType = "value";
    const series = {
      bar:  { type: "bar",  data: values },
      line: { type: "line", data: values, smooth: false },
      area: { type: "line", data: values, areaStyle: {} },
    }[s.kind] || { type: "bar", data: values };
    return {
      title,
      grid:    { left: 50, right: 16, top: topPad, bottom: 36, containLabel: true },
      tooltip: { trigger: "axis" },
      xAxis:   { type: "category", data: labels, axisLabel: { fontSize: 11 } },
      yAxis:   { type: yType, axisLabel: { fontSize: 11 } },
      series:  [series],
    };
  }

  function renderEcharts(opt) {
    if (!window.echarts || !chartEl) return;
    chartEl.innerHTML = "";
    if (!chartInst) chartInst = window.echarts.init(chartEl);
    chartInst.setOption(opt, true);
    chartInst.resize();
  }

  function renderChartState(msg) {
    if (!chartEl) return;
    chartEl.innerHTML = '<div class="rt-chart__state">' + esc(msg) + '</div>';
    chartInst = null;
  }

  // ── save — PUT /api/charts/:rid ───────────────────────────────────
  // Bakes the current ECharts option into the spec so a later viewer
  // (dashboard widget, embed) can render without re-aggregating.
  async function save() {
    if (!chart || busy) return;
    busy = true;
    render();
    try {
      const opt = chartInst?.getOption?.() || null;
      const body = {
        source_file_id: chart.source_file_id,
        title:          spec.title || chart.title || "Untitled chart",
        spec: {
          kind:     spec.kind,
          group_by: spec.group_by,
          agg_col:  spec.agg_col,
          agg_fn:   spec.agg_fn,
          title:    spec.title,
          option:   opt,
        },
      };
      const saved = await api.put("/charts/" + encodeURIComponent(chart.redpash_id), body);
      chart = saved;
      dirty = false;
      ctx.onSaved?.(saved);
    } catch (err) {
      const msg = (err && (err.body?.message || err.body?.error)) || err?.message || "Save failed";
      renderChartState(msg);
    } finally {
      busy = false;
      render();
    }
  }

  // ── resize hook — workspace can call this on layout change ────────
  function resize() { chartInst?.resize(); }
  function unmount() {
    if (previewTimer) clearTimeout(previewTimer);
    chartInst?.dispose?.();
    chartInst = null;
    stripEl.innerHTML = "";
    stripEl.hidden = true;
  }

  return { load, resize, unmount };
}

// ─── helpers ─────────────────────────────────────────────────────────
function fmtCell(v) {
  if (v == null) return "∅";
  return String(v);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
