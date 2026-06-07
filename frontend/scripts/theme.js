/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/theme.md */
// Theme — 4 named themes (New Dark default ↔ New Light · Catppuccin
// Mocha ↔ Latte).
//
// Thin shim over the unified prefs system (prefs.js). `general-theme`
// is a registered pref (see prefs.js — kebab key per CAS_55984AC7
// step 6a, with migrateFrom:["theme"] for the dual-read window) so
// write-through to the server + boot seed via /api/me + html
// data-attr reflection all happen for free. This module keeps the
// read/write/toggle API the rest of the codebase imports
// (settings.js, topbar.js) so the call sites don't need to know
// about the underlying key.
//
// Persistence path:
//   1. user picks Light in Settings → applyTheme("light")
//   2. setPref("general-theme", "light") writes
//      localStorage["rp-pref-general-theme"] = '"light"' (JSON-
//      encoded) + reflects to html.dataset.theme = "light" + fires
//      PATCH /me/prefs so the choice survives browser/device changes
//      + clears the legacy rp-pref-theme alias (migrateFrom).
//   3. on reload, index.html's pre-paint reads rp-pref-general-theme
//      first, falls back to rp-pref-theme then rp-theme — no flash
//      of the wrong theme during the migration window.
//   4. /api/me's prefs payload re-seeds the cache via seedPrefs,
//      keeping the local copy in sync with the server.
//
// The palettes live in tokens.css — one block per theme keyed on
// `html[data-theme="<name>"]`; the bare `:root` block is Catppuccin
// Mocha (the universal fallback for when no data-theme is set). The app
// default is New Dark, applied as `html[data-theme="new-dark"]` by the
// pref system (+ index.html's pre-paint) so a fresh session lands on
// the new identity, not the Mocha fallback.

import { getPref, setPref } from "/scripts/prefs.js";

export function currentTheme() {
  // Read via the pref helper (validates against the enum, falls back
  // to the registered default). Also matches what index.html's pre-
  // paint applied to html.dataset.theme, so the two never diverge.
  // CAS_55984AC7 step 6a — kebab key migration; dual-read in prefs.js
  // carries the legacy `theme` localStorage value forward.
  return getPref("general-theme");
}

// The full theme set. new-dark/new-light = the design-language identity
// (new-dark is the app default since 2026-06-07); dark/light + the
// catppuccin-* aliases are the Catppuccin Mocha/Latte palettes. Kept in
// lockstep with the `general-theme` enum in prefs.js + index.html's pre-paint.
const THEMES = ["light", "dark", "new-dark", "new-light", "catppuccin-mocha", "catppuccin-latte"];

export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : "new-dark";
  // setPref handles: localStorage write (rp-pref-general-theme,
  // JSON-encoded), html data-attr reflection (spec.attr = "theme",
  // so html.dataset.theme = t), the fire-and-forget PATCH
  // /me/prefs write-through, and migrateFrom cleanup (removes the
  // legacy rp-pref-theme entry on first write).
  setPref("general-theme", t);
  return t;
}

// Topbar quick-toggle — flip between the dark and light variant of the
// CURRENT theme family, so a New Dark user toggles to New Light (not
// across to the Catppuccin pair). Falls back to the New Dark default for
// any theme not in a known pair.
const TOGGLE_PAIR = {
  "new-dark": "new-light", "new-light": "new-dark",
  "dark": "light",         "light": "dark",
  "catppuccin-mocha": "catppuccin-latte",
  "catppuccin-latte": "catppuccin-mocha",
};

export function toggleTheme() {
  return applyTheme(TOGGLE_PAIR[currentTheme()] || "new-dark");
}
