/* Purpose: page-assembly proof — compose a full railed page from registered framework components.
   Doc: docs/internal/code/frontend/scripts/framework/page-assembly.md */
// ── Page assembly (framework, CAS_37B2E1BF — the completeness proof) ─────────
// The sandbox-done gate = "rebuild the 7 real pages from ONLY framework
// components." This module is the GENERIC ASSEMBLER for that: it builds the live
// rail-shell outer chain and mounts the registered units into it from a plain
// page spec — the seed of the eventual declarative page-spec + runner.
//
//   live page chain (static in partials today; assembled here):
//     section.rp-shell.rp-shell--wide
//       > header#rp-topbar                         → topbar component
//       > div.rp-shell-body
//           > rail                                 → rail component (host-becomes-root)
//           > main.rp-main > div.rp-surface        → surface component (head→chip→stat→table)
//
// A page spec = { topbar, rail, surface, comments?, shellHead? }. Each key maps to
// a registered component; omit a key and that slot is skipped. assemblePage
// COMPOSES — it owns no component markup, only the frame + the order.
//
// SECURITY: assemblePage interpolates no caller strings except the optional
// shellHead title/count, which are esc()'d; every component escapes its own
// dynamic content.
//
// HONEST-PROOF NOTE: this assembler can only compose what EXISTS. Per the page
// mapping (workflow wnbk5c1gz), no real page rebuilds 100% yet — the blocking
// gaps are B3 RedTable + list-toolbar, S4 create-action, a shellHead surface
// section, and the Cases board/detail extras. Cases DETAIL is the one that
// rebuilds cleanly today (object head + status chip-row + comments), so it is
// the worked proof in the sandbox. The rest are gap-flagged, not faked.
"use strict";

import { register, get } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// The .rp-shell-head title+count band (Home/Monitoring section header). It lives
// in surface.css but mountSurface has no section for it yet (it owns the rp-head
// OBJECT header instead) — GAP. The assembler can emit it as frame chrome so a
// shell-head page renders; the proper fix is a `shellHead` section in mountSurface.
function shellHeadHTML(h) {
  return '<header class="rp-shell-head">'
    + '<h2 class="rp-shell-head-title">' + esc(h.title || "") + '</h2>'
    + (h.count != null ? '<span class="rp-shell-head-count">' + esc(h.count) + '</span>' : "")
    + '</header>';
}

/**
 * Assemble a railed page from registered components into `host`.
 * @param {Element} host
 * @param {{ topbar?:object, rail?:object, surface?:object, comments?:object, shellHead?:{title:string,count?:string}, wide?:boolean }} [spec]
 * @returns {{topbar:any, rail:any, surface:any, comments:any}|null}
 */
export function assemblePage(host, spec = {}) {
  if (!host) return null;
  host.innerHTML =
      '<section class="rp-shell' + (spec.wide === false ? "" : " rp-shell--wide") + '">'
    +   '<header data-pg="topbar"></header>'
    +   '<div class="rp-shell-body">'
    +     '<div data-pg="rail"></div>'
    +     '<main class="rp-main">'
    +       '<div data-pg="surface"></div>'
    +       (spec.comments ? '<div data-pg="comments"></div>' : "")
    +     '</main>'
    +   '</div>'
    + '</section>';

  const mount = (name, sel, cfg) => {
    if (!cfg) return null;
    const f = get(name), el = host.querySelector(sel);
    return (f && el) ? f(el, cfg) : null;
  };

  const surfaceEl = host.querySelector('[data-pg="surface"]');
  const handles = {
    topbar:  mount("topbar",  '[data-pg="topbar"]',  spec.topbar),
    rail:    mount("rail",    '[data-pg="rail"]',    spec.rail),
    surface: mount("surface", '[data-pg="surface"]', spec.surface),
    comments: spec.comments ? mount("comments", '[data-pg="comments"]', spec.comments) : null,
  };

  // shellHead (Home/Monitoring) — prepend into the surface as its first child.
  // GAP: belongs in mountSurface as a `shellHead` section (see header note).
  if (spec.shellHead && surfaceEl) {
    surfaceEl.insertAdjacentHTML("afterbegin", shellHeadHTML(spec.shellHead));
  }
  return handles;
}

register("page", assemblePage);
