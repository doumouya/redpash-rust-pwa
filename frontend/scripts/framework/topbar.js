/* Purpose: TopBar framework component — brand · omnibox · nav + theme + sign-out (rp- only).
 * Doc: docs/internal/code/frontend/scripts/framework/topbar.md */
// ── TopBar (framework component, CAS_37B2E1BF) ──────────────────────────────
// The shared chrome for every authed page: brand · omnibox · nav + theme +
// sign-out. Already single-source; the framework move makes it a registered
// component on the rp- only namespace (buttons → rp-btn-icon) and COMPOSES the
// omnisearch as its own component (framework/omni.js) rather than embedding it.
//
// A page drops <header id="rp-topbar"></header> + calls mountTopbar(el, {active, session}).
// NAV is the closed list of authed pages; `admin: true` gates the Monitoring entry.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { mountOmni } from "/scripts/framework/omni.js";
import { toggleTheme, currentTheme } from "/scripts/theme.js";
import { esc } from "/scripts/dom.js";

const NAV = [
  { id: "workspace",  hash: "#/workspace",  icon: "bi-stars",     label: "Workspace" },
  { id: "dashboard",  hash: "#/dashboard",  icon: "bi-bar-chart", label: "Dashboard" },
  { id: "sheetwise",  hash: "#/sheetwise",  icon: "bi-database",  label: "SheetWise" },
  { id: "monitoring", hash: "#/monitoring", icon: "bi-activity",  label: "Monitoring" },
];

// Time-of-day salutation + first_name (display_name fallback) in the brand slot.
function greetingFor(session) {
  const name = (session?.first_name || session?.display_name || "").trim();
  if (!name) return "RedPash";
  const hour = new Date().getHours();
  const tod  = hour < 5  ? "Good night"
             : hour < 12 ? "Good morning"
             : hour < 18 ? "Good afternoon"
             : hour < 22 ? "Good evening"
             :             "Good night";
  return esc(tod + ", " + name + ".");
}

export function mountTopbar(host, { active = "", session = null } = {}) {
  if (!host) return;
  host.className = "rp-topbar";
  host.innerHTML =
      '<a class="rp-brand" href="#/workspace" title="Workspace">'
    +   '<span class="rp-brand-mark"></span>'
    +   '<span class="rp-brand-name">' + greetingFor(session) + '</span>'
    + '</a>'
    + '<div data-omni></div>'   // omnibox slot — the omni component fills it (.rp-omni)
    + '<nav class="rp-topbar-actions">'
    +   NAV.filter((n) => !n.admin || session?.is_platform_admin).map((n) => n.parked
          ? '<button class="rp-btn-icon" type="button" disabled title="' + n.label + ' — coming soon">'
            + '<i class="bi ' + n.icon + '"></i></button>'
          : '<a class="rp-btn-icon' + (n.id === active ? ' is-active' : '') + '"'
            + ' href="' + n.hash + '" title="' + n.label + '"><i class="bi ' + n.icon + '"></i></a>'
        ).join('')
    +   '<button class="rp-btn-icon" type="button" data-act="theme" title="Toggle theme">'
    +     '<i class="bi bi-sun"></i></button>'
    +   '<button class="rp-btn-icon" type="button" data-act="signout" title="Sign out">'
    +     '<i class="bi bi-box-arrow-right"></i></button>'
    + '</nav>';

  // omnisearch — its own component; the topbar just composes it.
  mountOmni(host.querySelector("[data-omni]"));

  // theme toggle — the icon shows the CURRENT theme (Dark ↔ moon-stars,
  // Light ↔ sun), aligned with the Settings Appearance row (Em 2026-05-28).
  const themeBtn = host.querySelector('[data-act="theme"]');
  const paintTheme = () => {
    themeBtn.querySelector("i").className =
      currentTheme() === "light" ? "bi bi-sun" : "bi bi-moon-stars";
  };
  paintTheme();
  themeBtn.addEventListener("click", () => { toggleTheme(); paintTheme(); });

  host.querySelector('[data-act="signout"]').addEventListener("click", async () => {
    const { api } = await import("/scripts/api.js");
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });
}

register("topbar", mountTopbar);
