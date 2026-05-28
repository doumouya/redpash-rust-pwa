// Rail footer nav — the shared utility cluster (Docs / Settings /
// Profile) that lives at the bottom of every railed page's
// `.rt-nav-foot`. Relocated out of the topbar 2026-05-28 (Em): the
// topbar keeps the primary page nav + theme + sign-out; these three
// "utility" destinations move to the rail foot, VS-Code / Slack style.
//
// One component, mounted by each railed page's script:
//   mountRailFooterNav(footEl, { active, session })
// `active` names the current page so its item highlights; `session`
// supplies the avatar initials for the Profile item. The cluster is
// APPENDED to the foot (it doesn't clobber any page-specific create
// actions already there — New case / Upload / etc.), separated by a
// top divider so the two concerns read distinctly.

import { esc } from "/scripts/dom.js";

const FOOTER_NAV = [
  { id: "docs",     hash: "#/docs",     icon: "bi-book-half", label: "Docs" },
  { id: "settings", hash: "#/settings", icon: "bi-gear",      label: "Settings" },
  // Profile renders as an avatar (initials) rather than an icon — same
  // "this is you" read the topbar avatar used to carry.
  { id: "profile",  hash: "#/profile",  avatar: true,         label: "Profile" },
];

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
  footEl.querySelector(".rp-rail-footnav")?.remove();

  const initials = initialsOf(session);
  const items = FOOTER_NAV.map((n) => {
    const isActive = n.id === active ? " is-active" : "";
    if (n.avatar) {
      return '<a class="rp-rail-footnav-item rp-rail-footnav-avatar' + isActive + '" '
        + 'href="' + n.hash + '" title="' + esc(n.label) + '">' + esc(initials) + '</a>';
    }
    return '<a class="rp-rail-footnav-item' + isActive + '" '
      + 'href="' + n.hash + '" title="' + esc(n.label) + '"><i class="bi ' + n.icon + '"></i></a>';
  }).join("");

  footEl.insertAdjacentHTML("beforeend",
    '<div class="rp-rail-footnav" role="navigation" aria-label="Utility">' + items + '</div>');
}
