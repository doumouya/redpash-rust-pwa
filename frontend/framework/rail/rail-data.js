/* rail-data — the controller behind the GLOBAL, SERVER-DRIVEN rail. The rail's
   CONTENT comes from `GET /api/rail/<view>`: the backend resolves the page's
   reach-filtered objects (projects→files, object types, …) into a groups→tabs
   tree. This module fetches + caches that tree, renders it via the rail
   component, supplies the constant footer (the RBAC-agnostic universals —
   theme · settings · sign-out · profile), and dispatches a tab click by its
   `kind` (a page may override the dispatch via onRailTab).

   A page therefore declares almost nothing — page-assembly passes `view =
   activePageId`; the page optionally supplies an Overview pseudo-tab, an
   onRailTab override (e.g. open a file in-place, switch a type), and the active
   id. New object pages get their rail for free from the backend descriptor. */

import { api } from "../boot/api.js";
import { getPref, setPref } from "../registry/pref-registry.js";
import { mountRail } from "./rail.js";

// SWR cache of the rail tree per view — re-mounts on navigation don't refetch.
const railCache = new Map(); // view -> Promise<{ groups }>

/** Clear the cached rail tree(s) — call after a create/rename/delete so the
    next mount re-pulls. No arg clears every view. */
export function invalidateRail(view) {
  if (view) railCache.delete(view);
  else railCache.clear();
}
// Back-compat alias for existing callers (workspace upload/join).
export const invalidateRailData = () => invalidateRail();

function fetchRail(view) {
  if (!railCache.has(view)) {
    railCache.set(
      view,
      api.get(`/rail/${view}`).then(
        (d) => d ?? { groups: [] },
        (e) => {
          railCache.delete(view); // a failed fetch must not poison the cache
          throw e;
        }
      )
    );
  }
  return railCache.get(view);
}

function initialsOf(session) {
  const name = (session?.display_name || session?.username || "").trim();
  if (!name) return "··";
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

/* The constant footer every rail shows. The universals render from here; their
   ACTIONS are footerHandlers (wired into the rail's `on`). */
export function universalFooter(create, session) {
  return {
    create: create ?? null,
    universals: {
      themeLabel: getPref("theme") === "new-light" ? "Light" : "Dark",
      profileInitials: initialsOf(session),
    },
  };
}

/* The universal footer actions — RBAC-agnostic, identical on every page.
   Profile routes to Settings for now (the account/prefs surface) — never a
   dead control. */
export const footerHandlers = {
  theme: () => setPref("theme", getPref("theme") === "new-light" ? "new-dark" : "new-light"),
  settings: () => {
    location.hash = "#/settings";
  },
  profile: () => {
    location.hash = "#/settings";
  },
  signOut: async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      await clearClientStorage();
      location.hash = "#/login";
      location.reload();
    }
  },
};

/* Shared-device privacy (privacy finding F-K): on sign-out, wipe ALL on-device
   state so the next person to log in on this browser can't reach the prior
   user's data. Safe to clear: prefs are server-authoritative and re-hydrate on
   the next login; the IndexedDB stores are the per-user GlueSQL customer-data
   namespaces (dormant today — usually a no-op — but wired-safe for when the
   on-device engine goes live). Best-effort throughout; never blocks logout. */
async function clearClientStorage() {
  try { localStorage.clear(); } catch { /* storage may be unavailable */ }
  try { sessionStorage.clear(); } catch { /* storage may be unavailable */ }
  try {
    if (typeof indexedDB !== "undefined" && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs
          .filter((d) => d && d.name)
          .map(
            (d) =>
              new Promise((resolve) => {
                const req = indexedDB.deleteDatabase(d.name);
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
              })
          )
      );
    }
  } catch { /* enumeration unsupported on this browser — best-effort */ }
}

/* Default tab dispatch by `kind` when the page provides no onRailTab override.
   A file opens in the Workspace; type/instance/section tabs are page-specific
   (the page supplies onRailTab) so there's no generic default for them. */
function defaultRailTab(tab) {
  if (tab?.kind === "file") location.hash = `#/workspace?file=${tab.id}`;
}

/* ── per-user rail UI state (plain settings keys, NOT preference-type fields) ──
   `rail.collapsed` (bool) and `rail.hidden` ([rid]) are UI state, persisted to
   the user scope via setPref so they follow the account across devices. The
   settings store is jsonb so the bool/array round-trip cleanly; we still coerce
   defensively in case a value arrives as a JSON string. */
const COLLAPSED_KEY = "rail.collapsed";
const HIDDEN_KEY = "rail.hidden";

function readHidden() {
  const v = getPref(HIDDEN_KEY);
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/* Stable per-group accent for the initials mark. The hash is deterministic so a
   project keeps its colour across reloads; the palette reads on both themes. */
const MARK_PALETTE = ["#6366f1", "#0ea5e9", "#f59e0b", "#ec4899", "#10b981", "#8b5cf6"];
function markFor(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return MARK_PALETTE[Math.abs(h) % MARK_PALETTE.length];
}

/* Mount the global rail. Content is fetched from /api/rail/<spec.view>; the page
   supplies only { view, overview?, onRailTab?, active?, search? }. The global
   rail footer is UNIVERSALS-ONLY by design: create/add actions live in the
   toolbar "+" (the app-wide create affordance — every object-list opens its
   create there), NEVER the rail footer. tools/rail-create-audit enforces this,
   so don't reintroduce a footer create here. The
   controller layers the LOCAL view state the server tree doesn't carry: the
   per-user hide set + restore drawer, a client-side name filter, the initials
   marks, and collapse-persist. Server-flagged `renamable`/`hidable` nodes
   (projects + files) get inline rename → PATCH and per-row hide. */
export function mountAppRail(host, spec, session) {
  let tree = { groups: [] };
  let query = "";

  const findTab = (id, groupId) => {
    const groups = tree.groups || [];
    const inGroup = groups.find((g) => g.id === groupId);
    return (
      (inGroup?.tabs || []).find((t) => t.id === id) ??
      groups.flatMap((g) => g.tabs || []).find((t) => t.id === id) ??
      null
    );
  };

  // Re-derive the rendered tree from the server tree + hide set + filter, then
  // hand it to the component. Called on load and after any local-state change.
  const render = () => {
    const hidden = new Set(readHidden());
    const q = query.toLowerCase();
    const visible = [];
    const hiddenGroups = [];
    const hiddenTabs = [];

    for (const g of tree.groups || []) {
      if (hidden.has(g.id)) {
        hiddenGroups.push({ id: g.id, kind: "group", name: g.name });
        continue;
      }
      const kept = (g.tabs || []).filter((t) => {
        if (hidden.has(t.id)) {
          hiddenTabs.push({ id: t.id, kind: "tab", name: t.name, meta: g.name });
          return false;
        }
        return true;
      });
      // Filter: a group matches by its own name (keeps all its tabs) or by any
      // tab name (keeps the matching tabs); a group that matches neither drops.
      const gMatch = !q || (g.name || "").toLowerCase().includes(q);
      const tabs = gMatch ? kept : kept.filter((t) => (t.name || "").toLowerCase().includes(q));
      if (q && !gMatch && !tabs.length) continue;
      visible.push({
        ...g,
        mark: g.renamable ? markFor(g.id) : g.mark,
        tabs: tabs.map((t) => (t.dot ? { ...t, dot: "is-" + t.dot } : t)),
      });
    }

    const sections = [];
    if (hiddenGroups.length) sections.push({ title: "Hidden projects", items: hiddenGroups });
    if (hiddenTabs.length) sections.push({ title: "Hidden files", items: hiddenTabs });
    const empty = q ? `No matches for “${query}”.` : "Nothing here yet.";
    handle.setGroups(visible, sections.length ? sections : null, empty);
    if (spec.active) handle.setActive(spec.active);
  };

  const hide = (id) => {
    const h = readHidden();
    if (!h.includes(id)) setPref(HIDDEN_KEY, [...h, id]);
    render();
  };
  const restore = (id) => {
    setPref(HIDDEN_KEY, readHidden().filter((x) => x !== id));
    render();
  };

  // Inline rename: paint the new name optimistically (cache-then-correct), then
  // PATCH. The view's rail cache is invalidated so the next mount re-pulls;
  // a failed write reloads to revert to the server truth.
  const rename = async (kind, id, value) => {
    let target = null;
    if (kind === "project") target = (tree.groups || []).find((g) => g.id === id);
    else target = findTab(id);
    if (target) target.name = value;
    render();
    const path = kind === "project" ? `/projects/${id}` : `/files/${id}`;
    const body = kind === "project" ? { name: value } : { filename: value };
    try {
      await api.patch(path, body);
      invalidateRail(spec.view);
    } catch {
      reload();
    }
  };

  const handle = mountRail(host, {
    collapsed: getPref(COLLAPSED_KEY) === true,
    overview: spec.overview
      ? { label: spec.overview.label, icon: spec.overview.icon, active: spec.overview.active }
      : undefined,
    // A client-side name filter over the loaded tree, on by default; a page can
    // pass `search: false` to suppress it or its own `{ placeholder, onInput }`.
    // The inline type-ahead + ↑↓ match cycling is owned by the rail component
    // (it reads the rendered tree); the controller just narrows on onInput.
    search:
      spec.search === false
        ? undefined
        : spec.search ?? {
            placeholder: "Filter…",
            onInput: (q) => {
              query = q;
              render();
            },
          },
    footer: universalFooter(null, session),
    groups: [],
    on: {
      ...footerHandlers,
      tab: (id, groupId) => {
        const tab = findTab(id, groupId) ?? { id, kind: undefined };
        if (spec.onRailTab) spec.onRailTab(tab);
        else defaultRailTab(tab);
      },
      overview: spec.overview?.onSelect,
      collapseToggle: (isCompact) => setPref(COLLAPSED_KEY, isCompact),
      groupRename: (id, val) => rename("project", id, val),
      tabRename: (id, val) => rename("file", id, val),
      groupHide: (id) => hide(id),
      tabHide: (id) => hide(id),
      restore: (id) => restore(id),
    },
  });

  function reload() {
    invalidateRail(spec.view);
    fetchRail(spec.view).then(
      (t) => {
        tree = t || { groups: [] };
        render();
      },
      () => handle.setGroups([], null, "Couldn't load the rail.")
    );
  }

  fetchRail(spec.view).then(
    (t) => {
      tree = t || { groups: [] };
      render();
    },
    () => handle.setGroups([], null, "Couldn't load the rail.")
  );

  // Re-pull the rail tree IN PLACE (after a create/delete that adds/removes a
  // node) — repaints the groups without re-mounting the page, so an open file +
  // its unsaved staged work survive. Augments the base mountRail handle.
  handle.refresh = reload;
  return handle;
}
