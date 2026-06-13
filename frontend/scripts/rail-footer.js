/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/rail-footer.md */
// Rail footer nav — the shared utility cluster (Docs / Settings / theme /
// sign-out / Profile) that lives at the bottom of every railed page's
// `.rp-rail-footer`. Docs/Settings/Profile relocated off the topbar 2026-05-28;
// theme-toggle + sign-out joined them 2026-06-07 (Em — declutter the per-app
// topbar). VS-Code / Slack style: utilities at the bottom of the rail.
//
// One component, mounted by each railed page's script:
//   mountRailFooterNav(footEl, { active, session })
// `active` names the current page so its item highlights; `session`
// supplies the avatar initials for the Profile item. The cluster is
// APPENDED to the foot (it doesn't clobber any page-specific create
// actions already there — New case / Upload / etc.), separated by a
// top divider so the two concerns read distinctly.

import { esc } from "/scripts/dom.js";
import { footerUtilitiesHTML, wireFooterUtilities } from "/scripts/framework/footer-utilities.js";

// Cross-app UTILITY destinations. LEAN build: settings + profile pages removed
// (single-user tool, no prefs) — only theme/sign-out (footer-utilities) remain.
const FOOTER_NAV = [];

function initialsOf(session) {
  const name = (session?.display_name || session?.username || "").trim();
  return name
    ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "··";
}

export function mountRailFooterNav(footEl, { active = "", session = null } = {}) {
  if (!footEl) return;
  // Idempotent — a re-mount (page re-render) replaces the prior cluster
  // rather than stacking a second one.
  footEl.querySelector(".rp-rail-footer-nav")?.remove();

  const initials = initialsOf(session);
  // Links (Docs / Settings), then the theme + sign-out actions, then the Profile
  // avatar last (the "you" anchor). The avatar is split out so the action buttons
  // sit between the destinations and the identity mark.
  const links = FOOTER_NAV.filter((n) => !n.avatar).map((n) => {
    const isActive = n.id === active ? " is-active" : "";
    return '<a class="rp-rail-footer-nav-item' + isActive + '" '
      + 'href="' + n.hash + '" title="' + esc(n.label) + '"><i class="bi ' + n.icon + '"></i></a>';
  }).join("");
  const profile = FOOTER_NAV.find((n) => n.avatar);
  const avatar = profile
    ? '<a class="rp-rail-footer-nav-item rp-rail-footer-nav-avatar' + (profile.id === active ? " is-active" : "") + '" '
      + 'href="' + profile.hash + '" title="' + esc(profile.label) + '">' + esc(initials) + '</a>'
    : "";

  footEl.insertAdjacentHTML("beforeend",
    '<div class="rp-rail-footer-nav" role="navigation" aria-label="Utility">'
    + links + footerUtilitiesHTML() + avatar + '</div>');
  wireFooterUtilities(footEl.querySelector(".rp-rail-footer-nav"));
}
