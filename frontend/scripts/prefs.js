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

// ── built-in prefs ─────────────────────────────────────────────────
// Each spec carries the Settings v2 UI fields (group / section /
// control / label / hint / options / tags) so the page renders by
// iterating the registry rather than from a hand-written rows tree.
// Step 1 (5629395) added the registry; step 2 (this commit) adds the
// UI fields + flips settings.js to iterate. Behavior preserved
// exactly — the visible Settings page output is byte-identical.
const ROWS_PER_PAGE_VALUES = ["10", "25", "50", "100", "250", "500", "1000"];
const ROWS_PER_PAGE_OPTIONS = [
  { value: "10",   label: "10"  },
  { value: "25",   label: "25"  },
  { value: "50",   label: "50"  },
  { value: "100",  label: "100" },
  { value: "250",  label: "250" },
  { value: "500",  label: "500" },
  { value: "1000", label: "1k"  },
];
const ON_OFF_OPTIONS = [
  { value: "1", label: "On"  },
  { value: "0", label: "Off" },
];

// GENERAL · Appearance — Settings v2 step 6a (CAS_55984AC7):
// migrated from camelCase legacy keys to `<page>-<leaf>` shape per
// Em's lock (CAS_3FC70F56). `migrateFrom` covers the dual-read
// window so old localStorage values carry forward until the user
// next touches the pref (which writes the new key + clears the
// legacy alias). attr names stay the same so <html data-*>
// reflection (and CSS) is unchanged.
registerPref({
  key: "general-theme", group: "GENERAL", section: "set-appearance",
  control: "onoff", label: "Theme",
  values: ["light", "dark"], default: "dark", attr: "theme",
  options: [
    { value: "dark",  label: "Dark",  icon: "moon-stars" },
    { value: "light", label: "Light", icon: "sun" },
  ],
  tags: ["appearance"],
  migrateFrom: ["theme"],
});
registerPref({
  key: "general-density", group: "GENERAL", section: "set-appearance",
  control: "onoff", label: "Density",
  values: ["compact", "cozy", "comfortable"], default: "cozy", attr: "density",
  options: [
    { value: "compact",     label: "Compact" },
    { value: "cozy",        label: "Cozy" },
    { value: "comfortable", label: "Comfortable" },
  ],
  tags: ["appearance"],
  migrateFrom: ["density"],
});
registerPref({
  key: "general-fontSize", group: "GENERAL", section: "set-appearance",
  control: "onoff", label: "Font size",
  values: ["sm", "md", "lg"], default: "md", attr: "fontSize",
  options: [
    { value: "sm", label: "Small" },
    { value: "md", label: "Medium" },
    { value: "lg", label: "Large" },
  ],
  tags: ["appearance"],
  migrateFrom: ["fontSize"],
});

// WORKSPACE · Tables — split per surface so the Workspace's tight
// editing size doesn't pollute Home/Monitoring browse sizes (or
// vice versa). Step 6a (CAS_55984AC7) migrates the legacy
// `rowsPerPage<Surface>` keys to the `<page>-rowsPerPage` shape
// per the namespace lock; dual-read carries existing values
// forward until the user next touches each pref.
registerPref({
  key: "workspace-rowsPerPage", group: "WORKSPACE", section: "set-tables",
  control: "onoff", label: "Rows per page · Workspace",
  values: ROWS_PER_PAGE_VALUES, default: "25", attr: null,
  options: ROWS_PER_PAGE_OPTIONS,
  tags: ["tables", "defaults"],
  migrateFrom: ["rowsPerPageWorkspace"],
});
registerPref({
  key: "home-rowsPerPage", group: "WORKSPACE", section: "set-tables",
  control: "onoff", label: "Rows per page · Home",
  values: ROWS_PER_PAGE_VALUES, default: "25", attr: null,
  options: ROWS_PER_PAGE_OPTIONS,
  tags: ["tables", "defaults"],
  migrateFrom: ["rowsPerPageHome"],
});
registerPref({
  key: "monitoring-rowsPerPage", group: "WORKSPACE", section: "set-tables",
  control: "onoff", label: "Rows per page · Monitoring",
  values: ROWS_PER_PAGE_VALUES, default: "25", attr: null,
  options: ROWS_PER_PAGE_OPTIONS,
  tags: ["tables", "defaults"],
  migrateFrom: ["rowsPerPageMonitoring"],
});

// WORKSPACE · Workspace
registerPref({
  key: "workspace-showRowNumbers", group: "WORKSPACE", section: "set-workspace",
  control: "onoff", label: "Show row numbers",
  values: ["1", "0"], default: "1", attr: "showRownum",
  options: ON_OFF_OPTIONS,
  tags: ["appearance"],
  migrateFrom: ["showRowNumbers"],
});
registerPref({
  key: "workspace-showStageDots", group: "WORKSPACE", section: "set-workspace",
  control: "onoff", label: "Stage dots in rail",
  values: ["1", "0"], default: "1", attr: "showStageDots",
  options: ON_OFF_OPTIONS,
  tags: ["appearance"],
  migrateFrom: ["showStageDots"],
});
// New candidate pref (Phase 1 inventory) — gates the
// rail-view auto-toggle in workspace.js loadFile() so opening a
// CHT_/dashboard file while the rail is on Data (or vice versa)
// auto-flips to the matching kind. On by default; off restores
// pre-step-6 behavior (manual rail toggle).
registerPref({
  key: "workspace-railViewAutoFollow", group: "WORKSPACE", section: "set-workspace",
  control: "onoff", label: "Auto-switch rail view to opened file",
  hint:  "flips Data ↔ Dashboards to match the file kind",
  values: ["1", "0"], default: "1", attr: null,
  options: ON_OFF_OPTIONS,
  tags: ["defaults"],
});

// WORKSPACE · Data & Export — none reshape <html>, so no attr;
// consumed by upload / export handlers when they pick a sensible
// default.
registerPref({
  key: "workspace-csvDelimiter", group: "WORKSPACE", section: "set-data",
  control: "onoff", label: "CSV delimiter", hint: "applied when opening files",
  values: ["auto", "comma", "semi", "tab"], default: "auto", attr: null,
  options: [
    { value: "auto",  label: "Auto" },
    { value: "comma", label: ",", title: "Comma" },
    { value: "semi",  label: ";", title: "Semicolon" },
    { value: "tab",   label: "↹", title: "Tab" },
  ],
  tags: ["data", "defaults"],
  migrateFrom: ["csvDelimiter"],
});
registerPref({
  key: "workspace-csvEncoding", group: "WORKSPACE", section: "set-data",
  control: "onoff", label: "Default encoding", hint: "fallback when RedPash can't detect",
  values: ["auto", "utf-8", "utf-16le", "utf-16be",
           "windows-1252", "iso-8859-1", "iso-8859-15",
           "windows-1250", "macintosh"],
  default: "auto", attr: null,
  options: [
    { value: "auto",         label: "Auto",       title: "Auto-detect (chardetng)" },
    { value: "utf-8",        label: "UTF-8" },
    { value: "utf-16le",     label: "UTF-16 LE" },
    { value: "utf-16be",     label: "UTF-16 BE" },
    { value: "windows-1252", label: "Win-1252" },
    { value: "iso-8859-1",   label: "Latin-1" },
    { value: "iso-8859-15",  label: "Latin-9" },
    { value: "windows-1250", label: "Win-1250" },
    { value: "macintosh",    label: "MacRoman" },
  ],
  tags: ["data", "defaults"],
  migrateFrom: ["csvEncoding"],
});
registerPref({
  key: "workspace-exportFormat", group: "WORKSPACE", section: "set-data",
  control: "onoff", label: "Export format", hint: "default for downloading cleaned data",
  values: ["csv", "xlsx", "json"], default: "csv", attr: null,
  options: [
    { value: "csv",  label: "CSV",   icon: "filetype-csv"  },
    { value: "xlsx", label: "Excel", icon: "filetype-xlsx" },
    { value: "json", label: "JSON",  icon: "filetype-json" },
  ],
  tags: ["data", "defaults"],
  migrateFrom: ["exportFormat"],
});

// CASES — how far back to show the "Done" column / rail group
// (productivity-tracking window). Default "day" caps to today's
// closed cases; "all" disables the filter. Live-toggleable from
// the chip-row at the top of the Done column. Not surfaced in
// Settings today (the Cases group ships empty in step 2; populated
// in step 6 with the candidates from Phase 1 + these three
// existing registered specs).
registerPref({
  key: "casesDoneWindow",
  control: "onoff",  // Settings v2 may surface; today the live chip drives.
  values: ["day", "week", "month", "all"], default: "day", attr: null,
});
registerPref({
  key: "casesRailGroupBy",
  control: "onoff",
  values: ["status", "assignee"], default: "status", attr: null,
});
registerPref({
  key: "casesDetailPanel",
  control: "onoff",
  values: ["open", "closed"], default: "open", attr: null,
});
// Workspace rail — which object kind each project group lists.
// "data" shows CSV/Excel data files (the redtable surface);
// "dashboards" shows reports (chart files) + dashboards (the
// designer surface). A single rail-head toggle flips every group
// at once; not currently surfaced in Settings (the toggle is the
// rail itself).
registerPref({
  key: "workspace-railView",
  control: "onoff",
  values: ["data", "dashboards"], default: "data", attr: null,
  migrateFrom: ["workspaceRailView"],
});

// GENERAL — Hidden Items auto-purge cross-cutting pref. The Hidden
// Items tab (step 5) reads / writes this. Today its only effect is
// the toggle's persisted state; the actual age-based purge needs a
// per-entry timestamp on the hide-write side (rail-controls.js +
// home-hide-actions etc.) which lands as a follow-up. Registered now
// so the toggle row renders in Settings + the pref is wire-ready.
registerPref({
  key: "general-hiddenAutoPurge",
  group: "GENERAL", section: "set-hidden",
  control: "onoff", label: "Auto-purge after 30 days",
  hint:  "drop hidden entries older than 30 days. Today: persisted toggle only; the per-entry timestamp lands as a follow-up.",
  values: ["1", "0"], default: "0", attr: null,
  options: [
    { value: "1", label: "On"  },
    { value: "0", label: "Off" },
  ],
  tags: ["recovery"],
});

// MONITORING / HOME — per-tab chart layouts (Slice D / D2). The
// `chart-layouts` control renderer lives in
// prefs/controls/chart-layouts.js (step 4 of Settings v2 — moved
// out of settings.js, registered here so settings.js iterates these
// like any other pref). No enum / no default — the pref value is a
// JSON object (per-tab arrays of chart specs); the picker manages
// shape internally.
registerPref({
  key: "monitoringCharts",
  group: "MONITORING", section: "set-monitoring-charts",
  control: "chart-layouts", surface: "monitoring",
  label: "Per-tab chart layouts",
  hint:  "your saved charts replace the curated defaults on each Monitoring tab. Build via the chart designer.",
  default: {},
  tags: ["charts"],
});
registerPref({
  key: "homeCharts",
  group: "HOME", section: "set-home-charts",
  control: "chart-layouts", surface: "home",
  label: "Per-tab chart layouts",
  hint:  "your saved charts replace the curated defaults on each Home tab. Build via the chart designer.",
  default: {},
  tags: ["charts"],
});

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
