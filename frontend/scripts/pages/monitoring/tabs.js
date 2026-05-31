/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/monitoring/tabs.md */
// Monitoring page tab definitions — slice 5 of the god-object
// decomposition (Em 2026-05-27 — broadcast.md 00:53). Mirror of
// slice 4's pages/home/tabs.js extract; same module-private
// data-only pattern.
//
// Five exports drive Monitoring's rail + window-selector + redtable:
//
//   MON_TABS — tab inventory across four rail groups (REQUESTS /
//     AUDITS / OPTIMIZATION / USERS). Same shape as HOME_TABS:
//     group / key / label / icon / endpoint / wired.
//     The `endpoint` field's no-/api/-prefix convention keeps the
//     crossing audit from flagging it as a call site (the route
//     literal is only spliced into the call site via
//     `/api/${endpoint}` in the fetch path).
//
//   MON_GROUPS — four rail sections with their two-letter mark +
//     color token. Drives the rail's visual grouping.
//
//   WINDOWS — the four time-window options for windowed views
//     ("1h" / "24h" / "7d" / "30d"). Consumed by the requests +
//     events panels.
//
//   MON_DEFAULT_TAB — boot fallback ("requests").
//   DEFAULT_WINDOW — boot fallback ("24h").
//
// Module-private to monitoring.js today; promote if another page
// composes the same vocabulary.

export const MON_TABS = [
  // ── REQUESTS ───────────────────────────────────────────────
  { group: "REQUESTS", key: "requests", label: "Requests", icon: "bi-globe2",         endpoint: "/monitoring/requests",    wired: true },
  { group: "REQUESTS", key: "events",   label: "Events",   icon: "bi-envelope",       endpoint: "/monitoring/events",      wired: true },
  // DB-layer perf — per-query capture (db_query_log), sibling of Requests.
  { group: "REQUESTS", key: "queries",  label: "Queries",  icon: "bi-database",       endpoint: "/monitoring/queries",     wired: true },
  // ── AUDITS ─────────────────────────────────────────────────
  { group: "AUDITS",   key: "runs",     label: "Runs",     icon: "bi-play-circle",          endpoint: "/monitoring/audit-runs",     wired: true },
  { group: "AUDITS",   key: "findings", label: "Findings", icon: "bi-exclamation-triangle", endpoint: "/monitoring/audit-findings", wired: true },
  // ── ADMIN — Org management (Em-locked page-purpose split,
  // 2026-05-31, CAS_274EDF3B). Gated on /api/me.is_platform_admin;
  // the rail renders the group conditionally so non-admins never
  // see the tabs. Each tab's endpoint is /admin/* (already gated
  // server-side; the FE gate is a UX hide, the backend is the real
  // auth per [[no-mystery-css]]-style discipline). Phase A of this
  // group (this commit) wires the scaffold + Steps move + the two
  // new admin-only surfaces (Fields, Audit catalog). Phase B (next
  // commit) moves Users / Companies / Teams / Memberships off Home.
  // RBAC introspection is a custom panel (not a redtable list); it
  // lands in its own commit.
  { group: "ADMIN",    key: "steps",          label: "Cleanings",     icon: "bi-wrench",          endpoint: "/admin/steps",         wired: true },
  { group: "ADMIN",    key: "fields",         label: "Fields",        icon: "bi-grid-3x2-gap",    endpoint: "/admin/fields",        wired: true },
  { group: "ADMIN",    key: "audit_catalog",  label: "Audit catalog", icon: "bi-card-checklist",  endpoint: "/admin/audit-catalog", wired: true },
  // ── OPTIMIZATION — known opportunities × live measurements ─
  // Spec: docs/internal/specs/optimization-map.md. Each row pairs a
  // doc-side optimization point with the metadata to evaluate its
  // current cost; the server returns current_value + tipped on every
  // fetch.
  { group: "OPTIMIZATION", key: "optimization", label: "Map", icon: "bi-wrench-adjustable", endpoint: "/monitoring/optimization-points", wired: true },
  // ── USERS — per-user activity feed (M-2 from slice E) ────
  // "What is this user doing right now?" lens — different from
  // /admin/users (organisational inventory). Combines request_log
  // + events into one time-ordered timeline scoped to a user_rid.
  { group: "USERS",    key: "user_activity", label: "Activity", icon: "bi-person-lines-fill", endpoint: "/monitoring/users",        wired: true },
  // ── CATALOG — reference / taxonomy data surfaced for visibility ─
  // Per epic CAS_9A0CBB3A59FF4F75B0C8BB2444C71261 (surface the
  // remaining DB objects). case_categories is plumbed (table + GET
  // /cases/categories + cases.category_id) but dormant; this tab
  // surfaces the taxonomy read-only. Dedicated renderer (not
  // LIST_VIEWS) — /cases/categories returns a flat `{ items }`, not
  // a paginated Page<T>. The sentinel-admin global pool joins this
  // group once Gus's admin reader lands.
  { group: "CATALOG",  key: "case_categories", label: "Categories", icon: "bi-tags",          endpoint: "/cases/categories",        wired: true },
];

export const MON_GROUPS = [
  { name: "REQUESTS",     mark: "RQ", color: "blue"  },
  { name: "AUDITS",       mark: "AD", color: "peach" },
  // ADMIN — Em-locked page-purpose split (2026-05-31 CAS_274EDF3B).
  // Hosted on Monitoring's rail rather than a standalone /admin page
  // so the platform-admin's surfaces all live in one shell. Whole
  // group gated on /api/me.is_platform_admin (skipped at render time
  // for non-admins; backend /admin/* endpoints are the real auth).
  { name: "ADMIN",        mark: "AM", color: "mauve" },
  { name: "OPTIMIZATION", mark: "OP", color: "green" },
  { name: "USERS",        mark: "US", color: "sky"   },
  { name: "CATALOG",      mark: "CT", color: "teal"  },
];

export const WINDOWS = ["1h", "24h", "7d", "30d"];
export const MON_DEFAULT_TAB = "requests";
export const DEFAULT_WINDOW = "24h";
