/* Purpose: Segmented control — generic mountSeg over the rp-seg atom (pref toggles + view switchers).
   Doc: docs/internal/code/frontend/scripts/framework/seg.md */
// ── Segmented control (framework, CAS_37B2E1BF — form-control set) ───────────
// The JS builder the rp-seg CSS atom lacked. mountSeg renders a 2+-option pill
// switcher with single-select + onChange — replacing the hand-rolled .rp-btn-icon
// pref clusters across Settings, and folding On/Off toggles in as a 2-option
// seg (no separate toggle atom). The CSS is owned by styles/framework/seg.css
// (rp-seg base + --rail variant); this module is behaviour only — it does NOT
// edit that sheet.
//
// SECURITY: every option value/label/title/icon is esc()'d before innerHTML.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

/**
 * Render a segmented control into `host` (host becomes the .rp-seg track).
 * @param {Element} host
 * @param {{ options: Array<{value:string,label?:string,icon?:string,title?:string}>,
 *           value?: string, variant?: string, ariaLabel?: string,
 *           onChange?: (value:string)=>void }} [opts]
 * @returns {{ el:Element, get:()=>string, set:(v:string)=>void }}
 */
export function mountSeg(host, opts = {}) {
  if (!host) return null;
  const options = Array.isArray(opts.options) ? opts.options : [];
  let value = opts.value != null ? opts.value : (options[0] ? options[0].value : "");

  host.className = "rp-seg" + (opts.variant ? " rp-seg--" + opts.variant : "");
  host.setAttribute("role", "group");
  if (opts.ariaLabel) host.setAttribute("aria-label", opts.ariaLabel);

  host.innerHTML = options.map((o) =>
      '<button type="button" data-seg="' + esc(o.value) + '"'
    +   (o.value === value ? ' aria-pressed="true"' : ' aria-pressed="false"')
    +   (o.title ? ' title="' + esc(o.title) + '"' : '')
    + '>'
    +   (o.icon ? '<i class="bi ' + esc(o.icon) + '"></i>' : '')
    +   (o.label != null ? esc(o.label) : '')
    + '</button>'
  ).join("");

  function set(v) {
    value = v;
    host.querySelectorAll("button[data-seg]").forEach((b) => {
      const on = b.getAttribute("data-seg") === v;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  host.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-seg]");
    if (!btn) return;
    const v = btn.getAttribute("data-seg");
    if (v === value) return;
    set(v);
    if (typeof opts.onChange === "function") opts.onChange(v);
  });

  return { el: host, get: () => value, set };
}

register("seg", mountSeg);
