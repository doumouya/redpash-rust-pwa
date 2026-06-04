/* Purpose: Field row — labeled row (label + hint + control slot) wrapping any control.
   Doc: docs/internal/code/frontend/scripts/framework/field.md */
// ── Field row (framework, CAS_37B2E1BF — form-control set) ───────────────────
// The labeled row that wraps any control (seg / select / rp-input / badge / a
// custom preview), generalizing the page-local page-row.js into ONE framework
// row used by Profile + Settings + any form. CSS: styles/framework/field.css.
//
// The control is filled by a `mount(slotEl)` callback so the row composes ANY
// component without knowing it (mountField gives you the slot; you mount seg /
// input / a live preview into it). label/hint are esc()'d; the control is yours.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

/**
 * Render a labeled field row into `host`.
 * @param {Element} host
 * @param {{ label?:string, hint?:string, stack?:boolean,
 *           mount?:(slot:Element)=>void, html?:string }} [opts]
 *   stack=true → control sits full-width below the label (text inputs / previews).
 *   mount(slot) fills the control slot; or pass html for a static control string.
 * @returns {{ el:Element, control:Element }}
 */
export function mountField(host, opts = {}) {
  if (!host) return null;
  host.className = "rp-field" + (opts.stack ? " rp-field--stack" : "");
  host.innerHTML =
      '<div class="rp-field-main">'
    +   '<span class="rp-field-label">' + esc(opts.label || "") + '</span>'
    +   (opts.hint ? '<span class="rp-field-hint">' + esc(opts.hint) + '</span>' : '')
    + '</div>'
    + '<div class="rp-field-control"></div>';

  const slot = host.querySelector(".rp-field-control");
  if (opts.html != null) slot.innerHTML = opts.html;
  if (typeof opts.mount === "function") opts.mount(slot);
  return { el: host, control: slot };
}

register("field", mountField);
