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
//   - **Registered** (in PREFS below) — UI prefs with enum validation,
//     defaults, and optional <html> data-attr reflection so CSS can
//     react without any JS read at paint time.
//   - **Unregistered** — anything else the server stores
//     (learned_sentinels, share_sentinels, …). Cached as a transparent
//     passthrough; no validation, no attr reflection; readable via
//     getPref(name) directly. Adding a new server pref needs zero
//     change here — it appears in the next /api/me boot-seed.
//
// localStorage namespace: `rp-pref-<name>` uniformly. Legacy per-pref
// keys (rp-density, rp-font-size, …) migrate once at module init.

import { api } from "/scripts/api.js";

export const PREFS = {
  theme:          { values: ["light", "dark"],                  default: "dark", attr: "theme"        },
  density:        { values: ["compact", "cozy", "comfortable"], default: "cozy", attr: "density"      },
  fontSize:       { values: ["sm", "md", "lg"],                 default: "md",   attr: "fontSize"     },
  // Per-page rows-per-page — each table surface gets its own pref so
  // the Workspace's working size doesn't pollute the Home/Monitoring
  // browse size (and vice versa). Migration of the old shared
  // `rowsPerPage` key into all three happens once at module load (see
  // SPLIT_LEGACY_KEYS below).
  rowsPerPageWorkspace:  { values: ["10", "25", "50", "100", "250", "500", "1000"], default: "25", attr: null },
  rowsPerPageHome:       { values: ["10", "25", "50", "100", "250", "500", "1000"], default: "25", attr: null },
  rowsPerPageMonitoring: { values: ["10", "25", "50", "100", "250", "500", "1000"], default: "25", attr: null },
  showRowNumbers: { values: ["1", "0"],                         default: "1",    attr: "showRownum"   },
  showStageDots:  { values: ["1", "0"],                         default: "1",    attr: "showStageDots"},
  // Defaults the cleaner + export flows read. None of them reshape
  // <html>, so no attr; they're consumed by the upload / export
  // handlers when they pick a sensible default.
  csvDelimiter:   { values: ["auto", "comma", "semi", "tab"],   default: "auto", attr: null           },
  csvEncoding:    { values: ["auto", "utf-8", "utf-16le", "utf-16be",
                             "windows-1252", "iso-8859-1", "iso-8859-15",
                             "windows-1250", "macintosh"],      default: "auto", attr: null           },
  exportFormat:   { values: ["csv", "xlsx", "json"],            default: "csv",  attr: null           },
  // Cases page — how far back to show the "Done" column / rail group
  // (productivity-tracking window). Default "day" caps to today's
  // closed cases; "all" disables the filter. Live-toggleable from the
  // chip-row at the top of the Done column.
  casesDoneWindow: { values: ["day", "week", "month", "all"],   default: "day",  attr: null },
  // Cases page — which axis the left rail groups by. "status" is the
  // default kanban-mirrored grouping; "assignee" surfaces the "what
  // is each agent / user working on" view named in
  // `docs/internal/jira-flow-proposition/proposition.md` as a phase
  // 2-3 migration requirement. Live-toggleable from the rail head.
  casesRailGroupBy: { values: ["status", "assignee"],           default: "status", attr: null },
  // Cases page — whether the case-detail properties side panel is open.
  // Persisted so the collapse/expand choice survives reloads + case
  // switches. Two-state like casesRailGroupBy; cases.js applies it as a
  // class on the panel element (per-surface, not <html>), so attr:null.
  casesDetailPanel: { values: ["open", "closed"],               default: "open",  attr: null },
  // Workspace rail — which object kind each project group lists.
  // "data" shows CSV/Excel data files (the redtable surface); whereas
  // "dashboards" shows reports (chart files) + dashboards (the designer
  // surface). A single rail-head toggle flips every group at once.
  workspaceRailView: { values: ["data", "dashboards"],          default: "data", attr: null },
};

const KEY_PREFIX = "rp-pref-";
const storageKey = (name) => KEY_PREFIX + name;

// ── legacy-key migration ─────────────────────────────────────────────
// One-shot at module-load time. Moves old per-pref keys (rp-density,
// rp-font-size, rp-rows-per-page, rp-show-rownum, rp-show-stage-dots)
// into the unified rp-pref-<name> namespace. Values get JSON-encoded
// so the new namespace is type-safe. Old keys are removed once moved
// so a re-import doesn't pay the migration cost.
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

/** Read a pref. Registered prefs validate against the enum + fall back
 *  to the registered default when the cache is empty / malformed. Un-
 *  registered prefs JSON-parse the cached value and return as-is, or
 *  `null` when nothing's cached. Returns the default (registered) or
 *  null (unregistered) when storage is unavailable. */
export function getPref(name) {
  const spec = PREFS[name];
  let raw;
  try { raw = localStorage.getItem(storageKey(name)); }
  catch { return spec ? spec.default : null; }
  if (raw == null) return spec ? spec.default : null;
  // JSON-parse uniformly. Old legacy migrations and seedPrefs both
  // JSON.stringify on write, so the cache is always JSON.
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  if (spec) {
    // Registered: must be in the enum's value list, else fall back.
    return spec.values.includes(parsed) ? parsed : spec.default;
  }
  return parsed;
}

/** Write a pref. Registered prefs validate against the enum; un-
 *  registered prefs accept any JSON-encodable value. Always writes to
 *  localStorage, reflects to <html> data-attr if the pref declares
 *  one, and fires a fire-and-forget PATCH /api/me/prefs so the server
 *  catches up. Returns true on success, false on enum-validation
 *  failure (registered only). */
export function setPref(name, value) {
  const spec = PREFS[name];
  if (spec && !spec.values.includes(value)) return false;
  try { localStorage.setItem(storageKey(name), JSON.stringify(value)); }
  catch { /* private mode — non-fatal; the server PATCH below still goes */ }
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
  for (const [name, spec] of Object.entries(PREFS)) {
    if (!spec.attr) continue;
    document.documentElement.dataset[spec.attr] = getPref(name);
  }
}
