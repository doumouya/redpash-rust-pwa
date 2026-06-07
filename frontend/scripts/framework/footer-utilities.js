/* Purpose: Footer utilities — the theme-toggle + sign-out actions that live in
   the rail footer (moved off the topbar 2026-06-07, Em). One render + wire helper
   so both rail-footer paths (rail-footer.js + framework/rail.js) share identical
   markup + behavior instead of duplicating the theme/logout logic.
   Doc: docs/internal/code/frontend/scripts/framework/footer-utilities.md */
"use strict";

import { api } from "/scripts/api.js";
import { toggleTheme, currentTheme } from "/scripts/theme.js";

/**
 * The theme-toggle + sign-out action buttons, as a string for a footer cluster.
 * They compose the same `.rp-rail-footer-nav-item` atom the footer links use.
 * @returns {string}
 */
export function footerUtilitiesHTML() {
  return ''
    + '<button class="rp-rail-footer-nav-item" type="button" data-act="theme" title="Toggle theme">'
    +   '<i class="bi bi-moon-stars"></i></button>'
    + '<button class="rp-rail-footer-nav-item" type="button" data-act="signout" title="Sign out">'
    +   '<i class="bi bi-box-arrow-right"></i></button>';
}

/**
 * Wire the theme + sign-out buttons within `scopeEl`. The theme icon shows the
 * CURRENT theme (Dark ↔ moon-stars, Light ↔ sun) — aligned with the Settings
 * Appearance row. Safe to call per mount (fresh elements each render).
 * @param {Element} scopeEl - the footer element containing the buttons.
 */
export function wireFooterUtilities(scopeEl) {
  if (!scopeEl) return;
  const themeBtn = scopeEl.querySelector('[data-act="theme"]');
  if (themeBtn) {
    const paintThemeIcon = () => {
      themeBtn.querySelector("i").className =
        currentTheme() === "light" ? "bi bi-sun" : "bi bi-moon-stars";
    };
    paintThemeIcon();
    themeBtn.addEventListener("click", () => { toggleTheme(); paintThemeIcon(); });
  }
  const signoutBtn = scopeEl.querySelector('[data-act="signout"]');
  if (signoutBtn) {
    signoutBtn.addEventListener("click", async () => {
      try { await api.post("/auth/logout"); }
      catch { /* idempotent — clear the client session regardless */ }
      location.hash = "#/login";
      location.reload();
    });
  }
}
