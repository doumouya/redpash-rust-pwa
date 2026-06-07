/* Purpose: Panel framework component — the side-panel shell (filter / tools / history).
   Doc: docs/internal/code/frontend/scripts/framework/panel.md */
// ── Panel (framework component, CAS_37B2E1BF) ───────────────────────────────
// The side-panel SHELL shared by the filter / tools / history panels: an aside
// that slides open from 0 width, with a head (a single title OR a tab strip,
// plus a close button) and a scrolling body (+ optional foot). It is GENERIC +
// data-driven — mountPanel(host, config) emits the whole rp-panel-* structure;
// the filter / tools panels mount THEIR content INTO the returned body later.
// The builder owns the frame + the open/close + tab-switch behavior; the caller
// owns what lives inside and what each action does ("lego brick").
//
// Composes, not duplicates:
//   - rp-btn-icon atom for the close button (the legacy .rp-panel-close was a
//     .rp-btn-icon = rp-btn-icon verbatim; this component only POSITIONS it via CSS).
//   - the rp-panel-* shell CSS (styles/framework/panel.css).
// The head is EITHER a single rp-panel-title (history-style) OR a rp-panel-tabs
// strip (filter / tools); supply `tabs` to get the strip, `title` for the text.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── config shape (every field optional) ─────────────────────────────────────
//   variant  : "filter" | "tools" | "history" | string
//                                       → rp-panel-<variant> (border side + width)
//   title    : string                   → single rp-panel-title in the head
//   titleIcon: string (bi-* class)      → leading icon on the title
//   tabs     : [{ id, label, icon, active }]
//                                       → rp-panel-tabs strip (replaces title)
//   pills    : bool                     → tabs render as the pill switcher
//   foot     : bool                     → emit an empty rp-panel-foot the caller fills
//   onClose  : () => void               → close button click
//   onTab    : (id) => void             → tab click (after is-active is updated)
// Returns { el, head, body, foot, close, setTab(id), setOpen(bool) }; the caller
// mounts content into `body` (and `foot`) and reads `setTab`/`setOpen` to drive it.

/** Build + wire the panel shell into `host`. `host` becomes the `.rp-panel` aside. */
export function mountPanel(host, config = {}) {
  if (!host) return null;
  const variant = config.variant ? " rp-panel-" + config.variant : "";
  host.className = "rp-panel" + variant;
  host.innerHTML =
      '<div class="rp-panel-inner">'
    +   '<div class="rp-panel-head">'
    +     headContentHTML(config)
    +     '<button class="rp-btn-icon rp-panel-close" type="button" title="Close">'
    +       '<i class="bi bi-x-lg"></i></button>'
    +   '</div>'
    +   '<div class="rp-panel-body"></div>'
    +   (config.foot ? '<div class="rp-panel-foot"></div>' : "")
    + '</div>';

  const el    = host;
  const head  = host.querySelector(".rp-panel-head");
  const body  = host.querySelector(".rp-panel-body");
  const foot  = host.querySelector(".rp-panel-foot") || null;
  const close = host.querySelector(".rp-panel-close");

  if (config.onClose) {
    close.addEventListener("click", () => config.onClose());
  }

  // Tab strip — delegated click switches the is-active state, then notifies.
  const tabStrip = host.querySelector(".rp-panel-tabs");
  if (tabStrip && config.onTab) {
    tabStrip.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tab]");
      if (!btn || !tabStrip.contains(btn)) return;
      setTab(btn.dataset.tab);
      config.onTab(btn.dataset.tab);
    });
  }

  /** Mark one tab active by id (updates the strip; caller toggles its own bodies). */
  function setTab(id) {
    if (!tabStrip) return;
    tabStrip.querySelectorAll("button[data-tab]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.tab === id));
  }

  /** Open / close the panel (toggles the slide-open `.open` class). */
  function setOpen(open) { host.classList.toggle("open", !!open); }

  return { el, head, body, foot, close, setTab, setOpen };
}

// ── head content — a tab strip when `tabs` are given, else a single title ────
function headContentHTML(c) {
  if (c.tabs?.length) return tabsHTML(c);
  if (c.title != null) {
    const icon = c.titleIcon ? '<i class="bi ' + esc(c.titleIcon) + '"></i> ' : "";
    return '<span class="rp-panel-title">' + icon + esc(c.title) + '</span>';
  }
  return "";
}

function tabsHTML(c) {
  const cls = "rp-panel-tabs" + (c.pills ? " rp-panel-tabs-pills" : "");
  const btns = c.tabs.map((t) =>
    '<button type="button" data-tab="' + esc(t.id ?? "") + '"'
    + (t.active ? ' class="is-active"' : "") + '>'
    + (t.icon ? '<i class="bi ' + esc(t.icon) + '"></i> ' : "")
    + esc(t.label ?? "") + '</button>').join("");
  return '<div class="' + cls + '">' + btns + '</div>';
}

register("panel", mountPanel);
