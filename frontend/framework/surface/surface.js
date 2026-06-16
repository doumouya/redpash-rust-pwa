/* surface — the content frame. mountSurface(host, {title, meta?, actions?,
   sections: [{key, title?}]}) → handle.section(key) returns the host element
   a page mounts data components into. */

import { el } from "../boot/dom.js";
import { button } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountSurface(host, cfg) {
  const surface = el("main", { class: "rp-surface" });
  // The head band (title · meta · actions) is omitted when head:false — a
  // full-bleed page (the Data Cleaner's loaded view) gives the whole surface to
  // its content. update({title,meta}) then no-ops safely (guarded below).
  if (cfg.head !== false) {
    const head = el(
      "div",
      { class: "rp-surface-head" },
      el("h1", { class: "rp-surface-title" }, cfg.title ?? ""),
      // The meta span is ALWAYS present so update({meta}) can populate it later
      // (a page often learns its row count after the head is mounted).
      el("span", { class: "rp-surface-meta" }, cfg.meta ?? "")
    );
    const actions = el("div", { class: "rp-surface-actions" });
    for (const a of cfg.actions ?? []) actions.append(button(a));
    head.append(actions);
    surface.append(head);
  }

  const sections = new Map();
  for (const s of cfg.sections ?? []) {
    const body = el("div", {
      class: `rp-surface-section-body${s.layout ? ` rp-surface-section-body--${s.layout}` : ""}`,
    });
    surface.append(
      el(
        "section",
        { class: "rp-surface-section" },
        s.title ? el("h2", { class: "rp-surface-section-title" }, s.title) : null,
        body
      )
    );
    sections.set(s.key, body);
  }

  host.append(surface);
  return {
    el: surface,
    section: (key) => sections.get(key) ?? null,
    update: (p) => {
      if ("title" in p) {
        const t = surface.querySelector(".rp-surface-title");
        if (t) t.textContent = p.title; // no-op on a head:false surface
      }
      if ("meta" in p) {
        const m = surface.querySelector(".rp-surface-meta");
        if (m) m.textContent = p.meta;
      }
    },
    destroy: () => surface.remove(),
  };
}

register("surface", mountSurface);
