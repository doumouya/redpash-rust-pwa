// Shared chart-rendering helpers — used by the reports preview AND
// dashboard chart-ref widgets. Keeping them here means a chart looks
// the same whether you're authoring it on the report page or viewing
// it embedded in a dashboard.
//
// Each chart fetches its OWN /reports/preview against the report's
// source file with the chart's group_by + aggregation. The response
// is a pre-aggregated subtotals frame with two columns:
//   [<group_by_col>, <agg_alias>]
// `chartOption(cfg, labels, values)` turns those into an ECharts opt.
//
// Supported kinds: bar | bar_horizontal | line | area | pie
// Modifiers: smooth (line/area), donut (pie)

export function chartOption(cfg, labels, values) {
  const kind   = normalizeKind(cfg.kind);
  const title  = cfg.title?.trim()
    ? { text: cfg.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
    : undefined;
  const titleOffset = title ? 30 : 12;

  if (kind === "pie") {
    const series = {
      type:   "pie",
      radius: cfg.donut ? ["45%", "70%"] : ["0%", "65%"],
      data:   labels.map((l, i) => ({ name: l, value: values[i] })),
    };
    if (cfg.half) {
      // Half-circle pie. ECharts sweeps clockwise from startAngle to
      // endAngle; 180→360 produces the "opening downward" half-donut
      // the official `pie-half-donut` example uses.
      series.startAngle = 180;
      series.endAngle   = 360;
    }
    if (cfg.rose) {
      // Nightingale chart — slice radius scales with value.
      // `area` divides angle equally and varies radius (vs. `radius`
      // which uses both). `borderRadius` rounds wedge corners.
      series.roseType  = "area";
      series.itemStyle = { borderRadius: 6 };
    }
    if (cfg.rich_labels) {
      // 3-line styled label: bold name / large value / muted percent.
      // ECharts callback formatter — params has {name, value, percent}.
      series.label = {
        show: true,
        position: cfg.donut ? "outside" : "inside",
        formatter: (p) => `{name|${p.name}}\n{val|${p.value}}\n{pct|${p.percent}%}`,
        rich: {
          name: { fontSize: 12, fontWeight: 600, lineHeight: 16 },
          val:  { fontSize: 16, fontWeight: 700, lineHeight: 20 },
          pct:  { fontSize: 11, color: "#888",  lineHeight: 14 },
        },
      };
      series.labelLine = { show: cfg.donut };
    }
    return {
      title,
      tooltip: { trigger: "item" },
      legend:  { bottom: 0, type: "scroll" },
      series:  [series],
    };
  }

  if (kind === "pictorial_bar") {
    // Same data shape as bar; the rectangle is replaced by `symbol`.
    // When `symbol_repeat` is true, the symbol tiles along the bar
    // (dotted-bar look). Otherwise one stretched symbol per bar.
    const symbol = cfg.symbol || "circle";
    const repeat = !!cfg.symbol_repeat;
    const axisLabel = labels.length > 12
      ? { rotate: 60 }
      : { interval: 0, rotate: labels.length > 8 ? 30 : 0 };
    return {
      title,
      grid:    { left: 40, right: 12, top: titleOffset, bottom: labels.length > 12 ? 60 : 32 },
      tooltip: { trigger: "axis" },
      xAxis:   { type: "category", data: labels, axisLabel },
      yAxis:   { type: "value" },
      series:  [{
        type:           "pictorialBar",
        symbol,
        symbolRepeat:   repeat,
        symbolSize:     repeat ? ["70%", 14] : ["60%", "90%"],
        symbolMargin:   repeat ? "10%" : undefined,
        symbolClip:     false,
        data:           values,
        animationEasing: "elasticOut",
      }],
    };
  }

  if (kind === "gauge") {
    // Single-scalar series. `labels[0]` is the gauge label (cfg.title
    // or agg_col); `values[0]` is the value (single agg over the
    // filtered dataset — no group_by).
    const value = Number(values[0] ?? 0);
    const name  = labels[0] ?? "";
    // Auto-scale max: default 0–100, but bump up to comfortably hold
    // larger counts/sums (rounded up to the next nice number).
    const max = value > 90
      ? Math.ceil((value * 1.15) / 10) * 10
      : 100;
    return {
      title,
      series: [{
        type:      "gauge",
        min:       0,
        max,
        progress:  { show: true, width: 14 },
        pointer:   { length: "60%", width: 5 },
        axisLine:  { lineStyle: { width: 14 } },
        axisTick:  { distance: -18, length: 5, lineStyle: { color: "#999", width: 1 } },
        splitLine: { distance: -18, length: 12, lineStyle: { color: "#999", width: 2 } },
        axisLabel: { distance: 6, fontSize: 10 },
        anchor:    { show: true, size: 14, itemStyle: { borderColor: "#999", borderWidth: 1 } },
        title:     { show: !!name, offsetCenter: [0, "92%"], fontSize: 12 },
        detail:    { valueAnimation: true, fontSize: 22, offsetCenter: [0, "70%"] },
        data:      [{ value, name }],
      }],
    };
  }

  if (kind === "funnel") {
    return {
      title,
      tooltip: { trigger: "item", formatter: "{b}: {c}" },
      legend:  { bottom: 0, type: "scroll" },
      series:  [{
        type:      "funnel",
        left:      "10%",
        right:     "10%",
        top:       titleOffset + 8,
        bottom:    36,
        sort:      "descending",
        gap:       2,
        label:     { show: true, position: "inside" },
        labelLine: { length: 10, lineStyle: { width: 1, type: "solid" } },
        itemStyle: { borderColor: "#fff", borderWidth: 1 },
        data:      labels.map((l, i) => ({ name: l, value: values[i] })),
      }],
    };
  }

  if (kind === "scatter") {
    // For scatter `labels` carries x-values, `values` carries y-values
    // (both numeric). Non-finite pairs are dropped — wrongly-picked
    // string columns produce an empty plot instead of NaN noise.
    const data = [];
    for (let i = 0; i < labels.length; i++) {
      const x = Number(labels[i]);
      const y = Number(values[i]);
      if (Number.isFinite(x) && Number.isFinite(y)) data.push([x, y]);
    }
    return {
      title,
      grid:    { left: 50, right: 16, top: titleOffset, bottom: 40 },
      tooltip: { trigger: "item" },
      xAxis:   { type: "value", scale: true },
      yAxis:   { type: "value", scale: true },
      // The renderer may append a second `line` series (regression
      // fit) after computing via ecStat — see `withRegression()`.
      series:  [{ type: "scatter", data, symbolSize: 8 }],
    };
  }

  if (kind === "bar_horizontal") {
    // Y-axis is the category axis; X-axis is value. Categories render
    // top-down by default which feels reversed — flip so the first
    // group key shows on top.
    return {
      title,
      grid: { left: 80, right: 20, top: titleOffset, bottom: 32 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis:   { type: "value" },
      yAxis:   { type: "category", data: labels, inverse: true,
                 axisLabel: { width: 70, overflow: "truncate" } },
      series:  [{ type: "bar", data: values }],
    };
  }

  // bar | line | area
  const axisLabel = labels.length > 12
    ? { rotate: 60 }
    : { interval: 0, rotate: labels.length > 8 ? 30 : 0 };

  if (kind === "line" || kind === "area") {
    return {
      title,
      grid: { left: 40, right: 12, top: titleOffset, bottom: labels.length > 12 ? 60 : 32 },
      tooltip: { trigger: "axis" },
      xAxis:   { type: "category", data: labels, axisLabel,
                 boundaryGap: false },  // line charts hug the axis
      yAxis:   { type: "value" },
      series:  [{
        type:      "line",
        data:      values,
        smooth:    !!cfg.smooth,
        areaStyle: kind === "area" ? {} : undefined,
      }],
    };
  }

  // Default: vertical bar.
  const barSeries = { type: "bar", data: values };
  if (cfg.rich_labels) {
    // 2-line styled label above each bar: muted category / bold value.
    barSeries.label = {
      show:      true,
      position:  "top",
      formatter: (p) => `{name|${p.name}}\n{val|${p.value}}`,
      rich: {
        name: { fontSize: 11, color: "#888",  lineHeight: 14 },
        val:  { fontSize: 13, fontWeight: 700, lineHeight: 18 },
      },
    };
  }
  return {
    title,
    grid: { left: 40, right: 12, top: titleOffset, bottom: labels.length > 12 ? 60 : 32 },
    tooltip: { trigger: "axis" },
    xAxis:   { type: "category", data: labels, axisLabel },
    yAxis:   { type: "value" },
    series:  [barSeries],
  };
}

function normalizeKind(k) {
  return ({
    bar: 1, bar_horizontal: 1, line: 1, area: 1, pie: 1, scatter: 1,
    funnel: 1, gauge: 1, pictorial_bar: 1, heatmap: 1, radar: 1,
    boxplot: 1, calendar: 1, matrix: 1,
  }[k] ? k : "bar");
}

// Pull labels/values out of a `/reports/preview` subtotals payload,
// where rows are [group_by_value, agg_value]. Non-numeric agg values
// are coerced to 0 (the chart shows them as a flat bar).
export function subtotalsToSeries(subtotals) {
  const rows = subtotals?.rows ?? [];
  return {
    labels: rows.map((r) => String(r[0] ?? "")),
    values: rows.map((r) => Number(r[1] ?? 0)),
  };
}

// Pull x/y values out of a `/reports/preview` *details* payload for
// scatter rendering. The chart spec's `group_by` names the X column
// and `agg_col` names the Y column — both are looked up against the
// raw source columns. Returns parallel `labels` (x) and `values` (y)
// arrays so it plugs into the same `chartOption(cfg, labels, values)`
// signature as category charts.
export function detailsToScatterSeries(details, xCol, yCol) {
  const cols = details?.columns ?? [];
  const xIdx = cols.indexOf(xCol);
  const yIdx = cols.indexOf(yCol);
  if (xIdx < 0 || yIdx < 0) return { labels: [], values: [] };
  const rows = details.rows ?? [];
  return {
    labels: rows.map((r) => r[xIdx]),
    values: rows.map((r) => r[yIdx]),
  };
}

// Body fragment for `/reports/preview`. Four shapes:
//   • aggregated charts (bar/line/pie/area/bar_horizontal/funnel/
//     pictorial_bar) — group_by + agg, returns subtotals.
//   • scatter — no aggregation, returns raw filtered rows in details
//     (capped at the backend's 1000-row detail limit).
//   • gauge — single scalar, no group_by. Returns a one-row subtotals.
//   • heatmap — two group-by columns, returns (x, y, value) rows.
export function chartPreviewBody(sourceFileId, chartCfg, reportFilter) {
  if (chartCfg.kind === "scatter") {
    return {
      source_file_id: sourceFileId,
      spec: {
        group_by:       [],
        group_by_cols:  [],
        aggregations:   [],
        filter:         reportFilter ?? null,
        show_details:   true,
        show_subtotals: false,
        show_total:     false,
        sort:           [],
      },
    };
  }
  const aggCol = chartCfg.agg_fn === "count" && !chartCfg.agg_col ? "*" : (chartCfg.agg_col || "*");
  if (chartCfg.kind === "boxplot") {
    // Five aggregations on the same numeric column per group: ECharts
    // boxplot expects [min, Q1, median, Q3, max] per category.
    const valueCol = chartCfg.agg_col || "";
    return {
      source_file_id: sourceFileId,
      spec: {
        group_by:       [chartCfg.group_by],
        group_by_cols:  [],
        aggregations:   [
          { col: valueCol, fn: "min",    alias: "_min" },
          { col: valueCol, fn: "q1",     alias: "_q1"  },
          { col: valueCol, fn: "median", alias: "_med" },
          { col: valueCol, fn: "q3",     alias: "_q3"  },
          { col: valueCol, fn: "max",    alias: "_max" },
        ],
        filter:         reportFilter ?? null,
        show_details:   false,
        show_subtotals: true,
        show_total:     false,
        sort:           [],
      },
    };
  }
  if (chartCfg.kind === "heatmap" || chartCfg.kind === "radar" || chartCfg.kind === "matrix") {
    // heatmap / radar / matrix all need two categorical dims + one
    // value. Heatmap + matrix render a 2D grid coloured by value
    // (matrix on the ECharts `matrix` coord system); radar plots each
    // unique value of group_by as a polygon with spokes from y_group_by.
    return {
      source_file_id: sourceFileId,
      spec: {
        group_by:       [chartCfg.group_by, chartCfg.y_group_by].filter(Boolean),
        group_by_cols:  [],
        aggregations:   [{ col: aggCol, fn: chartCfg.agg_fn || "count", alias: "value" }],
        filter:         reportFilter ?? null,
        show_details:   false,
        show_subtotals: true,
        show_total:     false,
        sort:           [],
      },
    };
  }
  if (chartCfg.kind === "gauge") {
    return {
      source_file_id: sourceFileId,
      spec: {
        group_by:       [],
        group_by_cols:  [],
        aggregations:   [{ col: aggCol, fn: chartCfg.agg_fn || "count", alias: "value" }],
        filter:         reportFilter ?? null,
        show_details:   false,
        show_subtotals: true,
        show_total:     false,
        sort:           [],
      },
    };
  }
  return {
    source_file_id: sourceFileId,
    spec: {
      group_by:       [chartCfg.group_by],
      group_by_cols:  [],
      aggregations:   [{ col: aggCol, fn: chartCfg.agg_fn || "count", alias: "value" }],
      filter:         reportFilter ?? null,
      show_details:   false,
      show_subtotals: true,
      show_total:     false,
      sort:           [],
    },
  };
}

// Pull a single scalar out of a one-row subtotals payload (used by
// gauge). Returns parallel arrays so it plugs into chartOption's
// (cfg, labels, values) signature like every other extractor.
export function subtotalsToScalar(subtotals, name) {
  const v = subtotals?.rows?.[0]?.[0];
  return {
    labels: [name ?? ""],
    values: [Number(v ?? 0)],
  };
}

// Convert two-group-by subtotal rows [x, y, value] into the shape
// ECharts heatmap wants: distinct x labels + y labels (in first-seen
// order, matching backend sort) + data triples of [xIdx, yIdx, value].
export function subtotalsToHeatmap(subtotals) {
  const rows  = subtotals?.rows ?? [];
  const xVals = []; const yVals = []; const data = [];
  const xMap  = new Map(); const yMap = new Map();
  for (const r of rows) {
    const x = String(r[0] ?? "");
    const y = String(r[1] ?? "");
    const v = Number(r[2] ?? 0);
    if (!xMap.has(x)) { xMap.set(x, xVals.length); xVals.push(x); }
    if (!yMap.has(y)) { yMap.set(y, yVals.length); yVals.push(y); }
    if (Number.isFinite(v)) data.push([xMap.get(x), yMap.get(y), v]);
  }
  return { xValues: xVals, yValues: yVals, data };
}

// Heatmap ECharts option. Separate from `chartOption` because the
// data shape is fundamentally different (triples instead of parallel
// arrays). visualMap range autoscales to the data's max value.
export function chartOptionHeatmap(cfg, xValues, yValues, data) {
  const title = cfg.title?.trim()
    ? { text: cfg.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
    : undefined;
  const titleOffset = title ? 30 : 12;
  let maxV = 0;
  for (const d of data) { if (d[2] > maxV) maxV = d[2]; }
  return {
    title,
    tooltip: {
      position: "top",
      formatter: (p) =>
        `${esc(xValues[p.data[0]])} / ${esc(yValues[p.data[1]])}<br/>${p.data[2]}`,
    },
    grid: {
      left:   90,
      right:  20,
      top:    titleOffset + 8,
      bottom: 60,
    },
    xAxis: {
      type: "category",
      data: xValues,
      axisLabel: xValues.length > 12
        ? { rotate: 60 }
        : { interval: 0, rotate: xValues.length > 8 ? 30 : 0 },
      splitArea: { show: true },
    },
    yAxis: {
      type: "category",
      data: yValues,
      axisLabel: { width: 80, overflow: "truncate" },
      splitArea: { show: true },
    },
    visualMap: {
      min:        0,
      max:        maxV || 1,
      calculable: true,
      orient:     "horizontal",
      left:       "center",
      bottom:     8,
    },
    series: [{
      type:     "heatmap",
      data,
      // Cell labels are only readable below ~200 cells; above that
      // the heat color carries the signal.
      label:    { show: data.length <= 200 },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// Convert two-group-by subtotal rows [series, indicator, value] into
// a radar-shaped payload. Each unique `series` value becomes one
// polygon; each unique `indicator` value becomes one axis (spoke).
// Per-indicator max is the data's actual max so the radar fills the
// canvas without clipping.
export function subtotalsToRadar(subtotals) {
  const rows = subtotals?.rows ?? [];
  const seriesMap = new Map();         // series → Map<indicator, value>
  const indicatorOrder = [];           // first-seen indicators (stable order)
  const indicatorSet   = new Set();
  for (const r of rows) {
    const s = String(r[0] ?? "");
    const i = String(r[1] ?? "");
    const v = Number(r[2] ?? 0);
    if (!indicatorSet.has(i)) { indicatorSet.add(i); indicatorOrder.push(i); }
    if (!seriesMap.has(s)) seriesMap.set(s, new Map());
    seriesMap.get(s).set(i, Number.isFinite(v) ? v : 0);
  }
  // Max per indicator across all series — radar axis scale.
  const maxByInd = new Map();
  for (const vals of seriesMap.values()) {
    for (const [ind, v] of vals) {
      if (!maxByInd.has(ind) || v > maxByInd.get(ind)) maxByInd.set(ind, v);
    }
  }
  const indicators = indicatorOrder.map((ind) => ({
    name: ind,
    max:  Math.max(maxByInd.get(ind) ?? 1, 1),  // floor at 1 so 0-axes still render
  }));
  const series = Array.from(seriesMap.entries()).map(([name, vals]) => ({
    name,
    value: indicatorOrder.map((ind) => vals.get(ind) ?? 0),
  }));
  return { indicators, series };
}

// Convert subtotals where each row is [group, min, q1, median, q3, max]
// into ECharts boxplot data: `[labels, data]` where data[i] is the
// five-number summary for that group. Empty/non-numeric stats are
// coerced to 0 to keep the chart rendering rather than throwing.
export function subtotalsToBoxplot(subtotals) {
  const rows = subtotals?.rows ?? [];
  const labels = []; const data = [];
  for (const r of rows) {
    labels.push(String(r[0] ?? ""));
    data.push([1, 2, 3, 4, 5].map((i) => Number(r[i] ?? 0)));
  }
  return { labels, data };
}

export function chartOptionBoxplot(cfg, labels, data) {
  const title = cfg.title?.trim()
    ? { text: cfg.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
    : undefined;
  const titleOffset = title ? 30 : 12;
  const axisLabel = labels.length > 12
    ? { rotate: 60 }
    : { interval: 0, rotate: labels.length > 8 ? 30 : 0 };
  return {
    title,
    grid: { left: 50, right: 16, top: titleOffset, bottom: labels.length > 12 ? 60 : 32 },
    tooltip: { trigger: "item", axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: labels, axisLabel, boundaryGap: true },
    yAxis: { type: "value", scale: true },
    series: [{
      type:   "boxplot",
      data,
      itemStyle: { borderWidth: 1.2 },
    }],
  };
}

// Convert subtotals where each row is [date_string, value] into the
// ECharts calendar+heatmap data shape `[[date, value], ...]`. Dates
// are passed through as strings — ECharts accepts YYYY-MM-DD natively;
// other formats may need a date-cleaning step on the source CSV first.
export function subtotalsToCalendar(subtotals) {
  const rows = subtotals?.rows ?? [];
  return rows
    .filter((r) => r[0])                       // need a date string
    .map((r) => [String(r[0]), Number(r[1] ?? 0)]);
}

// Auto-pick the calendar's range from the data's min/max dates.
// Single-year data → `"YYYY"`; multi-year → `[minDate, maxDate]`
// which makes ECharts render a multi-row calendar.
function calendarRange(data) {
  if (!data.length) return new Date().getFullYear().toString();
  const dates = data.map((d) => d[0]).filter(Boolean).slice().sort();
  const min   = dates[0];
  const max   = dates[dates.length - 1];
  const minY  = min.slice(0, 4);
  const maxY  = max.slice(0, 4);
  return minY === maxY ? minY : [min, max];
}

export function chartOptionCalendar(cfg, data) {
  const title = cfg.title?.trim()
    ? { text: cfg.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
    : undefined;
  const titleOffset = title ? 30 : 12;
  let maxV = 0;
  for (const d of data) { const v = Number(d[1]); if (v > maxV) maxV = v; }
  const range = calendarRange(data);
  return {
    title,
    tooltip:   { trigger: "item", formatter: (p) => `${p.data[0]}<br/>${p.data[1]}` },
    visualMap: {
      min:        0,
      max:        maxV || 1,
      calculable: true,
      orient:     "horizontal",
      left:       "center",
      bottom:     8,
    },
    calendar: {
      top:      titleOffset + 20,
      left:     50,
      right:    20,
      bottom:   60,
      range,
      cellSize: ["auto", 14],
      yearLabel: { show: Array.isArray(range) },
      dayLabel:  { firstDay: 1 },
    },
    series: [{
      type:             "heatmap",
      coordinateSystem: "calendar",
      data,
    }],
  };
}

export function chartOptionRadar(cfg, indicators, series) {
  const title = cfg.title?.trim()
    ? { text: cfg.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
    : undefined;
  return {
    title,
    tooltip: { trigger: "item" },
    legend:  { bottom: 0, type: "scroll" },
    radar:   { indicator: indicators, shape: "polygon", center: ["50%", "52%"], radius: "62%" },
    series:  [{
      type:      "radar",
      data:      series,
      areaStyle: { opacity: 0.18 },
      lineStyle: { width: 1.5 },
      symbol:    "circle",
      symbolSize: 4,
    }],
  };
}

// Append a regression fit-line series to a scatter chart option.
// `cfg.regression` ∈ { linear | exponential | polynomial | logarithmic }.
// `loader` is `loadECStat` (passed in so this module stays free of
// echarts.js so its surface stays renderable in unit tests if/when).
// Mutates and returns the option.
export async function withRegression(option, cfg, labels, values, loader) {
  if (!cfg.regression || cfg.kind !== "scatter") return option;
  const data = [];
  for (let i = 0; i < labels.length; i++) {
    const x = Number(labels[i]);
    const y = Number(values[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) data.push([x, y]);
  }
  if (data.length < 2) return option;
  let ecStat;
  try { ecStat = await loader(); } catch { return option; }
  const fit = ecStat.regression(cfg.regression, data);
  fit.points.sort((a, b) => a[0] - b[0]);
  option.series.push({
    type:       "line",
    data:       fit.points,
    showSymbol: false,
    smooth:     cfg.regression === "exponential" || cfg.regression === "polynomial",
    lineStyle:  { width: 1.5 },
    name:       fit.expression,
    tooltip:    { trigger: "axis" },
  });
  return option;
}

// Convert two-group-by subtotal rows [x, y, value] into the shape the
// ECharts `matrix` coordinate system wants: distinct x + y category
// labels (first-seen order) + data triples of [xName, yName, value].
// Unlike subtotalsToHeatmap (cartesian grid, index-based), the matrix
// coord system addresses cells by category NAME.
export function subtotalsToMatrix(subtotals) {
  const rows  = subtotals?.rows ?? [];
  const xVals = []; const yVals = []; const data = [];
  const xSeen = new Set(); const ySeen = new Set();
  for (const r of rows) {
    const x = String(r[0] ?? "");
    const y = String(r[1] ?? "");
    const v = Number(r[2] ?? 0);
    if (!xSeen.has(x)) { xSeen.add(x); xVals.push(x); }
    if (!ySeen.has(y)) { ySeen.add(y); yVals.push(y); }
    if (Number.isFinite(v)) data.push([x, y, v]);
  }
  return { xValues: xVals, yValues: yVals, data };
}

// Matrix ECharts option (ECharts 6 `matrix` coordinate system). Same
// two-group-by data as heatmap, but rendered as a heatmap series bound
// to a `matrix` coord component instead of a cartesian grid.
export function chartOptionMatrix(cfg, xValues, yValues, data) {
  const title = cfg.title?.trim()
    ? { text: cfg.title.trim(), left: 8, top: 4, textStyle: { fontSize: 13 } }
    : undefined;
  const titleOffset = title ? 30 : 12;
  let maxV = 0;
  for (const d of data) { if (d[2] > maxV) maxV = d[2]; }
  return {
    title,
    tooltip: {
      position: "top",
      formatter: (p) => `${esc(p.data[0])} / ${esc(p.data[1])}<br/>${p.data[2]}`,
    },
    matrix: {
      x:      { data: xValues },
      y:      { data: yValues },
      top:    titleOffset + 8,
      bottom: 44,
      left:   70,
      right:  16,
    },
    visualMap: {
      type:       "continuous",
      min:        0,
      max:        maxV || 1,
      dimension:  2,
      calculable: true,
      orient:     "horizontal",
      left:       "center",
      bottom:     8,
    },
    series: [{
      type:             "heatmap",
      coordinateSystem: "matrix",
      data,
      label:    { show: data.length <= 200 },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,.3)" } },
    }],
  };
}
