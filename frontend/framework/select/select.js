/* select — single-choice control over the native <select> (keyboard, a11y,
   and mobile come free; a custom listbox is complexity the UI doesn't need).
   mountSelect(host, {options: [{value,label}], value, onChange}) */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

export function mountSelect(host, cfg) {
  const sel = el("select", { class: "rp-select" });
  function render(options, value) {
    sel.replaceChildren(
      ...options.map((o) => {
        const opt = el("option", { value: o.value }, o.label);
        if (o.value === value) opt.selected = true;
        return opt;
      })
    );
  }
  render(cfg.options ?? [], cfg.value);
  sel.addEventListener("change", () => cfg.onChange?.(sel.value));
  host.append(sel);
  return {
    el: sel,
    update: (p) => render(p.options ?? cfg.options ?? [], p.value ?? sel.value),
    destroy: () => sel.remove(),
  };
}

register("select", mountSelect);
