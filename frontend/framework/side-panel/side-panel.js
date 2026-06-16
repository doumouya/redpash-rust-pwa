/* side-panel — a tabbed, collapsible INLINE panel: a tab strip (icon+label
   chips) + a collapse affordance + a body that lazily mounts the active tab's
   content on first show (the handle is cached, so switching back is instant).
   It is NOT responsive itself — the workspace-panels frame owns the @media and
   the off-canvas drawer behavior; this is the content that lives inside a
   region. Switching tabs hides/shows the cached bodies (never re-mounts).

   mountSidePanel(host, {
     side: "left"|"right",                 // collapse chevron + edge styling
     tabs: [{ id, label, icon, mount(bodyHost) -> {update?, destroy?} }],
     active?, collapsed?,                   // initial tab + open/closed
     onTab?(id), onToggle?(open),
   }) → { el, body(id), setActive(id), setOpen(bool), toggle(), tab(id),
          destroy }

   Composes atoms.button for the collapse chevron; every rp-sidepanel* class is
   owned solely by side-panel.css (ui-fork-audit R4). */

import { el } from "../boot/dom.js";
import { button } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function mountSidePanel(host, cfg) {
  const side = cfg.side === "right" ? "right" : "left";
  const tabs = cfg.tabs ?? [];
  let active = cfg.active ?? tabs[0]?.id ?? null;
  let open = cfg.collapsed ? false : true;

  // per-tab body host + its lazily-built mount handle (cached after first show).
  const bodies = new Map(); // id → { host, handle|null }

  const root = el("div", { class: `rp-sidepanel rp-sidepanel--${side}` });

  // ── tab strip: icon+label chips + a collapse chevron (points "into" the
  //    region's edge). ──────────────────────────────────────────────────────
  const strip = el("div", { class: "rp-sidepanel-tabs", role: "tablist" });
  const collapseBtn = button({
    icon: side === "right" ? "bi-chevron-right" : "bi-chevron-left",
    title: "Collapse panel",
    variant: "ghost",
    size: "sm",
    onClick: () => api.toggle(),
  });
  collapseBtn.classList.add("rp-sidepanel-collapse");

  const tabEls = new Map(); // id → chip button
  for (const t of tabs) {
    const chip = el("button", {
      class: "rp-sidepanel-tab",
      type: "button",
      role: "tab",
      "data-tab": t.id,
      title: t.label,
      "aria-selected": "false",
    },
      t.icon ? el("i", { class: "rp-sidepanel-tab-icon bi " + t.icon }) : null,
      el("span", { class: "rp-sidepanel-tab-label" }, t.label));
    chip.addEventListener("click", () => api.setActive(t.id));
    tabEls.set(t.id, chip);
    strip.append(chip);
  }
  // chevron sits at the inner edge of the strip; on a right panel it leads.
  if (side === "right") strip.prepend(collapseBtn);
  else strip.append(collapseBtn);

  const body = el("div", { class: "rp-sidepanel-body" });
  root.append(strip, body);

  // lazily build (and cache) the body for a tab the first time it's shown.
  function ensureBody(id) {
    let entry = bodies.get(id);
    if (entry) return entry;
    const tab = tabs.find((t) => t.id === id);
    const bh = el("div", { class: "rp-sidepanel-pane", "data-pane": id });
    body.append(bh);
    entry = { host: bh, handle: null };
    if (tab?.mount) entry.handle = tab.mount(bh) ?? null;
    bodies.set(id, entry);
    return entry;
  }

  function paintTabs() {
    for (const [id, chip] of tabEls) {
      const on = id === active && open;
      chip.classList.toggle("is-active", on);
      chip.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function paintPanes() {
    for (const [id, entry] of bodies) {
      entry.host.classList.toggle("is-active", open && id === active);
    }
  }

  const api = {
    el: root,
    /** The host element for a tab's content (builds + mounts it on first ask).
     *  Lets a consumer reach in without switching to the tab. */
    body: (id) => ensureBody(id).host,
    setActive: (id) => {
      if (!tabEls.has(id)) return;
      active = id;
      if (open) ensureBody(id); // lazy mount on first show
      paintTabs();
      paintPanes();
      cfg.onTab?.(id);
    },
    setOpen: (want) => {
      const next = !!want;
      if (next === open) return;
      open = next;
      root.classList.toggle("is-collapsed", !open);
      if (open && active) ensureBody(active);
      paintTabs();
      paintPanes();
      cfg.onToggle?.(open);
    },
    toggle: () => api.setOpen(!open),
    /** The mount handle for a tab (or null if never shown / no mount fn). */
    tab: (id) => bodies.get(id)?.handle ?? null,
    destroy: () => {
      for (const { handle } of bodies.values()) handle?.destroy?.();
      root.remove();
    },
  };

  root.classList.toggle("is-collapsed", !open);
  if (open && active) ensureBody(active);
  paintTabs();
  paintPanes();
  host.append(root);
  return api;
}

register("side-panel", mountSidePanel);
