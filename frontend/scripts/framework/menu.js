/* Purpose: Menu framework component — the toggle-click dropdown ([data-dd] trigger + .rp-menu panel) with a single delegated document handler (mutex + outside-click + item-close).
   Doc: docs/internal/code/frontend/scripts/framework/menu.md */
// ── Menu (framework component) ──────────────────────────────────────────────
// The toggle-click DROPDOWN: a trigger button declares data-dd="<panelId>", a
// sibling .rp-menu panel carries id="<panelId>" + .rp-menu-item rows. Ported
// from scripts/dropdown.js (bindDropdown) — ONE delegated document click handler
// for ALL dropdowns, preserving the three behaviors EXACTLY:
//   1. Click a trigger → toggle that panel's `.open`, closing every OTHER open
//      panel first (MUTEX — one open at a time). stopPropagation so the click
//      doesn't bubble to step 3 and immediately re-close us.
//   2. Click an item inside an open panel → the consumer's item handler runs
//      first (bubble phase, children-first), then this handler closes the panel
//      — the standard "click-to-dismiss" pattern.
//   3. Click anywhere else → close every open panel (outside-click).
//
// TWIN PATTERN: this framework delegate keys off `.rp-menu` ONLY. The legacy
// bindDropdown (dropdown.js) keeps driving the live `.rt-dd` panels until the
// shell cutover — the two coexist as separate delegates (the framework one runs
// in the sandbox + post-cutover). At cutover, main.js swaps the panel markup to
// `.rp-menu` AND the boot call from bindDropdown() to bindMenu() together, so
// bindMenu never needs to reference `.rt-dd` (no legacy class in framework/).
// Idempotent (module-level singleton): bindMenu() can be called repeatedly.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// The framework menu panel is `.rp-menu`; `.open` is its visible state.
const OPEN_SEL = ".rp-menu.open";

function closeAll() {
  document.querySelectorAll(OPEN_SEL).forEach((d) => d.classList.remove("open"));
}

let wired = false;

/** Wire the single delegated document handler for every [data-dd] menu. Idempotent. */
export function bindMenu() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dd]");
    if (btn) {
      e.stopPropagation();
      const panel = document.getElementById(btn.dataset.dd);
      if (!panel) return;
      const wasOpen = panel.classList.contains("open");
      // Mutex — only one dropdown open at a time.
      closeAll();
      panel.classList.toggle("open", !wasOpen);
      return;
    }
    // Item click inside an open panel OR click outside any panel: close every
    // open dropdown. The consumer's item handler already ran (bubble fires
    // children-first), so this close is purely visual + state cleanup.
    closeAll();
  });
}

// ── mountMenu — convenience builder ──────────────────────────────────────────
// Emits the rp-menu-wrap > (trigger) + rp-menu(panel) structure into `host` from
// a config, then ensures the delegate is wired. Pages that hand-author the HTML
// only need bindMenu(); this is the lego-brick path for dynamically-built menus.
//   config = {
//     id        : string                          → the data-dd ↔ panel id link
//     trigger   : { label, icon, className }       → the toggle button (defaults
//                                                    to an rp-btn; className lets a
//                                                    caller use rp-btn-icon / a pill)
//     items     : [{ label, icon, value, selected, tick, dataset:{k:v}, disabled }]
//     dataKey   : string  (default "value")        → data-<dataKey> on each item
//   }
// Item clicks are NOT wired here — the consumer subscribes via its own delegated
// handler keyed off the data-<dataKey> attribute (same pattern as the live
// toolbars); this builder owns the DOM, the caller owns what each item does.
export function mountMenu(host, config = {}) {
  if (!host) return null;
  const id = config.id || ("rp-menu-" + Math.random().toString(36).slice(2, 9));
  const t = config.trigger || {};
  const dataKey = config.dataKey || "value";

  const triggerHTML =
    '<button type="button" class="' + esc(t.className || "rp-btn") + '" data-dd="' + esc(id) + '">'
    + (t.icon ? '<i class="bi ' + esc(t.icon) + '"></i>' : "")
    + (t.label != null ? '<span>' + esc(t.label) + '</span>' : "")
    + '</button>';

  const itemsHTML = (config.items || []).map((it) =>
    '<div class="rp-menu-item' + (it.selected ? " selected" : "") + '"'
    + (it.disabled ? ' aria-disabled="true"' : "")
    + ' data-' + esc(dataKey) + '="' + esc(it.value ?? "") + '"'
    + datasetAttrs(it.dataset)
    + '>'
    + (it.icon ? '<i class="bi ' + esc(it.icon) + '"></i>' : "")
    + '<span>' + esc(it.label ?? "") + '</span>'
    + (it.tick ? '<span class="rp-menu-tick">' + esc(it.tick === true ? "✓" : it.tick) + '</span>' : "")
    + '</div>').join("");

  host.classList.add("rp-menu-wrap");
  host.innerHTML = triggerHTML + '<div class="rp-menu" id="' + esc(id) + '">' + itemsHTML + '</div>';

  bindMenu();

  return {
    el: host,
    panel: host.querySelector(".rp-menu"),
    trigger: host.querySelector("[data-dd]"),
    /** Programmatically close this menu's panel. */
    close() { host.querySelector(".rp-menu")?.classList.remove("open"); },
  };
}

// Extra data-* attributes on an item (every value escaped). Keys are assumed to
// be safe identifiers supplied by the caller's config, not user content.
function datasetAttrs(ds) {
  if (!ds) return "";
  return Object.entries(ds)
    .map(([k, v]) => ' data-' + esc(k) + '="' + esc(v ?? "") + '"')
    .join("");
}

register("menu", mountMenu);
