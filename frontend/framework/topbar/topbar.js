/* topbar — sidebar toggle · centred omnisearch · per-app page nav (as icons) +
   the app launcher (far right). Slim: the RBAC-agnostic universals (theme ·
   settings · sign-out · profile) live in the rail footer and the brand wordmark
   is gone, so the topbar is pure navigation. mountTopbar(host, {session,
   activePageId, onToggleRail?}) — nav derives from the apps registry (no
   hardcoded nav); onToggleRail (from page-assembly) drives the rail's collapse. */

import { el } from "../boot/dom.js";
import { appsFor, pageById } from "../boot/apps.js";
import { button } from "../atoms/atoms.js";
import { mountMenu } from "../menu/menu.js";
import { mountOmni } from "../omni/omni.js";
import { register } from "../registry/component-registry.js";

export function mountTopbar(host, cfg) {
  const session = cfg.session;
  const page = cfg.activePageId ? pageById(cfg.activePageId) : null;
  const app = page?.app ?? null;

  const bar = el("header", { class: "rp-topbar" });

  // lead: the sidebar toggle (opens/closes the rail). Replaces the old brand;
  // only shown when the page has a rail to toggle (page-assembly supplies the
  // handler). The grid keeps three columns whether or not it's filled.
  const lead = el("div", { class: "rp-topbar-lead" });
  if (cfg.onToggleRail) {
    lead.append(
      button({
        icon: "bi-layout-sidebar",
        variant: "ghost",
        title: "Toggle sidebar",
        ariaLabel: "Toggle sidebar",
        onClick: cfg.onToggleRail,
      })
    );
  }
  bar.append(lead);

  // centre: the omnisearch (its own component; the topbar just composes it).
  const center = el("div", { class: "rp-topbar-center" });
  bar.append(center);
  const omni = session ? mountOmni(center) : null;

  // right cluster: the active app's pages as ICON links, then the app launcher
  // at the far-right end. The universals moved to the rail footer.
  const actions = el("div", { class: "rp-topbar-actions" });
  if (app && !app.hidden) {
    for (const p of app.pages.filter((p) => p.built)) {
      actions.append(
        el(
          "a",
          {
            class: `rp-topbar-nav-icon${p.id === cfg.activePageId ? " is-active" : ""}`,
            href: `#/${p.id}`,
            title: p.label,
            "aria-label": p.label,
          },
          el("i", { class: "bi " + (p.icon || "bi-square") })
        )
      );
    }
  }
  if (session) {
    const apps = appsFor(session).filter((a) => a.id !== app?.id);
    if (apps.length) {
      mountMenu(actions, {
        trigger: button({
          icon: "bi-columns-gap",
          variant: "ghost",
          title: "Switch app",
          ariaLabel: "Switch app",
        }),
        items: apps.map((a) => ({
          label: a.name,
          icon: a.icon,
          onSelect: () => (location.hash = a.landing ?? `#/${a.pages.find((p) => p.built)?.id}`),
        })),
      });
    }
  }
  bar.append(actions);

  host.append(bar);
  return { el: bar, update() {}, destroy: () => { omni?.destroy(); bar.remove(); } };
}

register("topbar", mountTopbar);
