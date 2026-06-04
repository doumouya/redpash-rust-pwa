/* Purpose: Select — a form dropdown select wrapping the rp-menu component (single value + onChange).
   Doc: docs/internal/code/frontend/scripts/framework/select.md */
// ── Select (framework, CAS_37B2E1BF — form-control set) ──────────────────────
// A single-value form select built on the rp-menu dropdown: a trigger button
// showing the current option's label + a menu of options; pick → updates the
// trigger + fires onChange. For pref option sets too long for a seg (e.g. the
// 9-option CSV encoding). JS-only — composes rp-menu (menu.js) + the rp-btn atom;
// no new CSS. Every label esc()'d (by mountMenu + here).
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { mountMenu } from "/scripts/framework/menu.js";

/**
 * @param {Element} host
 * @param {{ options:Array<{value:string,label?:string,icon?:string}>, value?:string,
 *           id?:string, triggerClass?:string, onChange?:(v:string)=>void }} [opts]
 * @returns {{ el:Element, get:()=>string, set:(v:string)=>void }}
 */
export function mountSelect(host, opts = {}) {
  if (!host) return null;
  const options = Array.isArray(opts.options) ? opts.options : [];
  let value = opts.value != null ? opts.value : (options[0] ? options[0].value : "");
  const labelFor = (v) => { const o = options.find((x) => x.value === v); return o ? (o.label != null ? o.label : o.value) : v; };

  const m = mountMenu(host, {
    id: opts.id,
    trigger: { className: opts.triggerClass || "rp-btn rp-btn--glass", label: labelFor(value), icon: "bi-chevron-expand" },
    items: options.map((o) => ({ value: o.value, label: o.label != null ? o.label : o.value, icon: o.icon, selected: o.value === value, tick: o.value === value })),
    dataKey: "value",
  });

  const triggerLabel = m.trigger.querySelector("span");
  function set(v) {
    value = v;
    if (triggerLabel) triggerLabel.textContent = labelFor(v);
    m.panel.querySelectorAll("[data-value]").forEach((it) => it.classList.toggle("selected", it.getAttribute("data-value") === v));
  }
  m.panel.addEventListener("click", (e) => {
    const item = e.target.closest("[data-value]");
    if (!item) return;
    const v = item.getAttribute("data-value");
    if (v === value) return;
    set(v);
    if (typeof opts.onChange === "function") opts.onChange(v);
  });

  return { el: host, get: () => value, set };
}

register("select", mountSelect);
