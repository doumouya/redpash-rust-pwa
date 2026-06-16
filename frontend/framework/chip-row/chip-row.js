/* chip-row — single-select tabs over atoms.chip.
   mountChipRow(host, {items: [{value,label}], value, onChange}) */

import { el } from "../boot/dom.js";
import { chip } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountChipRow(host, cfg) {
  const row = el("div", { class: "rp-chip-row", role: "tablist" });
  let value = cfg.value;
  function render() {
    row.replaceChildren(
      ...(cfg.items ?? []).map((it) =>
        chip({
          label: it.label,
          active: it.value === value,
          onClick: () => {
            if (it.value === value) return;
            value = it.value;
            render();
            cfg.onChange?.(value);
          },
        })
      )
    );
  }
  render();
  host.append(row);
  return {
    el: row,
    update: (p) => {
      if ("items" in p) cfg.items = p.items;
      if ("value" in p) value = p.value;
      render();
    },
    destroy: () => row.remove(),
  };
}

register("chip-row", mountChipRow);
