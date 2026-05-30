/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/theme.md */
// Theme — dark (default) ↔ light.
//
// Thin shim over the unified prefs system (prefs.js). `theme` is a
// registered pref (`PREFS.theme`) so write-through to the server +
// boot seed via /api/me + html data-attr reflection all happen for
// free. This module keeps the read/write/toggle API the rest of the
// codebase imports (settings.js, topbar.js) so the call sites don't
// need to know about the unification.
//
// Persistence path:
//   1. user picks Light in Settings → applyTheme("light")
//   2. setPref("theme", "light") writes localStorage["rp-pref-theme"]
//      = '"light"' (JSON-encoded) + reflects to html.dataset.theme
//      = "light" + fires PATCH /me/prefs so the choice survives
//      browser/device changes
//   3. on reload, index.html's pre-paint reads rp-pref-theme first
//      (JSON-parsed) — no flash of the wrong theme
//   4. /api/me's prefs payload re-seeds the cache via seedPrefs,
//      keeping the local copy in sync with the server
//
// The two palettes live in tokens.css: `:root` is dark,
// `html[data-theme="light"]` overrides it.

import { getPref, setPref } from "/scripts/prefs.js";

export function currentTheme() {
  // Read via the pref helper (validates against the enum, falls back
  // to the registered default). Also matches what index.html's pre-
  // paint applied to html.dataset.theme, so the two never diverge.
  return getPref("theme");
}

export function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  // setPref handles: localStorage write (rp-pref-theme, JSON-encoded),
  // html data-attr reflection (PREFS.theme.attr = "theme"), and the
  // fire-and-forget PATCH /me/prefs write-through. No need for a
  // separate dataset.theme = t — setPref does that via spec.attr.
  setPref("theme", t);
  return t;
}

export function toggleTheme() {
  return applyTheme(currentTheme() === "light" ? "dark" : "light");
}
