/* atoms — builder functions for the lowest-level vocabulary. Pages and
   components call these instead of writing rp- markup (ui-fork-audit R8). */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

/** button({label?, icon?, variant?: 'accent'|'ghost'|'danger', size?: 'sm',
    onClick, disabled, type, title?, ariaLabel?})
    `icon` is a Bootstrap Icons name (e.g. "bi-layout-sidebar"); icon + no label
    renders a square icon-only button (rp-btn--icon). Always give an icon-only
    button a title/ariaLabel for accessibility. */
export function button(cfg) {
  const cls = ["rp-btn"];
  if (cfg.variant) cls.push(`rp-btn--${cfg.variant}`);
  if (cfg.size) cls.push(`rp-btn--${cfg.size}`);
  if (cfg.icon && cfg.label == null) cls.push("rp-btn--icon");
  const b = el(
    "button",
    {
      class: cls.join(" "),
      type: cfg.type ?? "button",
      onclick: cfg.onClick,
      title: cfg.title ?? null,
      "aria-label": cfg.ariaLabel ?? cfg.title ?? null,
    },
    cfg.icon ? el("i", { class: "bi " + cfg.icon }) : null,
    cfg.label ?? null
  );
  if (cfg.disabled) b.disabled = true;
  return b;
}

/** chip({label, active, onClick}) */
export function chip(cfg) {
  return el(
    "button",
    {
      class: `rp-chip${cfg.active ? " is-active" : ""}`,
      type: "button",
      onclick: cfg.onClick,
      "aria-pressed": cfg.active ? "true" : "false",
    },
    cfg.label
  );
}

/** input({placeholder, value, type, onInput, onEnter}) */
export function input(cfg = {}) {
  const i = el("input", {
    class: "rp-input",
    type: cfg.type ?? "text",
    placeholder: cfg.placeholder ?? "",
  });
  if (cfg.value != null) i.value = cfg.value;
  if (cfg.onInput) i.addEventListener("input", () => cfg.onInput(i.value));
  if (cfg.onEnter)
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") cfg.onEnter(i.value);
    });
  return i;
}

/** textarea({placeholder, value, rows, onInput}) — the multiline `input`. */
export function textarea(cfg = {}) {
  const t = el("textarea", {
    class: "rp-textarea",
    placeholder: cfg.placeholder ?? "",
    rows: String(cfg.rows ?? 3),
  });
  if (cfg.value != null) t.value = cfg.value;
  if (cfg.onInput) t.addEventListener("input", () => cfg.onInput(t.value));
  return t;
}

/** badge({label, tone?: 'ok'|'warn'|'danger'|'info'|'accent'}) */
export function badge(cfg) {
  return el(
    "span",
    { class: `rp-badge${cfg.tone ? ` rp-badge--${cfg.tone}` : ""}` },
    cfg.label
  );
}

export function spinner() {
  return el("span", { class: "rp-spinner", role: "status", "aria-label": "Loading" });
}

export function kbd(label) {
  return el("kbd", { class: "rp-kbd" }, label);
}

register("atoms", null, {
  builders: ["button", "chip", "input", "textarea", "badge", "spinner", "kbd"],
});
