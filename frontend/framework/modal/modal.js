/* modal — create + confirm-destructive only; everything else is inline (the
   minimalism rule). openModal({title, body, actions}) returns {close}.
   confirmModal({title, message, confirmLabel, danger}) → Promise<boolean>. */

import { el } from "../boot/dom.js";
import { button } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

export function openModal(cfg) {
  const overlay = el("div", { class: "rp-modal-overlay", role: "dialog", "aria-modal": "true" });
  const foot = el("div", { class: "rp-modal-foot" });
  const box = el(
    "div",
    { class: "rp-modal" },
    el("h2", { class: "rp-modal-title" }, cfg.title),
    el("div", { class: "rp-modal-body" }, cfg.body ?? ""),
    foot
  );
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  for (const a of cfg.actions ?? []) {
    foot.append(
      button({ ...a, onClick: () => a.onClick?.({ close }) })
    );
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  overlay.append(box);
  document.body.append(overlay);
  box.querySelector("input, select, button")?.focus();
  return { el: overlay, close };
}

export function confirmModal(cfg) {
  return new Promise((resolve) => {
    const m = openModal({
      title: cfg.title,
      body: el("p", { class: "rp-modal-text" }, cfg.message ?? ""),
      actions: [
        { label: "Cancel", variant: "ghost", onClick: ({ close }) => { close(); resolve(false); } },
        {
          label: cfg.confirmLabel ?? "Confirm",
          variant: cfg.danger ? "danger" : "accent",
          onClick: ({ close }) => { close(); resolve(true); },
        },
      ],
    });
    void m;
  });
}

register("modal", openModal);
