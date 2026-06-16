/* apps.js — THE app/page registry. The router, the topbar nav, and the
   launcher all read this one structure (the predecessor kept a second ROUTES
   table in main.js — folded here, one source).

   An app = an RBAC boundary + a focused nav. A page entry maps to
   /apps/<app>/<page>/<page>.{html,js} by convention. `built` flags what
   exists — an unbuilt page is hidden, never a stub route (no placeholder
   affordances). App visibility is POLICY-aware: `app.<id>.enabled` from the
   behavior registry overrides the static flags (the Admin Console's
   app-visibility matrix writes those policies). */

import { getPref } from "../registry/pref-registry.js";

export const APPS = [
  {
    id: "auth",
    name: "Sign in",
    hidden: true,
    pages: [{ id: "login", label: "Sign in", auth: false, built: true }],
  },
  {
    id: "studio",
    name: "Studio",
    icon: "bi-easel", // app glyph for the launcher (the data studio)
    landing: "#/workspace",
    pages: [
      // id stays `workspace` (route / file path / deep-links); the visible
      // label is its real name — the data cleaner (clean a CSV in a few clicks).
      { id: "workspace", label: "Data Cleaner", icon: "bi-stars", built: true },
      { id: "designer", label: "Designer", icon: "bi-grid-1x2", built: true },
      // sheetwise — later slice
    ],
  },
  {
    id: "admin",
    name: "Admin",
    icon: "bi-shield-lock", // app glyph for the launcher (placeholder — swap freely)
    admin: true,
    landing: "#/org",
    pages: [
      { id: "org", label: "Organization", icon: "bi-diagram-3", built: true },
      { id: "console", label: "Console", icon: "bi-sliders2", built: true },
      { id: "registry", label: "Data Registry", icon: "bi-database", built: true },
      { id: "cases", label: "Cases", icon: "bi-kanban", built: true },
    ],
  },
  {
    id: "settings",
    name: "Settings",
    hidden: true,
    pages: [{ id: "settings", label: "Settings", built: true }],
  },
];

/** Pages flattened with their owning app. */
export function allPages() {
  return APPS.flatMap((app) => app.pages.map((p) => ({ ...p, app })));
}

export function pageById(id) {
  return allPages().find((p) => p.id === id) ?? null;
}

/** The launcher's view: apps the session may see — static admin flag AND the
    resolved `app.<id>.enabled` policy AND ≥1 built page. */
export function appsFor(session) {
  return APPS.filter((app) => {
    if (app.hidden) return false;
    if (app.admin && !session?.is_platform_admin) return false;
    const policy = getPref(`app.${app.id}.enabled`);
    if (policy === false) return false;
    return app.pages.some((p) => p.built);
  });
}

/** Where a session lands (there's no Home page): its first visible app —
    Studio for most, Admin for an admin-only account — else Settings, which
    everyone can always reach. Used by the router + the brand fallback. */
export function landingFor(session) {
  const [first] = appsFor(session);
  if (first?.landing) return first.landing;
  const page = first?.pages.find((p) => p.built);
  return page ? `#/${page.id}` : "#/settings";
}
