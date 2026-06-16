/* score-badge — the cleanness score (the product's headline number) with a
   click-open breakdown of the sub-components.
   mountScoreBadge(host, {score, report?: {completeness, type_consistency,
   value_hygiene, row_uniqueness, structural}}) */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

function toneFor(score) {
  if (score >= 90) return "ok";
  if (score >= 70) return "warn";
  return "danger";
}

const REPORT_LABELS = {
  completeness: "Completeness",
  type_consistency: "Type consistency",
  value_hygiene: "Value hygiene",
  row_uniqueness: "Row uniqueness",
  structural: "Structure gate",
};

export function mountScoreBadge(host, cfg) {
  const wrap = el("span", { class: "rp-score" });
  const pill = el("button", { class: "rp-score-pill", type: "button" });
  const pop = el("div", { class: "rp-score-pop" });

  function render({ score, report }) {
    pill.className = `rp-score-pill is-${toneFor(score ?? 0)}`;
    pill.replaceChildren(
      el("span", {}, score == null ? "—" : String(Math.round(score))),
      el("span", { class: "rp-score-unit" }, "/100")
    );
    pop.replaceChildren(
      ...Object.entries(report ?? {}).map(([k, v]) =>
        el(
          "div",
          { class: "rp-score-row" },
          el("span", {}, REPORT_LABELS[k] ?? k),
          el("b", {}, k === "structural" ? `×${Number(v).toFixed(2)}` : String(Math.round(v)))
        )
      )
    );
    pill.disabled = !report;
  }
  render(cfg);
  pill.addEventListener("click", () => wrap.classList.toggle("is-open"));
  wrap.append(pill, pop);
  host.append(wrap);
  return { el: wrap, update: (p) => render({ ...cfg, ...p }), destroy: () => wrap.remove() };
}

register("score-badge", mountScoreBadge);
