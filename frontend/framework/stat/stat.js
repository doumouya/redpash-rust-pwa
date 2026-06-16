/* stat — KPI tile. mountStat(host, {label, value, tone?, sub?});
   mountStatStrip(host, {stats: [...]}) lays a responsive row of them. */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

export function mountStat(host, cfg) {
  const value = el("div", { class: `rp-stat-value${cfg.tone ? ` is-${cfg.tone}` : ""}` }, String(cfg.value));
  const node = el(
    "div",
    { class: "rp-stat" },
    el("div", { class: "rp-stat-label" }, cfg.label),
    value,
    cfg.sub ? el("div", { class: "rp-stat-sub" }, cfg.sub) : null
  );
  host.append(node);
  return {
    el: node,
    update: (p) => {
      if ("value" in p) value.textContent = String(p.value);
      if ("tone" in p) value.className = `rp-stat-value${p.tone ? ` is-${p.tone}` : ""}`;
    },
    destroy: () => node.remove(),
  };
}

export function mountStatStrip(host, cfg) {
  const strip = el("div", { class: "rp-stat-strip" });
  const handles = (cfg.stats ?? []).map((s) => mountStat(strip, s));
  host.append(strip);
  return { el: strip, handles, update() {}, destroy: () => strip.remove() };
}

register("stat", mountStat);
