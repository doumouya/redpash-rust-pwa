// Topbar — the shared chrome for the authed pages (home, Workspace).
//
// One component, one button pattern: brand · omnibox · nav + theme +
// sign-out + avatar. A page drops <header id="rp-topbar"></header> into
// its partial and its script calls mountTopbar(el, { active, session });
// `active` names which nav entry is the current page. There is exactly
// one topbar — every authed page renders the identical thing.
//
// NAV is the closed list of the app's authed pages. Entries marked
// `parked: true` render as a disabled button (an honest "coming soon",
// not a broken link); wiring lands when the page does, by dropping the
// `parked` flag from the entry — no other topbar edit needed.

import { api } from "/scripts/api.js";
import { toggleTheme, currentTheme } from "/scripts/theme.js";

const NAV = [
  { id: "home",      hash: "#/home",      icon: "bi-house-door", label: "Home" },
  { id: "workspace", hash: "#/workspace", icon: "bi-stars",      label: "Workspace" },
  { id: "profile",   hash: "#/profile",   icon: "bi-person",     label: "Profile" },
  { id: "settings",  hash: "#/settings",  icon: "bi-gear",       label: "Settings" },
  { id: "docs",      hash: "#/docs",      icon: "bi-book-half",  label: "Docs" },
];

// The Ctrl/Cmd+K handler is global and must bind once for the app's
// life, not once per topbar mount.
let _ctrlKBound = false;

export function mountTopbar(host, { active = "", session = null } = {}) {
  if (!host) return;
  host.className = "rp-topbar";
  host.innerHTML =
      '<a class="rp-brand" href="#/home" title="Home">'
    +   '<span class="rp-brand-mark"></span>'
    +   '<span class="rp-brand-name">RedPash</span>'
    + '</a>'
    + '<div class="rp-omni">'
    +   '<i class="bi bi-search"></i>'
    +   '<input type="search" id="rp-omni" placeholder="Search RedPash — projects, files, settings…" />'
    +   '<kbd class="rp-omni-kbd">Ctrl K</kbd>'
    + '</div>'
    + '<nav class="rp-topbar-actions">'
    +   NAV.map((n) => n.parked
          ? '<button class="rt-btn" type="button" disabled title="' + n.label + ' — coming soon">'
            + '<i class="bi ' + n.icon + '"></i></button>'
          : '<a class="rt-btn' + (n.id === active ? ' is-active' : '') + '"'
            + ' href="' + n.hash + '" title="' + n.label + '"><i class="bi ' + n.icon + '"></i></a>'
        ).join('')
    +   '<button class="rt-btn" type="button" data-act="theme" title="Toggle theme">'
    +     '<i class="bi bi-sun"></i></button>'
    +   '<button class="rt-btn" type="button" data-act="signout" title="Sign out">'
    +     '<i class="bi bi-box-arrow-right"></i></button>'
    +   '<span class="rp-avatar" data-avatar>··</span>'
    + '</nav>';

  // avatar — the signed-in user's initials
  const name = (session?.display_name || session?.username || "").trim();
  host.querySelector("[data-avatar]").textContent = name
    ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "··";

  // theme toggle — the icon shows the theme the click switches to
  const themeBtn = host.querySelector('[data-act="theme"]');
  const paintTheme = () => {
    themeBtn.querySelector("i").className =
      currentTheme() === "light" ? "bi bi-moon-stars" : "bi bi-sun";
  };
  paintTheme();
  themeBtn.addEventListener("click", () => { toggleTheme(); paintTheme(); });

  // sign out
  host.querySelector('[data-act="signout"]').addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });

  // Ctrl/Cmd+K focuses the omnibox
  if (!_ctrlKBound) {
    _ctrlKBound = true;
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        const omni = document.getElementById("rp-omni");
        if (omni) { e.preventDefault(); omni.focus(); }
      }
    });
  }
}
