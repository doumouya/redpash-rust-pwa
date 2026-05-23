// App-wide preferences — get/set helpers + the canonical PREFS table.
//
// Each pref persists in localStorage and is reflected on <html> as a
// data-<key> attribute so CSS selectors can react without any JS
// reading the value (e.g. html[data-density="compact"] overrides the
// --rp-sp-* tokens). index.html applies the visual-impact prefs
// (density, fontSize) before first paint to avoid a FOUC; this module
// owns the runtime read/write path used by the Settings page and by
// page modules that need a pref value at mount.
//
// Theme stays in theme.js — pre-existing, has its own boot wiring; not
// duplicated here. When a user-prefs backend endpoint lands, the
// localStorage layer becomes an SWR cache and these helpers swap to
// hit /api/users/:rid/prefs underneath; the consumer-facing API
// doesn't change.

export const PREFS = {
  density:        { key: "rp-density",         values: ["compact", "cozy", "comfortable"], default: "cozy", attr: "density"      },
  fontSize:       { key: "rp-font-size",       values: ["sm", "md", "lg"],                 default: "md",   attr: "fontSize"     },
  rowsPerPage:    { key: "rp-rows-per-page",   values: ["10", "25", "50", "100", "all"],   default: "25",   attr: null           },
  showRowNumbers: { key: "rp-show-rownum",     values: ["1", "0"],                         default: "1",    attr: "showRownum"   },
  showStageDots:  { key: "rp-show-stage-dots", values: ["1", "0"],                         default: "1",    attr: "showStageDots"},
};

/** Read a pref. Returns the default when localStorage is empty, the
 *  stored value isn't in the allowed list, or storage is unavailable. */
export function getPref(name) {
  const spec = PREFS[name];
  if (!spec) return null;
  try {
    const v = localStorage.getItem(spec.key);
    return spec.values.includes(v) ? v : spec.default;
  } catch { return spec.default; }
}

/** Write a pref. Persists in localStorage and (if the pref has a
 *  data-attr) reflects it on <html>. Returns true on success. */
export function setPref(name, value) {
  const spec = PREFS[name];
  if (!spec || !spec.values.includes(value)) return false;
  try { localStorage.setItem(spec.key, value); } catch { /* private mode — non-fatal */ }
  if (spec.attr) document.documentElement.dataset[spec.attr] = value;
  return true;
}

/** Apply every CSS-reflected pref to <html>. Called once at module
 *  import time by index.html's boot script to head off the FOUC before
 *  first paint; safe to call again. */
export function applyAllPrefs() {
  for (const [name, spec] of Object.entries(PREFS)) {
    if (!spec.attr) continue;
    document.documentElement.dataset[spec.attr] = getPref(name);
  }
}
