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

export const HOME_STATS_SCHEMA = {
  users: {
    endpoint: "/admin/users/stats",
    supportsWindow: false,
    fields: [
      { path: "by_plan", label: "By plan", shape: "kv" },
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
};
