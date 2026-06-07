/* Purpose: see doc for details.
   Doc: docs/internal/code/frontend/scripts/prefs/controls/theme-swatch.md */
// Settings v2 control — "theme-swatch".
//
// The Appearance > Theme picker: a grid of cards, one per theme, each a LIVE
// mini-preview of that theme's tokens (the card's `.rp-theme-swatch-preview` is
// scoped via `data-rp-theme="<value>"` so its `var(--rp-*)` render THAT theme —
// see the `[data-rp-theme]` selectors in tokens.css) + the theme name + a
// selected check. Clicking a card applies the theme app-wide live (applyTheme →
// setPref general-theme → html[data-theme] + PATCH /me/prefs).
//
// Replaces the dark↔light `onoff` toggle. The pref's `options` (the 4 themes)
// drive what's shown — adding a theme is a tokens.css block + an `options` entry
// in prefs.js, never a change here.
//
// Same `render(spec)` + `postMount(app, spec)` shape as chart-layouts.js, so
// settings.js's CONTROLS dispatcher drives it like any other control.

import { esc } from "/scripts/dom.js";
import { mountRow } from "/scripts/page-row.js";
import { applyTheme, currentTheme } from "/scripts/theme.js";

const HOST_ID = "rp-theme-swatch-host";

/** Render the row slot (label + hint + an empty grid host); postMount paints it. */
export function render(spec) {
  return mountRow({
    label: spec.label || "Theme",
    hint:  spec.hint  || "Pick a theme — applied across the whole app.",
    id:    HOST_ID,
    containerClass: "rp-theme-swatch-row",
  });
}

/** Paint the swatch grid into the slot. Reads the current theme via
 *  currentTheme() and writes via applyTheme() so the app re-themes live. The
 *  options come from the `general-theme` pref (spec.options). */
export function postMount(app, spec) {
  const root = app.querySelector("#" + HOST_ID);
  if (!root) return;
  const options = Array.isArray(spec.options) ? spec.options : [];

  const cardHTML = (o) => {
    const sel = o.value === currentTheme();
    return '<button type="button" class="rp-theme-swatch-card" role="radio"'
      + ' data-value="' + esc(o.value) + '" aria-checked="' + (sel ? "true" : "false") + '">'
      + '<span class="rp-theme-swatch-preview" data-rp-theme="' + esc(o.value) + '" aria-hidden="true">'
      +   '<span class="rp-theme-swatch-bar"></span>'
      +   '<span class="rp-theme-swatch-surf"></span>'
      +   '<span class="rp-theme-swatch-dot"></span>'
      + '</span>'
      + '<span class="rp-theme-swatch-foot">'
      +   '<span class="rp-theme-swatch-name">' + esc(o.label || o.value) + '</span>'
      +   '<i class="bi bi-check-circle-fill rp-theme-swatch-check" aria-hidden="true"></i>'
      + '</span>'
      + '</button>';
  };

  root.innerHTML = '<div class="rp-theme-swatch-grid" role="radiogroup" aria-label="Theme">'
    + options.map(cardHTML).join("") + '</div>';

  // One delegated handler — click a card → apply that theme + move the selection.
  root.addEventListener("click", (e) => {
    const card = e.target.closest(".rp-theme-swatch-card");
    if (!card) return;
    const value = card.dataset.value;
    if (!value || value === currentTheme()) return;
    applyTheme(value);
    root.querySelectorAll(".rp-theme-swatch-card").forEach((c) =>
      c.setAttribute("aria-checked", c.dataset.value === value ? "true" : "false"));
  });
}
