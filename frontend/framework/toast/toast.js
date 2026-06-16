/* toast — transient feedback; the partner of optimistic UI (every optimistic
   mutation pairs with a toast carrying revert when it fails).
   toast({message, tone?, action?: {label, onClick}, ttl?}) */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

let stack = null;

function ensureStack() {
  if (!stack || !stack.isConnected) {
    stack = el("div", { class: "rp-toast-stack", role: "status", "aria-live": "polite" });
    document.body.append(stack);
  }
  return stack;
}

export function toast(cfg) {
  const node = el(
    "div",
    { class: `rp-toast${cfg.tone ? ` rp-toast--${cfg.tone}` : ""}` },
    el("span", {}, cfg.message),
    cfg.action
      ? el(
          "button",
          { class: "rp-toast-action", type: "button", onclick: () => { cfg.action.onClick?.(); node.remove(); } },
          cfg.action.label
        )
      : null
  );
  ensureStack().append(node);
  const ttl = cfg.ttl ?? (cfg.action ? 6000 : 3000);
  setTimeout(() => node.remove(), ttl);
  return { el: node, destroy: () => node.remove() };
}

register("toast", toast);
