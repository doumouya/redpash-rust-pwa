// charts/monitoring-bank.js — schema + default chart specs per
// Monitoring tab.
//
// Slice D of the chart-pipeline unification (Em 2026-05-27). The
// Monitoring page is configurable per-tab: when the user has saved
// charts under `user_preferences.prefs.monitoringCharts.<tab>` they
// drive the tab's chart strip via `renderChart`; otherwise the page
// falls back to its existing curated kpiX charts (unchanged).
//
// Two exports:
//
//   MON_STATS_SCHEMA
//     Per-tab: which stats endpoint feeds the tab + which dotted
//     pointer fields are addressable inside its response. Drives
//     the field-picker in the Settings chart builder (`source.schema`
//     hands these to mountBuilder's monitoring-stats Data section).
//
//   MON_DEFAULT_CHARTS
//     Per-tab: a small default chart bank rendered via `renderChart`
//     when the user picks "Reset to defaults" in Settings. The
//     defaults are *deliberately sparse* in Slice D — Em's 4-per-tab
//     proposal needs a few server-side stats deltas (by_kind on
//     events, by_tool on findings, daily_counts on runs, …) before
//     all four slots have addressable pointers. Those server deltas
//     land in a follow-up slice; the picker / persistence path is
//     already live in this slice for anything the schema exposes.
//
// Spec shape (matches Slice B's `renderChart` contract):
//   {
//     id:     string,                       // unique within the tab
//     title:  string,                       // shown in the tile header
//     cfg:    { kind, type, theme, ... },   // designer cfg vocabulary
//     source: { kind: "monitoring-stats",
//               endpoint, pointer, window? }
//   }
//
// Adding a new tab → register an entry in both maps. Adding a new
// addressable field on an existing tab → extend that tab's `fields`
// array. Both are pure data; no code changes elsewhere.

export const MON_STATS_SCHEMA = {
  requests: {
    endpoint: "/monitoring/requests/stats",
    // /requests/stats accepts ?window=…; the other endpoints don't
    // today. Settings UI reads this to decide whether to show the
    // window chip in the Data section.
    supportsWindow: true,
    fields: [
      { path: "status_mix",        label: "Status mix",          shape: "kv"    },
      { path: "top_routes",        label: "Top routes by p95",   shape: "array" },
      { path: "buckets.p95_ms",    label: "p95 latency / bucket", shape: "array" },
      { path: "buckets.count",     label: "Request count / bucket", shape: "array" },
    ],
  },
  events: {
    endpoint: "/monitoring/events/stats",
    supportsWindow: true,
    fields: [
      { path: "by_level", label: "By level", shape: "kv" },
      { path: "last_24h", label: "Active last 24h", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
      // by_kind / by_origin land in EventsStats after a server delta
      // (see the Monitoring 4-charts-per-tab proposal).
    ],
  },
  runs: {
    endpoint: "/monitoring/audit-runs/stats",
    supportsWindow: false,
    fields: [
      { path: "by_tool", label: "By tool", shape: "kv" },
      { path: "last_7d", label: "Runs last 7d", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
      // daily_counts / recent_runs_with_findings → server delta.
    ],
  },
  findings: {
    endpoint: "/monitoring/audit-findings/stats",
    supportsWindow: false,
    fields: [
      { path: "by_severity", label: "By severity", shape: "kv" },
      { path: "by_kind",     label: "By kind",     shape: "kv" },
      // by_tool / latest_diff → server delta.
    ],
  },
  steps: {
    endpoint: "/admin/steps/stats",
    supportsWindow: false,
    fields: [
      { path: "by_kind", label: "By kind", shape: "kv" },
      { path: "last_24h", label: "Active last 24h", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
      // by_applied / daily_counts → server delta.
    ],
  },
  // optimization + user_activity render via dedicated paths
  // (renderOptimizationBody / renderUserActivityBody) — they don't
  // share the composite strip, so they don't participate in the
  // Slice D picker. Adding them needs the dedicated renderers to
  // be migrated to the LIST_VIEWS shape first.
};

// Per-tab default charts, rendered through `renderChart` when the
// user hits "Reset to defaults" or has no saved layout for the tab.
// Each spec is a self-contained snapshot the picker can copy + edit.
//
// IDs are stable within a tab (the picker uses them as remove keys);
// `cfg.theme: "redpash-mocha"` mirrors the chrome-matching default
// used elsewhere in the app.
export const MON_DEFAULT_CHARTS = {
  requests: [
    {
      id:    "default-status-mix",
      title: "By status",
      cfg:   { kind: "pie", type: "donut", theme: "redpash-mocha",
               legend: true, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/requests/stats",
               pointer:  "status_mix",
               window:   "24h" },
    },
    {
      id:    "default-p95",
      title: "p95 latency over window",
      cfg:   { kind: "cartesian", type: "line", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: true },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/requests/stats",
               pointer:  "buckets.p95_ms",
               window:   "24h" },
    },
  ],
  events: [
    {
      id:    "default-by-level",
      title: "By level",
      cfg:   { kind: "pie", type: "donut", theme: "redpash-mocha",
               legend: true, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/events/stats",
               pointer:  "by_level",
               window:   "24h" },
    },
    {
      id:    "default-active-24h",
      title: "Active last 24h",
      cfg:   { kind: "gauge", type: "gauge", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/events/stats",
               pointer:  "last_24h",
               transform: { kind: "ratio", denominator: "total", scale: 100 } },
    },
  ],
  runs: [
    {
      id:    "default-by-tool",
      title: "By tool",
      cfg:   { kind: "barh", type: "barh", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/audit-runs/stats",
               pointer:  "by_tool" },
    },
  ],
  findings: [
    {
      id:    "default-by-severity",
      title: "By severity",
      cfg:   { kind: "pie", type: "donut", theme: "redpash-mocha",
               legend: true, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/audit-findings/stats",
               pointer:  "by_severity" },
    },
    {
      id:    "default-by-kind",
      title: "By kind",
      cfg:   { kind: "barh", type: "barh", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/monitoring/audit-findings/stats",
               pointer:  "by_kind" },
    },
  ],
  steps: [
    {
      id:    "default-by-kind",
      title: "By kind",
      cfg:   { kind: "barh", type: "barh", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/steps/stats",
               pointer:  "by_kind" },
    },
  ],
};

// Convenience helper for the Settings panel + Monitoring page.
// Returns the user's saved chart list for a tab when one exists;
// otherwise the default bank.
export function chartsForTab(tabKey, userPref) {
  const saved = userPref?.[tabKey];
  if (Array.isArray(saved)) return saved;
  return MON_DEFAULT_CHARTS[tabKey] || [];
}

// Convenience: empty starter cfg for "+ Add chart" in Settings.
// Picks the first available field for the tab as a safe default
// pointer so the modal opens with a renderable preview.
export function newChartTemplate(tabKey) {
  const schema = MON_STATS_SCHEMA[tabKey];
  if (!schema) return null;
  const first = schema.fields[0];
  return {
    id:    "user-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    title: "New chart",
    cfg:   { kind: "pie", type: "donut", theme: "redpash-mocha",
             legend: true, legendPos: "bottom", tooltip: true,
             splitLines: true, axisLine: true, smooth: false,
             title: "New chart" },
    source:{ kind: "monitoring-stats",
             endpoint: schema.endpoint,
             pointer:  first ? first.path : "",
             ...(schema.supportsWindow ? { window: "24h" } : {}) },
  };
}
