/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/prefs.md */
// App-wide preferences — SWR cache over the server `user_preferences`
// table, with getPref/setPref helpers above it.
//
// Source of truth is the server (`user_preferences`, migration 023).
// localStorage holds a per-key cache so synchronous getPref doesn't
// block on the network; the cache is seeded once at boot from /api/me
// (`seedPrefs(serverPrefs)`) and written through to the server on
// every setPref via PATCH /api/me/prefs.
//
// Architecture: docs/internal/spec-user-preferences.md.
//
// **Two pref classes:**
//   - **Registered** (via `registerPref(spec)` below) — UI prefs with
//     enum validation, defaults, and optional <html> data-attr
//     reflection so CSS can react without any JS read at paint time.
//     Settings v2 also reads optional UI-shape fields (group, section,
//     control, label, hint, tags) off the spec so the page can render
//     itself by iterating the registry instead of from a hand-written
//     SETTINGS_ROWS tree.
//   - **Unregistered** — anything else the server stores
//     (learned_sentinels, share_sentinels, …). Cached as a transparent
//     passthrough; no validation, no attr reflection; readable via
//     getPref(name) directly. Adding a new server pref needs zero
//     change here — it appears in the next /api/me boot-seed.
//
// localStorage namespace: `rp-pref-<name>` uniformly. Legacy per-pref
// keys (rp-density, rp-font-size, …) migrate once at module init.

import { api } from "/scripts/api.js";

const KEY_PREFIX = "rp-pref-";
const storageKey = (name) => KEY_PREFIX + name;

// ── registry ────────────────────────────────────────────────────────
// Map<key, spec>. Open-ended per [[data-format-open-ended]]: each
// per-page pref module (frontend/scripts/prefs/*-prefs.js, landing in
// step 6 of the Settings v2 rollout) calls registerPref() at
// import-time. Built-in legacy prefs register below in the bootstrap
// block so the const-of-old becomes the same registry of-new with
// zero semantic change at this step.
const REGISTRY = new Map();

/**
 * Register a pref spec. Idempotent: re-registering an existing key
 * replaces the spec (useful for hot-reload during development).
 *
 * Required fields:
 *   key       — pref identifier; matches the localStorage suffix +
 *               wire-shape key on `/api/me/prefs`.
 *
 * Behavior fields (any subset):
 *   values    — enum allowlist; setPref rejects values not in the list.
 *   default   — fallback when storage is empty / malformed / fails enum.
 *   attr      — name for `<html data-${attr}=value>` reflection so CSS
 *               picks up paint-time without a JS read.
 *   validate  — custom predicate; receives the parsed value, returns
 *               bool. Used for prefs whose shape is too rich for an
 *               enum (e.g. JSON objects).
 *   migrateFrom — array of legacy key names for the dual-read window.
 *               getPref reads the new key first; if empty, reads each
 *               legacy alias in order; first hit wins. setPref to the
 *               new key removes all legacy aliases from localStorage
 *               ("touch to migrate" — lazy, per-user, rollback-safe).
 *
 * UI fields (consumed by Settings v2 — optional today, used by the
 * registry-driven render in a later step):
 *   group     — rail bucket ("GENERAL" | "HOME" | "WORKSPACE" |
 *               "CASES" | "MONITORING").
 *   section   — rail tab id (e.g. "set-workspace").
 *   control   — UI dispatch shape ("onoff" | "segmented" | "chips" |
 *               "chart-layouts" | "mount" | "value" | "actions").
 *   label     — human label shown in Settings.
 *   hint      — inline help copy under the label.
 *   tags      — chip-filter dimensions (e.g. ["defaults", "performance"]).
 *
 * Returns the registered spec.
 */
export function registerPref(spec) {
  if (!spec || typeof spec.key !== "string" || !spec.key) {
    throw new Error("registerPref: spec.key is required");
  }
  REGISTRY.set(spec.key, spec);
  return spec;
}

/** Read a registered spec by key. Used by callers that need to
 *  introspect (e.g. Settings v2 iterating the registry). Returns
 *  undefined for unregistered keys. */
export function getPrefSpec(name) {
  return REGISTRY.get(name);
}

/** Iterate every registered spec. Settings v2 rendering path. */
export function eachPref(fn) {
  REGISTRY.forEach(fn);
}

// ── built-in prefs (registered via registerPref so the legacy
//   const-shape is preserved exactly; behavior here is identical to
//   the pre-Settings-v2 module — just the storage shape changed) ────
registerPref({ key: "theme",          values: ["light", "dark"],                  default: "dark", attr: "theme" });
registerPref({ key: "density",        values: ["compact", "cozy", "comfortable"], default: "cozy", attr: "density" });
registerPref({ key: "fontSize",       values: ["sm", "md", "lg"],                 default: "md",   attr: "fontSize" });
// Per-page rows-per-page — each table surface gets its own pref so
// the Workspace's working size doesn't pollute the Home/Monitoring
// browse size (and vice versa). Migration of the old shared
// `rowsPerPage` key into all three happens once at module load (see
// SPLIT_LEGACY_KEYS below).
const ROWS_PER_PAGE_VALUES = ["10", "25", "50", "100", "250", "500", "1000"];
registerPref({ key: "rowsPerPageWorkspace",  values: ROWS_PER_PAGE_VALUES, default: "25", attr: null });
registerPref({ key: "rowsPerPageHome",       values: ROWS_PER_PAGE_VALUES, default: "25", attr: null });
registerPref({ key: "rowsPerPageMonitoring", values: ROWS_PER_PAGE_VALUES, default: "25", attr: null });
registerPref({ key: "showRowNumbers",        values: ["1", "0"],           default: "1",  attr: "showRownum" });
registerPref({ key: "showStageDots",         values: ["1", "0"],           default: "1",  attr: "showStageDots" });
// Defaults the cleaner + export flows read. None of them reshape
// <html>, so no attr; they're consumed by the upload / export
// handlers when they pick a sensible default.
registerPref({ key: "csvDelimiter", values: ["auto", "comma", "semi", "tab"], default: "auto", attr: null });
registerPref({ key: "csvEncoding",
  values: ["auto", "utf-8", "utf-16le", "utf-16be",
           "windows-1252", "iso-8859-1", "iso-8859-15",
           "windows-1250", "macintosh"],
  default: "auto", attr: null,
});
registerPref({ key: "exportFormat", values: ["csv", "xlsx", "json"], default: "csv", attr: null });
// Cases page — how far back to show the "Done" column / rail group
// (productivity-tracking window). Default "day" caps to today's
// closed cases; "all" disables the filter. Live-toggleable from the
// chip-row at the top of the Done column.
registerPref({ key: "casesDoneWindow",  values: ["day", "week", "month", "all"], default: "day",    attr: null });
// Cases page — which axis the left rail groups by. "status" is the
// default kanban-mirrored grouping; "assignee" surfaces the "what
// is each agent / user working on" view named in
// `docs/internal/jira-flow-proposition/proposition.md` as a phase
// 2-3 migration requirement. Live-toggleable from the rail head.
registerPref({ key: "casesRailGroupBy", values: ["status", "assignee"],         default: "status", attr: null });
// Cases page — whether the case-detail properties side panel is open.
// Persisted so the collapse/expand choice survives reloads + case
// switches. Two-state like casesRailGroupBy; cases.js applies it as a
// class on the panel element (per-surface, not <html>), so attr:null.
registerPref({ key: "casesDetailPanel", values: ["open", "closed"],             default: "open",   attr: null });
// Workspace rail — which object kind each project group lists.
// "data" shows CSV/Excel data files (the redtable surface); whereas
// "dashboards" shows reports (chart files) + dashboards (the designer
// surface). A single rail-head toggle flips every group at once.
registerPref({ key: "workspaceRailView", values: ["data", "dashboards"],        default: "data",   attr: null });

// ── legacy-key migration ─────────────────────────────────────────────
// One-shot at module-load time. Moves old per-pref keys (rp-density,
// rp-font-size, rp-rows-per-page, rp-show-rownum, rp-show-stage-dots)
// into the unified rp-pref-<name> namespace. Values get JSON-encoded
// so the new namespace is type-safe. Old keys are removed once moved
// so a re-import doesn't pay the migration cost.
//
// Separate from the open-registry `migrateFrom` dual-read window — this
// is the rp-* → rp-pref-* localStorage-namespace migration (one-shot,
// pre-dates Settings v2); `migrateFrom` covers the camelCase →
// <page>-<leaf> shape (per-pref, lazy, ships with step 6).
const LEGACY_KEYS = {
  theme:          "rp-theme",
  density:        "rp-density",
  fontSize:       "rp-font-size",
  rowsPerPage:    "rp-rows-per-page",
  showRowNumbers: "rp-show-rownum",
  showStageDots:  "rp-show-stage-dots",
};
try {
  for (const [name, legacyKey] of Object.entries(LEGACY_KEYS)) {
    const v = localStorage.getItem(legacyKey);
    if (v == null) continue;
    if (localStorage.getItem(storageKey(name)) == null) {
      localStorage.setItem(storageKey(name), JSON.stringify(v));
    }
    localStorage.removeItem(legacyKey);
  }
} catch { /* private mode — non-fatal */ }

// ── one-shot split of legacy rowsPerPage → per-surface keys ──────────
// The old single `rowsPerPage` pref governed every table on every page.
// 2026-05-24 split it into three (workspace/home/monitoring); this
// block carries the user's existing choice into all three so they
// don't lose their setting. Runs once: if any new key is already set,
// it's left alone. Old key is removed after the split.
try {
  const legacyRows = localStorage.getItem(storageKey("rowsPerPage"));
  if (legacyRows != null) {
    for (const surface of ["Workspace", "Home", "Monitoring"]) {
      const newKey = storageKey("rowsPerPage" + surface);
      if (localStorage.getItem(newKey) == null) {
        localStorage.setItem(newKey, legacyRows);
      }
    }
    localStorage.removeItem(storageKey("rowsPerPage"));
  }
} catch { /* private mode — non-fatal */ }

// ── read / write API ─────────────────────────────────────────────────

/** Read a pref. Registered prefs validate against the enum (or custom
 *  validate fn) and fall back to the registered default when the cache
 *  is empty / malformed. Unregistered prefs JSON-parse the cached
 *  value and return as-is, or `null` when nothing's cached. Returns
 *  the default (registered) or null (unregistered) when storage is
 *  unavailable.
 *
 *  Dual-read: if the spec has `migrateFrom: [legacy1, ...]`, the new
 *  key is tried first; if empty, each legacy alias is read in order
 *  and the first hit is returned (still subject to validate / enum).
 *  Storage cleanup of the legacy alias happens on the next setPref
 *  ("touch to migrate"), so a user who never touches the pref keeps
 *  reading from legacy until they do — both stays safe + rollback-
 *  cheap during the migration window. */
export function getPref(name) {
  const spec = REGISTRY.get(name);
  let raw;
  try { raw = localStorage.getItem(storageKey(name)); }
  catch { return spec ? spec.default : null; }
  // Dual-read: walk migrateFrom aliases when the new key is empty.
  if (raw == null && spec && Array.isArray(spec.migrateFrom)) {
    for (const legacy of spec.migrateFrom) {
      try {
        const legacyRaw = localStorage.getItem(storageKey(legacy));
        if (legacyRaw != null) { raw = legacyRaw; break; }
      } catch { /* private mode — skip this alias */ }
    }
  }
  if (raw == null) return spec ? spec.default : null;
  // JSON-parse uniformly. Legacy migrations + seedPrefs both
  // JSON.stringify on write, so the cache is always JSON.
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  if (spec) {
    if (typeof spec.validate === "function") {
      return spec.validate(parsed) ? parsed : spec.default;
    }
    if (Array.isArray(spec.values)) {
      return spec.values.includes(parsed) ? parsed : spec.default;
    }
    // Registered without enum or validate — return as-is. Allows
    // structured prefs (e.g. homeCharts: per-tab arrays) without
    // forcing them through an enum.
    return parsed;
  }
  return parsed;
}

/** Write a pref. Registered prefs validate (custom fn or enum); un-
 *  registered prefs accept any JSON-encodable value. Always writes to
 *  localStorage, removes any `migrateFrom` legacy aliases from the
 *  cache (touch-to-migrate), reflects to <html> data-attr if the pref
 *  declares one, and fires a fire-and-forget PATCH /api/me/prefs so
 *  the server catches up. Returns true on success, false on
 *  validation failure (registered only). */
export function setPref(name, value) {
  const spec = REGISTRY.get(name);
  if (spec) {
    if (typeof spec.validate === "function" && !spec.validate(value)) return false;
    if (Array.isArray(spec.values) && !spec.values.includes(value))   return false;
  }
  try { localStorage.setItem(storageKey(name), JSON.stringify(value)); }
  catch { /* private mode — non-fatal; the server PATCH below still goes */ }
  // Touch-to-migrate: any legacy aliases get cleaned out of
  // localStorage once a write lands on the new key. The server-side
  // backfill is a separate workstream (step 7 of the Settings v2
  // rollout — a one-shot SQL migration); localStorage cleanup is
  // per-user, per-touch, so it survives rollback of the SQL step.
  if (spec && Array.isArray(spec.migrateFrom)) {
    for (const legacy of spec.migrateFrom) {
      try { localStorage.removeItem(storageKey(legacy)); } catch { /* */ }
    }
  }
  if (spec?.attr) document.documentElement.dataset[spec.attr] = value;
  // Fire-and-forget; a network failure here doesn't fail the user
  // action — the local cache + reflection already landed. Next boot
  // seedPrefs will resync from whatever the server has.
  api.patch("/me/prefs", { prefs: { [name]: value } })
     .catch((err) => { /* swallow — local already correct */
       if (err && err.status && err.status !== 401) {
         // 401 is "not signed in" — happens during the brief window
         // before login completes; not worth logging. Anything else
         // is unexpected.
         console.warn("[prefs] write-through failed for", name, err);
       }
     });
  return true;
}

/** Seed the cache from the server's `prefs` object. Called once at
 *  app boot after /api/me resolves. Overwrites any locally-cached
 *  values for the keys the server returns; keys not in the server
 *  response stay as they are (cache may carry prefs the server
 *  hasn't seen yet — they'll PATCH next time setPref fires).
 *
 *  After seeding, applies any registered prefs' <html> data-attrs so
 *  CSS picks up the server-of-truth value on first paint. */
export function seedPrefs(serverPrefs) {
  if (!serverPrefs || typeof serverPrefs !== "object") return;
  try {
    for (const [name, value] of Object.entries(serverPrefs)) {
      localStorage.setItem(storageKey(name), JSON.stringify(value));
    }
  } catch { /* private mode — non-fatal */ }
  applyAllPrefs();
}

/** Apply every CSS-reflected pref to <html>. Called once at module
 *  import time by index.html's boot script to head off the FOUC
 *  before first paint; also called by seedPrefs after the server
 *  response lands. Safe to call repeatedly. */
export function applyAllPrefs() {
  REGISTRY.forEach((spec, name) => {
    if (!spec.attr) return;
    document.documentElement.dataset[spec.attr] = getPref(name);
  });
}
