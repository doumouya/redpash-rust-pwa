/* grid-view — a thin COMPOSER: stacks [toolbar?] [sheet?] [redtable] in a flex
   column. It owns no behavior — it wires a grid-toolbar (optional) above a
   redtable, with an optional arbitrary "sheet" node slotted between them (a
   score badge, a banner, a steps strip). Omit `toolbar` and it is just the
   redtable (the Report-preview case). The redtable's DC1 flex-fill makes it
   take the remaining height of this column.

   mountGridView(host, {
     toolbar?: { controls, onAction, state },   // → mountGridToolbar
     table:   { ...mountRedTable cfg... },       // REQUIRED
     sheet?:  Node | null,                        // slotted between the two
   }) → { el, table, toolbar, setSheet(node|null),
          update({rows, columns, state}), destroy }

   `table` / `toolbar` are the child handles (so a consumer drives the redtable
   interaction + the toolbar state directly). update fans out: rows/columns →
   table.update, state → toolbar.update. Sole owner of .rp-gridview
   (ui-fork-audit R4). */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";
import { mountRedTable } from "../redtable/redtable.js";
import { mountGridToolbar } from "../grid-toolbar/grid-toolbar.js";

export function mountGridView(host, cfg) {
  const root = el("div", { class: "rp-gridview" });

  // toolbar (optional) — sits at the top, fixed height.
  let toolbar = null;
  if (cfg.toolbar) {
    const tbHost = el("div", { class: "rp-gridview-toolbar" });
    root.append(tbHost);
    toolbar = mountGridToolbar(tbHost, cfg.toolbar);
  }

  // sheet slot — an arbitrary node between toolbar and table (or empty).
  const sheetHost = el("div", { class: "rp-gridview-sheet" });
  root.append(sheetHost);
  function setSheet(node) {
    if (node) sheetHost.replaceChildren(node);
    else sheetHost.replaceChildren();
    sheetHost.classList.toggle("is-empty", !node);
  }
  setSheet(cfg.sheet ?? null);

  // table — REQUIRED. Lives in a flex-fill slot so DC1 makes it grow.
  const tableHost = el("div", { class: "rp-gridview-table" });
  root.append(tableHost);
  const table = mountRedTable(tableHost, cfg.table ?? { columns: [], rows: [], rowKey: (r) => String(r) });

  host.append(root);
  return {
    el: root,
    table,
    toolbar,
    setSheet,
    update: (p = {}) => {
      const t = {};
      if ("rows" in p) t.rows = p.rows;
      if ("columns" in p) t.columns = p.columns;
      if (Object.keys(t).length) table.update(t);
      if ("state" in p) toolbar?.update({ state: p.state });
    },
    destroy: () => {
      toolbar?.destroy();
      table.destroy();
      root.remove();
    },
  };
}

register("grid-view", mountGridView);
