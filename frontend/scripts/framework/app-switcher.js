/* Purpose: App-switcher (launcher) — the topbar "My Services" menu that switches
   between RedPash apps. Reads the app registry (apps.js); the Admin tile shows
   only for platform admins (app = RBAC boundary).
   Doc: docs/internal/code/frontend/scripts/framework/app-switcher.md */
// ── App-switcher (framework, launcher) ──────────────────────────────────────
// Informatica's "My Services" model: switch apps from a central launcher rather
// than one flat nav. Pure markup — it composes the .rp-menu atom (toggled by the
// global bindDropdown delegate in main.js) and plain `<a href="#/…">` hash links
// (navigation needs no JS). The topbar splices the returned string into its
// actions nav — no separate mount/teardown. The app list comes from apps.js, so
// adding an app or moving a page is a one-place edit there, not here.
//
// One framework class per element (class-count rule): the launcher is a
// `data-variant` of .rp-menu — tile/menu/wrap styling hangs off the wrap's
// `[data-variant="launcher"]` ancestor in CSS, never a second class.
"use strict";

import { appsFor } from "/scripts/framework/apps.js";
import { esc } from "/scripts/dom.js";

/**
 * Build the launcher markup for splicing into the topbar's actions nav.
 * @param {{ session?: object|null, activeAppId?: string|null }} [opts]
 * @returns {string} the `.rp-menu-wrap` launcher HTML.
 */
export function appSwitcherHTML({ session = null, activeAppId = null } = {}) {
  const tiles = appsFor(session).map((a) => {
    const selected = a.id === activeAppId ? " selected" : "";
    const current = selected ? ' aria-current="true"' : "";
    const sub = a.pages.length
      ? '<span class="rp-launcher-app-sub">' + esc(a.pages.map((p) => p.label).join(" · ")) + '</span>'
      : "";
    return '<a class="rp-menu-item' + selected + '" role="menuitem" href="' + a.landing + '"' + current + '>'
      +   '<span class="rp-launcher-app-icon"><i class="bi ' + esc(a.icon) + '"></i></span>'
      +   '<span class="rp-launcher-app-text">'
      +     '<span class="rp-launcher-app-name">' + esc(a.name) + '</span>'
      +     sub
      +   '</span>'
      + '</a>';
  }).join("");

  return '<div class="rp-menu-wrap" data-variant="launcher">'
    + '<button class="rp-btn-icon" data-dd="rp-app-switcher" type="button"'
    +   ' title="Switch app" aria-haspopup="menu" aria-label="Switch app">'
    +   '<i class="bi bi-grid-3x3-gap"></i>'
    + '</button>'
    + '<div class="rp-menu" id="rp-app-switcher" role="menu">'
    +   '<div class="rp-launcher-head">My apps</div>'
    +   tiles
    + '</div>'
    + '</div>';
}
