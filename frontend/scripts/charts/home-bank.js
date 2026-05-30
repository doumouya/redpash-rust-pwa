/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/charts/home-bank.md */
// charts/home-bank.js — schema + default chart specs per Home tab.
//
// Slice D2 of the chart-pipeline unification (Em 2026-05-27 — "do the
// same for Home page tabs"). Mirror of monitoring-bank.js for the
// Home page's LIST_VIEWS tabs. Same `monitoring-stats` source kind
// (the resolver just GETs ${endpoint} + extracts a pointer — works
// for any /api/*/stats endpoint regardless of which page consumes it).
//
// Coverage note
// -------------
// Only Home tabs with **directly-addressable** stats fields participate
// in Slice D2. The other tabs use gauge ratios (active_7d / total) or
// client-derived aggregates (cases / projects) that don't map cleanly
// to the current source descriptor; they keep their curated kpiX
// charts unchanged. A `transform` source kind (numerator/denominator
// ratios) lands in a follow-up to widen coverage.
//
// Tabs in this slice:
//   - users        → /admin/users/stats        → by_plan
//   - memberships  → /admin/memberships/stats  → by_role
//   - files        → /admin/files/stats        → by_stage
//
// Tabs deferred (their kpiX defaults remain):
//   - companies / charts  — gauge-ratio extractors (active_30d / total)
//   - cases / projects    — client-derived from items[], no stats endpoint

// `shape` is a hint for the field-picker + the default chart kind:
//   kv     → categorical breakdown (donut/bar) — a HashMap pointer
//   gauge  → a derived ratio (numerator/total · scale) rendered as a
//            gauge. Carries a `transform` the renderChart resolver
//            applies (see charts/render.js applyTransform). Unlocks the
//            companies/charts tabs whose stats expose numerator + total
//            but no pre-computed percentage.
export const HOME_STATS_SCHEMA = {
  users: {
    endpoint: "/admin/users/stats",
    supportsWindow: false,
    fields: [
      { path: "by_plan", label: "By plan", shape: "kv" },
      { path: "active_7d", label: "Active last 7d", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
    ],
  },
  memberships: {
    endpoint: "/admin/memberships/stats",
    supportsWindow: false,
    fields: [
      { path: "by_role", label: "By role", shape: "kv" },
    ],
  },
  files: {
    endpoint: "/admin/files/stats",
    supportsWindow: false,
    fields: [
      { path: "by_stage", label: "By stage", shape: "kv" },
      { path: "avg_cleanness", label: "Avg cleanness", shape: "gauge" },
    ],
  },
  // Gauge-ratio tabs (Em backlog — the deferred Home tabs). Their stats
  // endpoints expose a numerator + total but no kv breakdown, so they
  // only carry gauge fields. The picker can build these via the
  // transform once builder-ui grows ratio support; today they ship as
  // defaults below.
  companies: {
    endpoint: "/admin/companies/stats",
    supportsWindow: false,
    fields: [
      { path: "active_30d", label: "Active last 30d", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
      { path: "with_projects", label: "With projects", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
    ],
  },
  charts: {
    endpoint: "/admin/charts/stats",
    supportsWindow: false,
    fields: [
      { path: "last_7d", label: "New last 7d", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
      { path: "used_in_reports", label: "Used in reports", shape: "gauge",
        transform: { kind: "ratio", denominator: "total", scale: 100 } },
    ],
  },
};

// Mirror of monitoring-bank's newChartTemplate — empty starter cfg
// for the "+ Add chart" modal in Settings, hardcoded to the Home
// schema so the picker stays decoupled from page-specific knowledge.
export function newChartTemplate(tabKey) {
  const schema = HOME_STATS_SCHEMA[tabKey];
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

export const HOME_DEFAULT_CHARTS = {
  users: [
    {
      id:    "default-by-plan",
      title: "By plan",
      cfg:   { kind: "pie", type: "donut", theme: "redpash-mocha",
               legend: true, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/users/stats",
               pointer:  "by_plan" },
    },
  ],
  memberships: [
    {
      id:    "default-by-role",
      title: "By role",
      cfg:   { kind: "pie", type: "rose", theme: "redpash-mocha",
               legend: true, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/memberships/stats",
               pointer:  "by_role" },
    },
  ],
  files: [
    {
      id:    "default-by-stage",
      title: "By stage",
      cfg:   { kind: "pie", type: "donut", theme: "redpash-mocha",
               legend: true, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/files/stats",
               pointer:  "by_stage" },
    },
  ],
  // Gauge-ratio defaults (transform source) — mirror the existing kpiX
  // gauges on these Home tabs, now in the unified renderChart vocabulary.
  companies: [
    {
      id:    "default-active-30d",
      title: "Active last 30d",
      cfg:   { kind: "gauge", type: "gauge", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/companies/stats",
               pointer:  "active_30d",
               transform: { kind: "ratio", denominator: "total", scale: 100 } },
    },
    {
      id:    "default-with-projects",
      title: "With projects",
      cfg:   { kind: "gauge", type: "gauge", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/companies/stats",
               pointer:  "with_projects",
               transform: { kind: "ratio", denominator: "total", scale: 100 } },
    },
  ],
  charts: [
    {
      id:    "default-new-7d",
      title: "New last 7d",
      cfg:   { kind: "gauge", type: "gauge", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/charts/stats",
               pointer:  "last_7d",
               transform: { kind: "ratio", denominator: "total", scale: 100 } },
    },
    {
      id:    "default-used-in-reports",
      title: "Used in reports",
      cfg:   { kind: "gauge", type: "gauge", theme: "redpash-mocha",
               legend: false, legendPos: "bottom", tooltip: true,
               splitLines: true, axisLine: true, smooth: false },
      source:{ kind: "monitoring-stats",
               endpoint: "/admin/charts/stats",
               pointer:  "used_in_reports",
               transform: { kind: "ratio", denominator: "total", scale: 100 } },
    },
  ],
};
