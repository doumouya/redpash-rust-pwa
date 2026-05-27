// Home page tab definitions — slice 4 of the god-object decomposition
// campaign (Em 2026-05-27 — broadcast.md 00:53). First slice on home.js
// (1938 LOC); same pattern as the tools.js slices 1-3 (pure data,
// module-private, structural-only extract).
//
// Three exports drive the Home page's rail + redtable surface:
//
//   HOME_TABS — declarative tab definitions. Each entry pairs a tab
//     key (URL hash + LIST_VIEWS lookup) with its rail-rendering
//     metadata (group / label / icon / perm gate / endpoint hint /
//     wired flag). The `perm` field is non-load-bearing today
//     (everyone is admin in pre-prod / solo-dev) — kept so the RBAC
//     switch later is a filter, not a rewrite. `endpoint` is the
//     un-prefixed path (no /api/ prefix) so the crossing-audit
//     doesn't mistake it for a call site; it's display-only for the
//     pending-stub UI when `wired: false`.
//
//   HOME_GROUPS — three rail sections (ORG / DATA / MANAGE) with
//     their two-letter mark + color-token name. Drives the rail's
//     visual grouping; HOME_TABS entries assign themselves to a
//     group via the `group` field.
//
//   HOME_DEFAULT_TAB — the default tab key when no hash query says
//     otherwise. Today: "projects" (the DATA group's first tab).
//
// Module-private to home.js today; promote the exports if another
// page composes the same tab vocabulary (e.g. a future global nav
// surface). Co-owned with the rail-shell pattern documented in
// `docs/internal/architecture/ui-shell-pattern.md`.

export const HOME_TABS = [
  // ── ORG ────────────────────────────────────────────────────
  { group: "ORG",    key: "users",       label: "Users",       icon: "bi-people",       perm: "admin", endpoint: "/admin/users",       wired: true  },
  { group: "ORG",    key: "companies",   label: "Companies",   icon: "bi-building",     perm: "admin", endpoint: "/admin/companies",   wired: true  },
  { group: "ORG",    key: "memberships", label: "Memberships", icon: "bi-link-45deg",   perm: "admin", endpoint: "/admin/memberships", wired: true  },
  // Cases — flat-table read of /api/cases for the rail. The /cases
  // page renders the kanban + detail; this Home tab gives the
  // sortable inventory view alongside Users / Companies / Memberships.
  { group: "ORG",    key: "cases",       label: "Cases",       icon: "bi-card-list",    perm: "user",  endpoint: "/cases",             wired: true  },
  // ── DATA ───────────────────────────────────────────────────
  { group: "DATA",   key: "projects",    label: "Projects",    icon: "bi-folder",       perm: "user",  endpoint: "/projects",          wired: true  },
  { group: "DATA",   key: "files",       label: "Files",       icon: "bi-file-earmark", perm: "user",  endpoint: "/admin/files",       wired: true  },
  { group: "DATA",   key: "charts",      label: "Charts",      icon: "bi-bar-chart",    perm: "user",  endpoint: "/admin/charts",      wired: true  },
  // Steps moved to /monitoring (AUDITS group) — operational audit-
  // trail records of cleaning ops, fits Monitoring's "what happened"
  // framing better than Home's org/data inventory.
  // ── MANAGE — stripped redtable variant ─────────────────────
  // Disabled until the unified org-management endpoint lands. The
  // button telegraphs the future surface (workspace-style filter +
  // read-only table across users / companies / memberships); not
  // clickable yet. Parallel pattern to Monitoring's INSPECT > Logs.
  { group: "MANAGE", key: "org",         label: "Org",         icon: "bi-diagram-3",    perm: "admin", endpoint: "/admin/org",         wired: false },
];

export const HOME_GROUPS = [
  { name: "ORG",    mark: "OR", color: "mauve" },
  { name: "DATA",   mark: "DA", color: "teal"  },
  { name: "MANAGE", mark: "MG", color: "peach" },
];

export const HOME_DEFAULT_TAB = "projects";
