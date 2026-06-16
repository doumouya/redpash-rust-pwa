/* settings-form — renders REGISTRATIONS, never hand-written forms. Both
   Settings (pref registry) and Admin Console (policy registry) use this one
   renderer — the "third framework" promise: a knob registered anywhere
   appears here with zero edits to either page.
   mountSettingsForm(host, {defs, get(key), set(key,value)}) — defs from
   listPrefs()/listPolicies(); grouped by def.group in registration order. */

import { el } from "../boot/dom.js";
import { input } from "../atoms/atoms.js";
import { mountField } from "../field/field.js";
import { mountSelect } from "../select/select.js";
import { register } from "../registry/component-registry.js";

function controlFor(def, current, set) {
  if (def.control === "select") {
    const host = el("span");
    mountSelect(host, {
      options: def.options ?? [],
      value: current ?? def.default,
      onChange: (v) => set(def.key, v),
    });
    return host;
  }
  if (def.control === "toggle") {
    const box = el("input", { type: "checkbox" });
    box.checked = current ?? def.default ?? false;
    box.addEventListener("change", () => set(def.key, box.checked));
    return box;
  }
  // text (default)
  return input({
    value: current ?? def.default ?? "",
    onEnter: (v) => set(def.key, v),
  });
}

export function mountSettingsForm(host, cfg) {
  const root = el("div", { class: "rp-sform" });

  function render() {
    const groups = new Map();
    for (const def of cfg.defs) {
      const g = def.group ?? "General";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(def);
    }
    root.replaceChildren(
      ...[...groups.entries()].map(([group, defs]) => {
        const rows = el("div", { class: "rp-sform-rows" });
        for (const def of defs) {
          const row = el("div", { class: "rp-sform-row" });
          mountField(row, {
            label: def.label,
            inline: true,
            bare: true,
            control: controlFor(def, cfg.get(def.key), cfg.set),
          });
          rows.append(row);
        }
        return el(
          "section",
          { class: "rp-sform-group", "data-group": group },
          el("h3", { class: "rp-sform-group-title" }, group),
          rows
        );
      })
    );
  }
  render();
  host.append(root);
  return {
    el: root,
    update: (p) => {
      if (p.defs) cfg.defs = p.defs;
      render();
    },
    destroy: () => root.remove(),
  };
}

register("settings-form", mountSettingsForm);
