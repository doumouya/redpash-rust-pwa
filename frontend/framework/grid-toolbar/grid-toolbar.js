/* grid-toolbar — a DATA-DRIVEN control strip above a grid. The toolbar is a
   spec of controls; it renders them, runs ONE delegated handler, and reports
   every action through onAction(id, ctx). It holds NO behavior of its own —
   mutual-exclusion within a toggle group, what a search does, etc. are the
   CONSUMER's concern (the toolbar just reports the click + exposes setActive/
   setDisabled so the consumer can reflect state).

   mountGridToolbar(host, {
     controls: [ControlSpec],   // tagged union by `kind` (see below)
     onAction(id, ctx),         // ctx: {value?} search · {menu?} menu item
     state,                     // opaque; passed to when/active/visible/label
   }) → { el, update({state, controls}), setActive(id,bool),
          setDisabled(id,bool), destroy }

   ControlSpec (by kind):
     {kind:"search",  id, placeholder?, onInput(q)}         // live-typed query
     {kind:"button",  id, icon, label?, title, variant?, when?(state)->bool}
     {kind:"toggle",  id, icon, title, group?, active?(state)->bool}
     {kind:"menu",    id, icon, label?, title, items:[{id,label,icon}]}
     {kind:"chip",    id, label(state)->str, visible?(state)->bool}
     {kind:"sep"}                                            // a divider

   when=false → the button is hidden+disabled. `active`/`visible`/`label(state)`
   are re-evaluated on update(state). onAction receives ctx: search carries
   {value}, a menu item carries {menu: <menu id>}.

   Composes atoms.button + mountMenu + atoms.input; every rp-gtb* class is owned
   solely by grid-toolbar.css (ui-fork-audit R4). */

import { el } from "../boot/dom.js";
import { button, input } from "../atoms/atoms.js";
import { mountMenu } from "../menu/menu.js";
import { register } from "../registry/component-registry.js";

export function mountGridToolbar(host, cfg) {
  let controls = cfg.controls ?? [];
  let state = cfg.state;

  const root = el("div", { class: "rp-gtb", role: "toolbar" });
  // id → { spec, node, kind, menuHandle?, searchInput? } for update + the
  // setActive/setDisabled handle methods.
  const reg = new Map();

  function render() {
    reg.clear();
    const nodes = controls.map(buildControl).filter(Boolean);
    root.replaceChildren(...nodes);
    refresh();
  }

  function buildControl(spec) {
    if (spec.kind === "sep") {
      return el("span", { class: "rp-gtb-sep", "aria-hidden": "true" });
    }
    if (spec.kind === "search") {
      const field = input({
        type: "search",
        placeholder: spec.placeholder ?? "Search…",
        onInput: (q) => { spec.onInput?.(q); cfg.onAction?.(spec.id, { value: q }); },
      });
      // value carried on the spec so a re-render (controls rebuilt) preserves
      // what's typed — the consumer keeps the query in its toolbar state.
      if (spec.value != null) field.value = spec.value;
      field.classList.add("rp-gtb-input"); // own class for the icon-padding
      const wrap = el("div", { class: "rp-gtb-search" },
        el("i", { class: "rp-gtb-search-icon bi bi-search" }), field);
      reg.set(spec.id, { spec, node: wrap, kind: "search", searchInput: field });
      return wrap;
    }
    if (spec.kind === "chip") {
      const c = el("button", {
        class: "rp-gtb-chip", type: "button", "data-gtb": spec.id,
      }, "");
      reg.set(spec.id, { spec, node: c, kind: "chip" });
      return c;
    }
    if (spec.kind === "menu") {
      const trigger = button({
        icon: spec.icon, label: spec.label ?? null, title: spec.title,
        variant: spec.variant ?? "ghost",
      });
      const wrap = el("div", { class: "rp-gtb-item" });
      const handle = mountMenu(wrap, {
        trigger,
        items: (spec.items ?? []).map((it) => ({
          label: it.label, icon: it.icon,
          onSelect: () => cfg.onAction?.(it.id, { menu: spec.id }),
        })),
      });
      reg.set(spec.id, { spec, node: wrap, kind: "menu", menuHandle: handle });
      return wrap;
    }
    // button + toggle share the atom; the only difference is which predicate
    // governs them and that a toggle carries a group + an aria-pressed state.
    const btn = button({
      icon: spec.icon, label: spec.label ?? null, title: spec.title,
      variant: spec.variant ?? "ghost",
    });
    btn.dataset.gtb = spec.id;
    if (spec.kind === "toggle") {
      btn.classList.add("rp-gtb-toggle");
      if (spec.group != null) btn.dataset.gtbGroup = spec.group;
      btn.setAttribute("aria-pressed", "false");
    }
    reg.set(spec.id, { spec, node: btn, kind: spec.kind });
    return btn;
  }

  // re-evaluate the per-control predicates against the current state.
  function refresh() {
    for (const { spec, node, kind } of reg.values()) {
      if (kind === "button") {
        const ok = spec.when ? !!spec.when(state) : true;
        node.classList.toggle("is-hidden", !ok);
        node.disabled = !ok;
      } else if (kind === "toggle") {
        const on = spec.active ? !!spec.active(state) : node.classList.contains("is-active");
        node.classList.toggle("is-active", on);
        node.setAttribute("aria-pressed", on ? "true" : "false");
      } else if (kind === "chip") {
        const vis = spec.visible ? !!spec.visible(state) : true;
        node.classList.toggle("is-hidden", !vis);
        node.textContent = spec.label ? spec.label(state) : "";
      }
    }
  }

  // ── ONE delegated handler — every button/toggle/chip click routes here by
  //    data-gtb (search/menu report through their own atom callbacks). ──────
  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-gtb]");
    if (!t || !root.contains(t) || t.disabled) return;
    const r = cfg.onAction?.(t.dataset.gtb, {});
    // A promise-returning action spins the button's icon until it settles — the
    // refresh button (its onAction returns reload()) rotates while reloading.
    // Floor it at one full rotation so a fast reload still reads as a spin,
    // not a flicker (the data is already in by then — this is just feedback).
    if (r && typeof r.then === "function" && !t.classList.contains("is-spinning")) {
      t.classList.add("is-spinning");
      const minSpin = new Promise((res) => setTimeout(res, 700));
      Promise.allSettled([Promise.resolve(r), minSpin]).then(() => t.classList.remove("is-spinning"));
    }
  });

  render();
  host.append(root);

  return {
    el: root,
    update: (p = {}) => {
      if ("state" in p) state = p.state;
      if (p.controls) { controls = p.controls; render(); }
      else refresh();
    },
    /** Reflect a toggle's on/off (the consumer enforces group exclusivity). */
    setActive: (id, on) => {
      const e = reg.get(id);
      if (!e) return;
      e.node.classList.toggle("is-active", !!on);
      e.node.setAttribute("aria-pressed", on ? "true" : "false");
    },
    setDisabled: (id, off) => {
      const e = reg.get(id);
      if (e?.node) e.node.disabled = !!off;
    },
    destroy: () => {
      for (const { menuHandle } of reg.values()) menuHandle?.destroy?.();
      root.remove();
    },
  };
}

register("grid-toolbar", mountGridToolbar);
