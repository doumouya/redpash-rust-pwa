/* card — content tile. mountCard(host, {title, sub?, href?, onClick?, body?}) */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

export function mountCard(host, cfg) {
  const tag = cfg.href ? "a" : cfg.onClick ? "button" : "div";
  const card = el(
    tag,
    {
      class: "rp-card",
      href: cfg.href,
      type: tag === "button" ? "button" : null,
      onclick: cfg.onClick,
    },
    cfg.title ? el("h3", { class: "rp-card-title" }, cfg.title) : null,
    cfg.sub ? el("p", { class: "rp-card-sub" }, cfg.sub) : null,
    cfg.body ?? null
  );
  host.append(card);
  return { el: card, update() {}, destroy: () => card.remove() };
}

register("card", mountCard);
