/* redtable — THE data table. ONE implementation; virtual and pager modes are
   config on the same component (the predecessor's fork-A/B duality is
   banned). Data col-keys ONLY (no display-index sentinels); rowKey REQUIRED
   (selection lives in closure state keyed by rowKey, never on recycled DOM).
   Sortable headers (config) emit onSort(col); the CONSUMER cycles the direction
   and re-fetches a server-sorted page (the backend's QuerySpec.sort) — the
   chevron only ever reflects a real server order, never a no-op.

   TWO independent axes, composed on the one component:
     mode        — LAYOUT: auto | virtual | pager (how many rows render).
     interaction — BEHAVIOR: browse | select | edit | delete (what a click does).
   A select-mode virtual table, an edit-mode pager table, etc. all work.

   mountRedTable(host, {
     columns: [{key, label, dtype?, editor?}], // data keys, never indices
     rows: [...],                          // array of objects
     rowKey: (row) => string,              // REQUIRED
     mode?: "auto" | "virtual" | "pager",  // auto: virtual past 200 rows
     pageSize?: 50,
     interaction?: "browse"|"select"|"edit"|"delete",  // default "browse"
     onRowClick?,                          // (row,key) every interaction
     onSelectChange?(keys[]),              // select: the selection set changed
     onRowDelete?(rowKey),                 // delete: a row was clicked
     onCellCommit?(rowKey, colKey, value), // edit: a cell editor committed
     selectable?: bool,                    // legacy alias for interaction:"select"
     sortable?: bool,                      // clickable headers → onSort(col)
     sort?: {col, descending} | null,      // the active sort (drives the chevron)
     onSort?(col),                         // header clicked — consumer owns the cycle
     rowNumbers?: bool,                    // a leading #-column (1-based view position)
     empty?: {title, line, action?},       // empty-state config
   }) → handle { el, update({rows,columns,sort}), selection(), setInteraction(m),
                 clearSelection(), destroy }                                */

import { el, esc } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";
import { mountEmptyState } from "../empty-state/empty-state.js";
import { mountPager } from "../pager/pager.js";
import { createVirtualRows } from "./virtual-rows.js";
import { editorFor } from "./editor-registry.js";

const AUTO_VIRTUAL_AT = 200;

function cellHTML(row, col) {
  const v = row[col.key];
  if (v == null || v === "") return `<span class="rp-redtable-null">—</span>`;
  return esc(v);
}

export function mountRedTable(host, cfg) {
  if (typeof cfg.rowKey !== "function") {
    throw new Error("redtable: rowKey(row) is required");
  }
  let rows = cfg.rows ?? [];
  // legacy selectable: bool → the select interaction (one behavior, two names).
  let interaction = cfg.interaction ?? (cfg.selectable ? "select" : "browse");
  const selected = new Set(); // rowKey strings — never DOM state
  let activeEditor = null; // {commit, cancel, el} while a cell is being edited

  const root = el("div", { class: "rp-redtable" });
  const scroll = el("div", { class: "rp-redtable-scroll" });
  const table = el("table");
  const thead = el("thead");
  const tbody = el("tbody");
  table.append(thead, tbody);
  scroll.append(table);
  root.append(scroll);
  const foot = el("div", { class: "rp-redtable-foot" });
  let footMounted = false;

  let virt = null;
  let page = 1;
  const pageSize = cfg.pageSize ?? 50;
  let emptyHandle = null;

  // ── interaction state class on the root (CSS keys the checkbox col, the
  //    editing-cell inset and the delete-mode hover off these). ────────────
  function applyInteractionClass() {
    root.classList.toggle("is-select", interaction === "select");
    root.classList.toggle("is-edit", interaction === "edit");
    root.classList.toggle("is-delete", interaction === "delete");
  }

  function mode() {
    if (cfg.mode && cfg.mode !== "auto") return cfg.mode;
    return rows.length > AUTO_VIRTUAL_AT ? "virtual" : "pager";
  }

  // span across the FULL row incl. the select checkbox column when present.
  function colCount() {
    return cfg.columns.length + (interaction === "select" ? 1 : 0) + (cfg.rowNumbers ? 1 : 0);
  }

  function renderHead() {
    const ths = cfg.columns.map((c) => {
      if (!cfg.sortable) return el("th", { scope: "col" }, c.label ?? c.key);
      // sortable: clickable header + a chevron showing this column's sort state
      // (expand = unsorted, up = ascending, down = descending).
      const sorted = cfg.sort && cfg.sort.col === c.key;
      const chev = !sorted ? "bi-chevron-expand" : cfg.sort.descending ? "bi-chevron-down" : "bi-chevron-up";
      return el("th",
        { scope: "col", class: `rp-redtable-th-sort${sorted ? " is-sorted" : ""}`, "data-col": c.key },
        c.label ?? c.key,
        el("i", { class: `rp-redtable-sort bi ${chev}`, "aria-hidden": "true" }));
    });
    const lead = [];
    if (cfg.rowNumbers) lead.push(el("th", { class: "rp-redtable-rownum", scope: "col" }, "#"));
    if (interaction === "select") {
      // a select-all checkbox heads the leading column.
      lead.push(el("th", { class: "rp-redtable-check-cell", scope: "col" },
        el("input", { type: "checkbox", class: "rp-redtable-check rp-redtable-check-all",
          "aria-label": "Select all" })));
    }
    thead.replaceChildren(el("tr", {}, ...lead, ...ths));
    syncSelectAll();
  }

  function rowEl(row, absIndex = 0) {
    const key = cfg.rowKey(row);
    const tr = el("tr", { "data-key": key });
    if (selected.has(key)) tr.classList.add("is-selected");
    const cells = cfg.columns
      .map((c) => `<td data-col="${esc(c.key)}"${c.dtype === "int" || c.dtype === "float" ? ' class="rp-redtable-num"' : ""}>${cellHTML(row, c)}</td>`)
      .join("");
    // a leading row-number and/or select-checkbox cell forces the node path
    // (tr.innerHTML would wipe them); a plain row keeps the fast innerHTML path.
    const hasLead = cfg.rowNumbers || interaction === "select";
    if (!hasLead) {
      tr.innerHTML = cells;
      return tr;
    }
    if (cfg.rowNumbers) {
      tr.append(el("td", { class: "rp-redtable-rownum" }, String(absIndex + 1)));
    }
    if (interaction === "select") {
      const check = el("td", { class: "rp-redtable-check-cell" },
        el("input", { type: "checkbox", class: "rp-redtable-check", "aria-label": "Select row" }));
      check.firstChild.checked = selected.has(key);
      tr.append(check);
    }
    const holder = el("template");
    holder.innerHTML = cells;
    tr.append(holder.content);
    return tr;
  }

  function paint() {
    virt?.destroy();
    virt = null;
    emptyHandle?.destroy();
    emptyHandle = null;

    if (!rows.length) {
      tbody.replaceChildren();
      foot.replaceChildren();
      if (cfg.empty) {
        const holder = el("td", { colspan: String(colCount()) });
        emptyHandle = mountEmptyState(holder, cfg.empty);
        tbody.append(el("tr", {}, holder));
      }
      return;
    }

    if (mode() === "virtual") {
      foot.replaceChildren(); // virtual mode scrolls; no pager
      const rowHeight = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.25;
      virt = createVirtualRows({
        scrollHost: scroll,
        tbody,
        rowCount: rows.length,
        rowHeight,
        renderRow: (i) => rowEl(rows[i], i),
      });
    } else {
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      page = Math.min(page, pages);
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      tbody.replaceChildren(...slice.map((r, j) => rowEl(r, (page - 1) * pageSize + j)));
      foot.replaceChildren();
      mountPager(foot, {
        page,
        pages,
        total: rows.length,
        onPage: (p) => {
          page = p;
          paint();
        },
      });
      if (!footMounted) {
        root.append(foot);
        footMounted = true;
      }
    }
    syncSelectAll();
  }

  // ── select-all tri-state: checked when every VISIBLE-data row is selected,
  //    indeterminate when some are. Keyed by the full row set (selection is a
  //    closure Set, not DOM state). ─────────────────────────────────────────
  function syncSelectAll() {
    const box = thead.querySelector(".rp-redtable-check-all");
    if (!box) return;
    const total = rows.length;
    const n = selected.size;
    box.checked = total > 0 && n === total;
    box.indeterminate = n > 0 && n < total;
  }

  function emitSelection() {
    cfg.onSelectChange?.([...selected]);
  }

  // ── ONE delegated listener on tbody (survives repaint + virtual recycling),
  //    routed by the current interaction. ───────────────────────────────────
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-key]");
    if (!tr) return;
    const key = tr.dataset.key;
    const row = rows.find((r) => cfg.rowKey(r) === key);

    if (interaction === "edit") {
      const td = e.target.closest("td[data-col]");
      if (td) beginEdit(td, row);
      cfg.onRowClick?.(row, key);
      return;
    }
    if (interaction === "delete") {
      cfg.onRowDelete?.(key);
      cfg.onRowClick?.(row, key);
      return;
    }
    if (interaction === "select") {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      tr.classList.toggle("is-selected", selected.has(key));
      const box = tr.querySelector(".rp-redtable-check");
      if (box) box.checked = selected.has(key);
      syncSelectAll();
      emitSelection();
    }
    cfg.onRowClick?.(row, key);
  });

  // ── select-all head checkbox — one listener on thead. Selects/clears EVERY
  //    row (the whole set, not just the rendered window). ───────────────────
  thead.addEventListener("click", (e) => {
    const box = e.target.closest(".rp-redtable-check-all");
    if (box) {
      if (box.checked) for (const r of rows) selected.add(cfg.rowKey(r));
      else selected.clear();
      // reflect onto the rendered rows without a full repaint.
      for (const tr of tbody.querySelectorAll("tr[data-key]")) {
        const on = selected.has(tr.dataset.key);
        tr.classList.toggle("is-selected", on);
        const c = tr.querySelector(".rp-redtable-check");
        if (c) c.checked = on;
      }
      syncSelectAll();
      emitSelection();
      return;
    }
    // sortable header click → report the column; the consumer owns the cycle
    // (asc → desc → off) + the re-fetch, then reflects it via update({sort}).
    if (cfg.sortable) {
      const th = e.target.closest("th[data-col]");
      if (th) cfg.onSort?.(th.dataset.col);
    }
  });

  // ── edit mode: swap the clicked cell for its registered editor; the editor
  //    commits via onCellCommit(rowKey, colKey, value). Only ONE cell edits at
  //    a time (committing the previous first). ──────────────────────────────
  function beginEdit(td, row) {
    if (activeEditor) { activeEditor.commit(); activeEditor = null; }
    const colKey = td.dataset.col;
    const col = cfg.columns.find((c) => c.key === colKey);
    if (!col) return;
    const key = cfg.rowKey(row);
    const factory = editorFor(col);
    activeEditor = factory(td, {
      value: row[colKey],
      onCommit: (value) => {
        activeEditor = null;
        cfg.onCellCommit?.(key, colKey, value);
      },
    }) ?? null;
  }

  applyInteractionClass();
  renderHead();
  paint();
  host.append(root);

  return {
    el: root,
    update: (p) => {
      if (p.rows) {
        rows = p.rows;
        page = 1;
        // a row set change can orphan selected keys — keep only the ones that
        // still exist (selection is keyed by rowKey, the source of truth).
        if (selected.size) {
          const live = new Set(rows.map((r) => cfg.rowKey(r)));
          for (const k of [...selected]) if (!live.has(k)) selected.delete(k);
        }
      }
      if ("sort" in p) cfg.sort = p.sort;
      if ("rowNumbers" in p) cfg.rowNumbers = p.rowNumbers;
      if (p.columns) cfg.columns = p.columns;
      if (p.columns || "sort" in p || "rowNumbers" in p) renderHead();
      paint();
    },
    selection: () => [...selected],
    clearSelection: () => {
      selected.clear();
      for (const tr of tbody.querySelectorAll("tr.is-selected")) {
        tr.classList.remove("is-selected");
        const c = tr.querySelector(".rp-redtable-check");
        if (c) c.checked = false;
      }
      syncSelectAll();
      emitSelection();
    },
    /** Flip the interaction axis live (browse↔select↔edit↔delete). Re-renders
     *  head + body so the checkbox column appears/disappears in one pass. */
    setInteraction: (m) => {
      if (m === interaction) return;
      if (activeEditor) { activeEditor.cancel(); activeEditor = null; }
      interaction = m;
      applyInteractionClass();
      renderHead();
      paint();
    },
    destroy: () => {
      virt?.destroy();
      root.remove();
    },
  };
}

register("redtable", mountRedTable);
