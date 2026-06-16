/* pager — mountPager(host, {page, pages, total, onPage}) */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

export function mountPager(host, cfg) {
  const node = el("div", { class: "rp-pager" });

  function render({ page, pages, total }) {
    const btn = (label, p, opts = {}) => {
      const b = el(
        "button",
        { class: `rp-pager-btn${opts.active ? " is-active" : ""}`, type: "button", onclick: () => cfg.onPage?.(p) },
        label
      );
      if (opts.disabled) b.disabled = true;
      return b;
    };
    // numbered window of ≤5 around the current page
    const start = Math.max(1, Math.min(page - 2, pages - 4));
    const end = Math.min(pages, start + 4);
    const numbers = [];
    for (let p = start; p <= end; p++) numbers.push(btn(String(p), p, { active: p === page }));
    node.replaceChildren(
      el("span", {}, `${total.toLocaleString()} rows`),
      el(
        "span",
        { class: "rp-pager-pages" },
        btn("‹", page - 1, { disabled: page <= 1 }),
        ...numbers,
        btn("›", page + 1, { disabled: page >= pages })
      )
    );
  }
  render(cfg);
  host.append(node);
  return { el: node, update: (p) => render({ ...cfg, ...p }), destroy: () => node.remove() };
}

register("pager", mountPager);
