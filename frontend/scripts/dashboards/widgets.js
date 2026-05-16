// Widget renderers — chart-ref + text.
//
// Phase 2: widgets reference *saved* charts on reports rather than
// running their own group_by/agg specs. A chart widget carries
// `{ report_id, chart_index, title_override? }`; rendering = fetch the
// report (to read `report.spec.charts[chart_index]`) + its subtotals
// (to plot from). Both fetches are session-cached so a dashboard with
// six charts from one report only hits the network twice.
//
// Render fn signature:
//   renderXxx(host, widget.spec) → Promise<void>

import { api }         from "/scripts/api.js";
import { loadECharts, loadECStat } from "/scripts/dashboards/echarts.js";
import {
  chartOption,
  chartOptionHeatmap,
  chartOptionRadar,
  chartOptionBoxplot,
  chartOptionCalendar,
  subtotalsToSeries,
  subtotalsToScalar,
  subtotalsToHeatmap,
  subtotalsToRadar,
  subtotalsToBoxplot,
  subtotalsToCalendar,
  detailsToScatterSeries,
  chartPreviewBody,
  withRegression,
} from "/scripts/dashboards/chart-render.js";

// Session caches — keyed by RPT id. Cleared on full reload.
const reportCache = new Map();   // rid → Report
async function getReport(rid) {
  if (reportCache.has(rid)) return reportCache.get(rid);
  const r = await api.get(`/reports/${encodeURIComponent(rid)}`);
  reportCache.set(rid, r);
  return r;
}

// ─── Chart (reference to a saved chart on a report) ────────────
export async function renderChart(host, spec) {
  host.innerHTML = `<div class="rp-wchart"></div>`;
  const chartHost = host.firstElementChild;
  if (!spec.report_id) {
    chartHost.innerHTML = `<p class="rp-muted">Pick a report.</p>`;
    return;
  }
  let report;
  try {
    report = await getReport(spec.report_id);
  } catch (err) {
    chartHost.innerHTML = `<p class="rp-muted">${esc(err.message ?? String(err))}</p>`;
    return;
  }
  const charts = report.spec?.charts ?? [];
  const cfg    = charts[spec.chart_index ?? 0];
  if (!cfg) {
    chartHost.innerHTML = `<p class="rp-muted">No chart at this position. The report's charts may have been re-ordered.</p>`;
    return;
  }
  if (!cfg.group_by && cfg.kind !== "gauge") {
    chartHost.innerHTML = `<p class="rp-muted">Chart is unconfigured — open the report to set it up.</p>`;
    return;
  }

  // Run the chart's own group_by + agg against the report's source
  // file (sharing the report's filter). Cached per (report,chart_idx)
  // so re-renders don't refetch.
  const cacheKey = `${spec.report_id}::${spec.chart_index ?? 0}`;
  let res;
  try {
    if (chartRunCache.has(cacheKey)) {
      res = chartRunCache.get(cacheKey);
    } else {
      res = await api.post("/reports/preview",
        chartPreviewBody(report.source_file_id, cfg, report.spec?.filter));
      chartRunCache.set(cacheKey, res);
    }
  } catch (err) {
    chartHost.innerHTML = `<p class="rp-muted">${esc(err.message ?? String(err))}</p>`;
    return;
  }
  const echarts = await loadECharts();
  const title = spec.title_override?.trim() || cfg.title?.trim() || "";

  // Heatmap + radar use the two-group-by data shape but have wildly
  // different visuals — each gets its own option builder. Other kinds
  // share chartOption().
  if (cfg.kind === "heatmap") {
    const hm = subtotalsToHeatmap(res.subtotals);
    if (!hm.data.length) {
      chartHost.innerHTML = `<p class="rp-muted">No data.</p>`;
      return;
    }
    const inst = echarts.init(chartHost, "redpash", { renderer: "svg" });
    inst.setOption(chartOptionHeatmap({ ...cfg, title }, hm.xValues, hm.yValues, hm.data));
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(chartHost);
    chartHost._rpDispose = () => { ro.disconnect(); inst.dispose(); };
    return;
  }
  if (cfg.kind === "radar") {
    const rd = subtotalsToRadar(res.subtotals);
    if (!rd.series.length || !rd.indicators.length) {
      chartHost.innerHTML = `<p class="rp-muted">No data.</p>`;
      return;
    }
    const inst = echarts.init(chartHost, "redpash", { renderer: "svg" });
    inst.setOption(chartOptionRadar({ ...cfg, title }, rd.indicators, rd.series));
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(chartHost);
    chartHost._rpDispose = () => { ro.disconnect(); inst.dispose(); };
    return;
  }
  if (cfg.kind === "boxplot") {
    const bp = subtotalsToBoxplot(res.subtotals);
    if (!bp.data.length) {
      chartHost.innerHTML = `<p class="rp-muted">No data.</p>`;
      return;
    }
    const inst = echarts.init(chartHost, "redpash", { renderer: "svg" });
    inst.setOption(chartOptionBoxplot({ ...cfg, title }, bp.labels, bp.data));
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(chartHost);
    chartHost._rpDispose = () => { ro.disconnect(); inst.dispose(); };
    return;
  }
  if (cfg.kind === "calendar") {
    const cal = subtotalsToCalendar(res.subtotals);
    if (!cal.length) {
      chartHost.innerHTML = `<p class="rp-muted">No data.</p>`;
      return;
    }
    const inst = echarts.init(chartHost, "redpash", { renderer: "svg" });
    inst.setOption(chartOptionCalendar({ ...cfg, title }, cal));
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(chartHost);
    chartHost._rpDispose = () => { ro.disconnect(); inst.dispose(); };
    return;
  }

  const { labels, values } =
    cfg.kind === "scatter" ? detailsToScatterSeries(res.details, cfg.group_by, cfg.agg_col) :
    cfg.kind === "gauge"   ? subtotalsToScalar(res.subtotals, cfg.title?.trim() || cfg.agg_col || "") :
                             subtotalsToSeries(res.subtotals);
  if (!labels.length) {
    chartHost.innerHTML = `<p class="rp-muted">No data.</p>`;
    return;
  }
  const inst = echarts.init(chartHost, "redpash", { renderer: "svg" });
  const opt = chartOption({ ...cfg, title }, labels, values);
  await withRegression(opt, cfg, labels, values, loadECStat);
  inst.setOption(opt);
  const ro = new ResizeObserver(() => inst.resize());
  ro.observe(chartHost);
  chartHost._rpDispose = () => { ro.disconnect(); inst.dispose(); };
}

// Per-(report,chart_index) cache of the chart's /reports/preview
// result. Six widgets on the same chart = 1 network call.
const chartRunCache = new Map();

// ─── Text (plain / very basic markdown) ─────────────────────────
export function renderText(host, spec) {
  const md = String(spec.markdown ?? "");
  // Tiny markdown: headers (#, ##), paragraphs, bold (**…**), italic
  // (*…*), inline code (`…`). Full markdown is overkill for a widget.
  const html = md
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (trimmed.startsWith("## ")) return `<h3>${inline(trimmed.slice(3))}</h3>`;
      if (trimmed.startsWith("# "))  return `<h2>${inline(trimmed.slice(2))}</h2>`;
      return `<p>${inline(trimmed.replace(/\n/g, "<br>"))}</p>`;
    })
    .join("");
  host.innerHTML = `<div class="rp-wtext">${html}</div>`;
  return Promise.resolve();
}
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g,     "<em>$1</em>")
    .replace(/`([^`]+)`/g,        "<code>$1</code>");
}

// Drop any cached report/run so the next render fetches fresh. Used
// when a user edits a report in another tab and comes back here.
export function clearReportCache(rid) {
  if (rid) {
    reportCache.delete(rid);
    // Drop any cached chart runs that belong to this report.
    for (const key of [...chartRunCache.keys()]) {
      if (key.startsWith(`${rid}::`)) chartRunCache.delete(key);
    }
  } else {
    reportCache.clear();
    chartRunCache.clear();
  }
}

// ─── Dispatch ───────────────────────────────────────────────────
export async function renderWidget(host, widget) {
  // Dispose any chart instance left by a previous render.
  host.querySelectorAll(".rp-wchart").forEach((el) => el._rpDispose?.());
  switch (widget.kind) {
    case "chart": return renderChart(host, widget.spec ?? {});
    case "text":  return renderText (host, widget.spec ?? {});
    default:
      host.innerHTML = `<p class="rp-muted">Pick a widget kind.</p>`;
      return;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
