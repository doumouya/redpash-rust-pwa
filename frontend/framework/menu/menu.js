/* menu — dropdown with ONE document-level delegated listener (covers every
   trigger, including dynamically rendered ones; the predecessor's mount-time
   sweeps missed those). mountMenu(host, {trigger, items}) where items =
   [{label, icon?, onSelect, selected?} | {sep:true} | {label, heading:true}].
   `icon` (a Bootstrap Icons name) renders before the label — icon + label, the
   right pairing for a drawer (instant recognition + the word kills ambiguity). */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

let delegated = false;

function installDelegation() {
  if (delegated) return;
  delegated = true;
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-dd]");
    const openMenus = document.querySelectorAll(".rp-menu.is-open");
    for (const m of openMenus) {
      if (!trigger || m.previousElementSibling !== trigger) m.classList.remove("is-open");
    }
    if (trigger) {
      const menu = trigger.nextElementSibling;
      if (menu?.classList.contains("rp-menu")) menu.classList.toggle("is-open");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      for (const m of document.querySelectorAll(".rp-menu.is-open")) m.classList.remove("is-open");
    }
  });
}

export function mountMenu(host, cfg) {
  installDelegation();
  const wrap = el("div", { class: "rp-menu-wrap" });
  const trigger = cfg.trigger; // a DOM node from atoms.button() etc.
  trigger.setAttribute("data-dd", "");
  const menu = el("div", { class: "rp-menu", role: "menu" });

  function renderItems(items) {
    menu.replaceChildren(
      ...items.map((it) => {
        if (it.sep) return el("div", { class: "rp-menu-sep" });
        if (it.heading) return el("div", { class: "rp-menu-label" }, it.label);
        return el(
          "button",
          {
            class: `rp-menu-item${it.selected ? " is-selected" : ""}`,
            type: "button",
            role: "menuitem",
            onclick: () => {
              menu.classList.remove("is-open");
              it.onSelect?.();
            },
          },
          // icon + label grouped as a left cluster (the item is space-between).
          el(
            "span",
            { class: "rp-menu-item-label" },
            it.icon ? el("i", { class: "rp-menu-item-icon bi " + it.icon }) : null,
            it.label
          )
        );
      })
    );
  }
  renderItems(cfg.items ?? []);

  wrap.append(trigger, menu);
  host.append(wrap);
  return {
    el: wrap,
    update: (partial) => partial.items && renderItems(partial.items),
    destroy: () => wrap.remove(),
  };
}

register("menu", mountMenu);
