/* page-assembly — assemblePage(host, spec): a whole railed page from a pure
   spec, zero literal markup. The composer mounts topbar → (rail?) → surface
   and hands back the section hosts; the page mounts data components into
   them. A page module is therefore spec + handlers — the components do the
   work (the predecessor's 2,700-line page modules are structurally
   impossible here).

   spec = {
     session, activePageId,
     rail?: { groups: [...] },          // mountRail config
     title, meta?, actions?,            // mountSurface head
     sections: [{key, title?}],
   }
   → { topbar, rail?, surface, section(key), destroy() }                */

import { el } from "../boot/dom.js";
import { mountTopbar } from "../topbar/topbar.js";
import { mountAppRail } from "../rail/rail-data.js";
import { mountSurface } from "../surface/surface.js";
import { register } from "../registry/component-registry.js";

export function assemblePage(host, spec) {
  const shell = el("div", { class: "rp-shell" });

  // The rail is global; the topbar's sidebar toggle opens/closes it. `rail` is
  // assigned just below (the toggle closure runs on click, long after).
  const showRail = spec.session && spec.rail !== false;
  let rail = null;

  const topbar = mountTopbar(shell, {
    session: spec.session,
    activePageId: spec.activePageId,
    onToggleRail: showRail ? () => rail?.toggleCollapse() : undefined,
  });

  const body = el("div", { class: "rp-shell-body" });
  shell.append(body);

  // The rail is GLOBAL and SERVER-DRIVEN: mounted on every authed page (like the
  // topbar), its content fetched from /api/rail/<activePageId>. A page passes
  // only { overview?, onRailTab?, active?, search? } (or nothing); pass
  // `rail: false` to opt out (pre-auth pages). The page name is NOT shown in the
  // rail — it's in the topbar nav; the rail goes straight to its content.
  if (showRail) {
    const railSpec = { view: spec.activePageId, ...(spec.rail || {}) };
    rail = mountAppRail(body, railSpec, spec.session);
  }
  const surface = mountSurface(body, {
    title: spec.title,
    meta: spec.meta,
    actions: spec.actions,
    sections: spec.sections ?? [],
    head: spec.head, // head:false → a full-bleed surface (no title/meta band)
  });

  host.append(shell);
  return {
    el: shell,
    topbar,
    rail,
    surface,
    section: (key) => surface.section(key),
    destroy: () => {
      topbar.destroy();
      rail?.destroy();
      surface.destroy();
      shell.remove();
    },
  };
}

register("page-assembly", assemblePage);
