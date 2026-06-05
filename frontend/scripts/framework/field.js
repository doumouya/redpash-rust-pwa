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
  host.className = "rp-field";
  if (opts.stack) host.setAttribute("data-variant", "stack");
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

/**
 * Editable field row: label + a click-to-edit **value button**. In view mode
 * the value renders as a button; clicking (or Enter/Space) enters edit mode and
 * hands the control slot to the caller's `edit(slot, commit, cancel)` — which
 * mounts whatever editor fits (a `select`, a `menu`, a user-picker). Calling
 * `commit(newValue)` writes it back and returns to view mode; `cancel()` returns
 * without change. Composes `rp-field` (the row) — the inline-editable property
 * pattern de-cased from the Cases sidebar so any record view reuses it.
 *
 * @param {Element} host
 * @param {{ label?:string, value?:string, placeholder?:string,
 *           edit?:(slot:Element, commit:(v:string)=>void, cancel:()=>void)=>void }} [opts]
 * @returns {{ el:Element, set:(v:string)=>void, value:()=>string }}
 */
export function mountFieldEditable(host, opts = {}) {
  if (!host) return null;
  let value = opts.value == null ? "" : String(opts.value);
  let editing = false;
  const placeholder = opts.placeholder || "—";
  const { el, control } = mountField(host, { label: opts.label });
  host.setAttribute("data-variant", "editable");

  function paintView(focus) {
    control.innerHTML =
        '<button type="button" class="rp-field-value" aria-haspopup="true"'
      + (value ? '' : ' data-empty="1"')
      + ' aria-label="' + esc((opts.label || "") + ": " + (value || placeholder)) + '">'
      + esc(value || placeholder) + '</button>';
    const btn = control.querySelector(".rp-field-value");
    btn.addEventListener("click", enterEdit, { once: true });
    if (focus) btn.focus();
  }
  function enterEdit() {
    if (editing || typeof opts.edit !== "function") return;
    editing = true;
    host.setAttribute("data-editing", "");
    control.innerHTML = "";                 // hand the slot to the caller's editor
    // Click outside the row, or Escape, closes edit mode. An editor's own blur fires
    // only when focus moves to a focusable element, so a click on non-focusable chrome
    // would otherwise strand the editor open — the bespoke pickers this de-cased had an
    // equivalent document-level dismissal. Escape is owned here too so every editor
    // (the native <select>, the user-search input, any future one) cancels uniformly.
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKeydown, true);
    opts.edit(control, commit, cancel);
  }
  function onOutside(e) { if (!host.contains(e.target)) cancel(); }
  function onKeydown(e) { if (e.key === "Escape") cancel(); }
  function commit(v) { if (v != null) value = String(v); finish(); }
  function cancel() { finish(); }
  function finish() {
    if (!editing) return;                   // idempotent — an editor's blur, onOutside, and onKeydown can all fire
    editing = false;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKeydown, true);
    host.removeAttribute("data-editing");
    paintView(true);
  }

  paintView(false);
  return {
    el,
    set(v) { value = v == null ? "" : String(v); paintView(false); },
    value: () => value,
  };
}

register("field-editable", mountFieldEditable);
