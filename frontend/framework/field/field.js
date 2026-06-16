/* field — labeled form row wrapping any control node.
   mountField(host, {label, help?, control, inline?}) */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

export function mountField(host, cfg) {
  const cls = ["rp-field"];
  if (cfg.inline) cls.push("rp-field--inline");
  if (cfg.bare) cls.push("rp-field--bare");
  const row = el(
    "label",
    { class: cls.join(" ") },
    el("span", { class: "rp-field-label" }, cfg.label),
    cfg.control,
    cfg.help ? el("span", { class: "rp-field-help" }, cfg.help) : null
  );
  const error = el("span", { class: "rp-field-error" });
  host.append(row);
  return {
    el: row,
    update: (p) => {
      if ("error" in p) {
        error.textContent = p.error ?? "";
        if (p.error && !error.isConnected) row.append(error);
        if (!p.error) error.remove();
      }
    },
    destroy: () => row.remove(),
  };
}

register("field", mountField);
