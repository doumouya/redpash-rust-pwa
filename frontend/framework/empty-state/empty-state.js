/* empty-state — title + one line + ONE action. The empty state IS the
   onboarding; if it needs more words, the design is wrong.
   mountEmptyState(host, {title, line, action?: {label, variant?, onClick}}) */

import { el } from "../boot/dom.js";
import { button } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountEmptyState(host, cfg) {
  const node = el(
    "div",
    { class: "rp-empty" },
    el("h3", { class: "rp-empty-title" }, cfg.title),
    cfg.line ? el("p", { class: "rp-empty-line" }, cfg.line) : null,
    cfg.action ? button({ variant: "accent", ...cfg.action }) : null
  );
  host.append(node);
  return { el: node, update() {}, destroy: () => node.remove() };
}

register("empty-state", mountEmptyState);
