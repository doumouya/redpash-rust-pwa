/* steps-panel — the cleaning history + undo/redo (drives /:rid/steps|undo|
   redo; the canonical view is always base + replay of applied steps, undo is
   a flag flip — this panel shows exactly that).
   mountStepsPanel(host, {steps: [{kind, params, applied}], canUndo, canRedo,
   onUndo, onRedo}) */

import { el } from "../boot/dom.js";
import { button } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

function describe(step) {
  const p = step.params ?? {};
  if (p.column) return String(p.column);
  if (Array.isArray(p.cols)) return p.cols.join(", ");
  if (p.mode) return String(p.mode);
  return "";
}

export function mountStepsPanel(host, cfg) {
  const root = el("div", { class: "rp-steps" });
  const list = el("ul", { class: "rp-steps-list" });
  const undoBtn = button({ label: "Undo", size: "sm", onClick: () => cfg.onUndo?.() });
  const redoBtn = button({ label: "Redo", size: "sm", onClick: () => cfg.onRedo?.() });
  root.append(
    el(
      "div",
      { class: "rp-steps-head" },
      el("h3", { class: "rp-steps-title" }, "Cleaning steps"),
      el("div", { class: "rp-steps-actions" }, undoBtn, redoBtn)
    ),
    list
  );

  function render({ steps, canUndo, canRedo }) {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
    if (!steps?.length) {
      list.replaceChildren(el("li", { class: "rp-steps-none" }, "No steps yet — the file is untouched."));
      return;
    }
    list.replaceChildren(
      ...steps.map((s) =>
        el(
          "li",
          { class: `rp-steps-item${s.applied ? "" : " is-undone"}` },
          el("span", { class: "rp-steps-kind" }, s.kind),
          el("span", { class: "rp-steps-detail" }, describe(s))
        )
      )
    );
  }
  render(cfg);
  host.append(root);
  return { el: root, update: (p) => render({ ...cfg, ...p }), destroy: () => root.remove() };
}

register("steps-panel", mountStepsPanel);
