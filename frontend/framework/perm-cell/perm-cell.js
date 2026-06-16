/* perm-cell — the cycling permission cell for admin field matrices. One
   click cycles the tier's access: "" (none) → "r" (read) → "rw" (read +
   write) → "". The cell paints optimistically; the PAGE owns persistence and
   reverts via update({value}) when the write fails.
   mountPermCell(host, {value: ""|"r"|"rw", onChange(next)})              */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

const ORDER = ["", "r", "rw"];
const LABEL = { "": "—", r: "r", rw: "rw" };
const TITLE = { "": "no access — click for read", r: "read-only — click for read + write", rw: "read + write — click for no access" };

export function mountPermCell(host, cfg) {
  let value = ORDER.includes(cfg.value) ? cfg.value : "";
  const btn = el("button", { class: "rp-perm-cell", type: "button" });

  function paint() {
    btn.textContent = LABEL[value];
    btn.dataset.perm = value || "none";
    btn.title = TITLE[value];
    btn.setAttribute("aria-label", TITLE[value]);
  }

  btn.addEventListener("click", () => {
    value = ORDER[(ORDER.indexOf(value) + 1) % ORDER.length];
    paint();
    cfg.onChange?.(value);
  });

  paint();
  host.append(btn);
  return {
    el: btn,
    update: (p) => {
      if ("value" in p) value = ORDER.includes(p.value) ? p.value : "";
      paint();
    },
    destroy: () => btn.remove(),
  };
}

register("perm-cell", mountPermCell);
