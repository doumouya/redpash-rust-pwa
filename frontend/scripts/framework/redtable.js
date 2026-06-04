/* Purpose: Converged RedTable framework component — the interactive data table (sort/select/edit/delete/reorder/virtualization) over the rp-table base.
   Doc: docs/internal/code/frontend/scripts/framework/redtable.md */
// ── RedTable (framework component, CAS_37B2E1BF / B3.1) ──────────────────────
// The centerpiece interactive data table. ONE mountRedTable(host, config)
// parameterized over the two legacy DATA-table forks that diverged in the live
// app:
//   • FORK A — workspace grid (#wsTable): multi-key sort by column INDEX, raw
//     contenteditable inline edit, selection keyed by row INDEX, virtualization
//     ON, no column reorder.
//   • FORK B — home/monitoring list views: single-key 3-state sort by data
//     col-key, cell-editor.js inline edit, selection keyed by rid, no
//     virtualization (paged), column drag-reorder ON.
// (Fork C — the tools-panel column MANAGER table — is NOT part of rp-redtable;
// it is the B3.3 tools panel and is intentionally not folded in here.)
//
// Composes, does NOT duplicate:
//   • rp-table base (styles/framework/table.css) — width/collapse/tabular-nums,
//     sticky thead, tbody tr content-visibility, .is-selected, cell kinds,
//     rp-table-wrap. The interactive layers (.rp-redtable-* + state classes)
//     sit ON TOP and are styled by styles/framework/redtable.css.
//   • priorityDotHTML (framework/table.js) — the priority-dot cell glyph.
//   • the simple-table cell renderers (kind: status→rp-status, id→rp-mono-pill,
//     priority→rp-priority-dot) — replicated minimally (table.js does not
//     export cellHTML), behaviour-identical to mountSimpleTable.
//   • createVirtualRows (scripts/framework/virtual-rows.js) — the windowing controller,
//     driven only when config.virtual is set. renderRow stays a PURE synchronous
//     string builder so the hot scroll loop never picks up per-row async work.
//   • cellEditor (framework/cell-editor.js) — the inline-edit orchestrator,
//     composed only when config.edit.host === "cell-editor". Raw contenteditable
//     (fork A) is handled inline by focusin/focusout commit; the editor-registry
//     dispatch is NOT re-implemented here.
//
// MODES are mutually exclusive — setMode("view"|"select"|"edit"|"delete")
// toggles exactly ONE of .mode-select/.mode-edit/.mode-delete on the table
// (default "view" = none). The CSS (redtable.css) reacts to these classes.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";
import { priorityDotHTML } from "/scripts/framework/table.js";
import { createVirtualRows } from "/scripts/framework/virtual-rows.js";
import { cellEditor } from "/scripts/framework/cell-editor.js";

// The hard-coded tbody id the legacy cell-editor.decorate() queries. Emitted on
// the tbody so a cell-editor build that still uses the legacy selector keeps
// working; the parameterized-selector path (tbody/thead elements passed into
// decorate) is preferred once the cell-editor seam exposes it.
const CELL_EDITOR_TBODY_ID = "rp-home-list-tbody";

const MODE_CLASSES = ["mode-select", "mode-edit", "mode-delete"];

// Date semantic dtypes that flow into a date-aware sort spec (fork A). The
// thead tags date columns with data-type="date" without re-importing the
// workspace's dtype catalogue.
const DATE_DTYPES = new Set(["date", "datetime", "timestamp"]);

// ── config shape ─────────────────────────────────────────────────────────────
//   columns : [{ key, label, kind, sortable, editable, editKey, hidden, align,
//                editor, options, render, rel, requiresAdmin, placeholder,
//                trunc, prefix, semantic_dtype }]
//                kind ∈ undefined|"text"|"num"|"status"|"priority"|"id"
//   rows    : [ … ]                          one item per row (object or array)
//   rowKey  : (row, i) => string             selection/edit identity.
//                                            default (row,i)=>String(i) (fork A);
//                                            fork B passes r => r.rid
//   sort    : { multi:bool, onSort(keys) } | null
//                                            keys=[{key,dir}]; multi=A, single=B
//   select  : { onChange(Set) } | null       adds leading checkbox column
//   rownum  : bool                           adds leading row-number column
//   edit    : { host:"contenteditable"|"cell-editor", onCommit(rowKey,colKey,value),
//               spec?, chipRender?, isPlatformAdmin?, api? } | null
//   del     : { onDelete(rowKey) } | null     delete-mode: click a row to delete
//   reorder : { onReorder(orderedKeys) } | null   column drag-reorder
//   virtual : { rowHeight, overscan } | null  ON => compose createVirtualRows
//   empty   : string                          no-rows placeholder text
//   getCell : (row, col, i) => any            override the per-cell value read
//                                            (default: object row[col.key] or
//                                            array row[colIndex]).

/** Build + wire the redtable into `host`. `host` becomes the `.rp-table-wrap`
 *  scroll container holding <table class="rp-redtable rp-table">. Returns the
 *  controller { el, setRows, setColumns, setMode, refresh, getSelection,
 *  destroy }. */
export function mountRedTable(host, config = {}) {
  if (!host) return null;

  // ── live state (NEVER on the DOM — rows recycle under virtualization) ──────
  let columns = (config.columns || []).slice();
  let rows = config.rows || [];
  let mode = "view";                               // view|select|edit|delete
  let sortKeys = [];                               // [{ key, dir }] (dir 1|-1)
  const selected = new Set();                      // rowKey strings
  let vrows = null;

  const rowKey = typeof config.rowKey === "function"
    ? config.rowKey
    : (_row, i) => String(i);

  const getCellValue = typeof config.getCell === "function"
    ? config.getCell
    : (row, col, i) => (Array.isArray(row) ? row[i] : (row ? row[col.key] : undefined));

  // The cell-editor seam maps spec columns to TD positions with a single
  // leading-sentinel offset (selectMode ? 1 : 0). A row-number column would add
  // a SECOND leading sentinel the +1 mapping doesn't account for, so the editor
  // would attach to the wrong cell. Guard the unsupported combination.
  if (config.rownum && config.edit && config.edit.host === "cell-editor") {
    console.warn("[redtable] rownum + cell-editor edit is unsupported — the "
      + "cell-editor's single-sentinel offset accounts for the selection column "
      + "only; the row-number column shifts the cell map off-by-one.");
  }

  // ── DOM scaffold — host = .rp-table-wrap, table = .rp-redtable.rp-table ─────
  host.classList.add("rp-table-wrap");
  host.innerHTML =
    '<table class="rp-redtable rp-table">'
    + "<thead></thead>"
    + '<tbody id="' + CELL_EDITOR_TBODY_ID + '"></tbody>'
    + "</table>";

  const table = host.querySelector("table.rp-redtable");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  // ── visible (non-hidden) columns — the rendered column set ─────────────────
  function visibleColumns() {
    return columns.filter((c) => !c.hidden);
  }

  // The count of leading sentinel columns (sel checkbox + rownum). Used to keep
  // sort col-indexing data-driven instead of the legacy +2/+3 magic offset.
  function leadingSentinels() {
    return (config.select ? 1 : 0) + (config.rownum ? 1 : 0);
  }

  // ── cell rendering (kind → composed atom/glyph; behaviour-identical to
  //    mountSimpleTable.cellHTML — replicated, not re-implemented as a fork) ──
  function cellHTML(col, row, i) {
    const raw = getCellValue(row, col, i);
    switch (col.kind) {
      case "priority":
        return priorityDotHTML(raw, raw);
      case "status": {
        const toneRaw = !Array.isArray(row) && row ? row[col.key + "Tone"] : undefined;
        return '<span class="rp-status' + (toneRaw ? " " + esc(toneRaw) : "") + '">'
          + esc(raw == null ? "" : String(raw)) + "</span>";
      }
      case "id":
        return '<span class="rp-mono-pill">' + esc(raw == null ? "" : String(raw)) + "</span>";
      default:
        return esc(raw == null ? "" : String(raw));
    }
  }

  // ── thead ──────────────────────────────────────────────────────────────────
  function sortMetaFor(key) {
    const idx = sortKeys.findIndex((k) => k.key === key);
    return idx === -1 ? null : { dir: sortKeys[idx].dir, ord: idx + 1 };
  }

  function headCellHTML(col) {
    const align = col.align || (col.kind === "num" ? "num" : "");
    const classes = [];
    if (align === "num") classes.push("is-num");
    const sortable = config.sort && col.sortable !== false;
    if (sortable) classes.push("is-sortable");   // matches redtable.css's converged header class
    const meta = sortable ? sortMetaFor(col.key) : null;
    if (meta) classes.push("is-sorted", meta.dir > 0 ? "is-asc" : "is-desc");
    const cls = classes.length ? ' class="' + classes.join(" ") + '"' : "";
    const draggable = config.reorder ? ' draggable="true"' : "";
    // data-col-key is the logical id every interactive layer keys off (sort,
    // reorder, the cell-editor seam's keyToPos map). Always emitted.
    const key = ' data-col-key="' + esc(col.key) + '"';
    const dateType = col.semantic_dtype && DATE_DTYPES.has(col.semantic_dtype)
      ? ' data-type="date"' : "";
    // Direction glyph — two converged styles per config.sort.indicator:
    //   "chevron" (default, workspace): the <i> class itself shows direction
    //     (bi-chevron-up|down on the active key, bi-chevron-expand unsorted) +
    //     the multi-key order superscript.
    //   "icon" (list): a .rp-redtable-sort-icon whose direction is the CSS
    //     ::before glyph keyed on the TH's .is-asc/.is-desc (set via meta above).
    const dir = meta ? (meta.dir > 0 ? "up" : "down") : "expand";
    const sortGlyph = !sortable ? ""
      : config.sort.indicator === "icon"
        ? '<i class="rp-redtable-sort-icon bi"></i>'
        : '<i class="rp-redtable-sort bi bi-chevron-' + dir + '"></i>'
          + (meta && config.sort.multi && sortKeys.length > 1
              ? '<sup class="rp-redtable-sort-ord">' + meta.ord + "</sup>"
              : "");
    return "<th" + cls + key + draggable + dateType + ">"
      + esc(col.label || col.key || "")
      + sortGlyph
      + "</th>";
  }

  function renderHead() {
    const cols = visibleColumns();
    const sel = config.select
      ? '<th class="rp-redtable-col-sel">'
        + '<input type="checkbox" class="rp-redtable-chk" data-sel-all />'
        + "</th>"
      : "";
    const rownum = config.rownum ? '<th class="rp-redtable-col-rownum">#</th>' : "";
    const reorderSentinel = config.reorder
      ? '<th class="rp-redtable-hide-th" aria-hidden="true"></th>' : "";
    thead.innerHTML = "<tr>"
      + sel + rownum
      + cols.map(headCellHTML).join("")
      + reorderSentinel
      + "</tr>";
  }

  // ── renderRow — PURE synchronous string builder (the virtualization hot
  //    loop runs this per windowed row every scroll frame; no async, no extra
  //    escaping passes, reads live state from the closure Sets/mode) ──────────
  function renderRow(row, i) {
    const key = rowKey(row, i);
    const isSel = selected.has(key);
    const ce = mode === "edit" && config.edit && config.edit.host === "contenteditable"
      ? ' contenteditable="true"' : "";
    const cols = visibleColumns();
    // The cell-editor seam (cellEditor.decorate) finds rows via tr[data-rid].
    // For the cell-editor host, rowKey IS the rid (fork B passes r=>r.rid), so
    // we mirror it into data-rid; cellEditor.save also reads tr.dataset.rowKey
    // as the PATCH rid. data-row-key stays the universal selection identity.
    const ridAttr = config.edit && config.edit.host === "cell-editor"
      ? ' data-rid="' + esc(String(key)) + '"' : "";
    let html = "<tr data-row-key=\"" + esc(String(key)) + "\"" + ridAttr
      + (isSel ? ' class="is-selected"' : "") + ">";
    if (config.select) {
      html += '<td class="rp-redtable-col-sel">'
        + '<input type="checkbox" class="rp-redtable-chk"' + (isSel ? " checked" : "") + " />"
        + "</td>";
    }
    if (config.rownum) {
      html += '<td class="col-n rp-redtable-col-rownum">' + (i + 1) + "</td>";
    }
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      const raw = getCellValue(row, col, i);
      const editable = config.edit && col.editable;
      const tdCls = [];
      if (col.kind === "num" || col.align === "num") tdCls.push("is-num");
      if (raw == null) tdCls.push("cell-muted");
      if (editable) tdCls.push("editable");
      const clsAttr = tdCls.length ? ' class="' + tdCls.join(" ") + '"' : "";
      // cell-editor host: emit the editor data contract the registered editors
      // read (editor-text/chip-enum/entity-picker all read data-full; text also
      // re-truncates from it on exit). data-full defaults to the raw value; a
      // column can override via col.full(row,i). label/trunc/prefix are added by
      // the consumer's column spec when wiring fork-B (build-ready).
      let dataAttrs = "";
      if (editable && config.edit.host === "cell-editor") {
        const full = typeof col.full === "function" ? col.full(row, i) : raw;
        dataAttrs = ' data-full="' + esc(full == null ? "" : String(full)) + '"';
      }
      html += "<td" + clsAttr + ' data-col-key="' + esc(col.key) + '"' + dataAttrs + ce + ">"
        + cellHTML(col, row, i) + "</td>";
    }
    if (config.reorder) html += '<td class="rp-redtable-hide-cell" aria-hidden="true"></td>';
    html += "</tr>";
    return html;
  }

  // ── tbody render — virtual (windowed) OR full (all rows) ───────────────────
  function renderBody() {
    if (config.virtual) {
      if (!vrows) {
        vrows = createVirtualRows({
          scroller: host,
          tbody,
          rowHeight: config.virtual.rowHeight || 36,
          overscan: config.virtual.overscan,
          renderRow,
          // Don't recycle a mid-edit cell. Cover both edit hosts: the raw
          // contenteditable cell (fork A) and the cell-editor widgets
          // (select.rp-cell-edit-select / input.rp-cell-edit-input, fork B).
          pauseWhile: () => {
            const a = document.activeElement;
            return !!a && tbody.contains(a)
              && (a.isContentEditable
                || a.closest("td.editable"));
          },
        });
      }
      vrows.setRows(rows);
      // Adapt the row-height estimate from the first REAL row (density-aware),
      // skipping the virtualizer's spacer rows.
      const firstReal = tbody.querySelector("tr:not(.rp-redtable-spacer)");
      if (firstReal) {
        const h = firstReal.getBoundingClientRect().height;
        if (h > 0 && Math.abs(h - vrows.rowHeight) > 0.5) vrows.remeasure(h);
      }
    } else {
      if (!rows.length) {
        tbody.innerHTML = "";
        return;
      }
      tbody.innerHTML = rows.map((r, i) => renderRow(r, i)).join("");
    }
  }

  // Re-render the body in place after a selection / mode / value change so
  // recycled (or static) rows reflect the live state via renderRow.
  function refreshBody() {
    if (config.virtual && vrows) vrows.refresh();
    else if (!config.virtual) {
      if (!rows.length) { tbody.innerHTML = ""; return; }
      tbody.innerHTML = rows.map((r, i) => renderRow(r, i)).join("");
    }
  }

  // The empty placeholder (shown only when there are no rows). Composes the
  // rp-empty atom; lives as a sibling of the table inside the wrap.
  function syncEmpty() {
    let el = host.querySelector(".rp-table-empty");
    if (!rows.length && config.empty) {
      if (!el) {
        el = document.createElement("p");
        el.className = "rp-empty rp-table-empty";
        host.appendChild(el);
      }
      el.textContent = config.empty;
      table.hidden = true;
    } else {
      if (el) el.remove();
      table.hidden = false;
    }
  }

  // ── cell-editor seam — compose the framework orchestrator (fork B) ─────────
  // Runs the strip (always) + activate (in edit mode). Passes tableRoot (our
  // <table class="rp-redtable">) so cellEditor.decorate derives the tbody +
  // "thead tr" + tr[data-rid] FROM it (the seam's parameterized-selector path),
  // not the legacy ".rt-table"/"#rp-home-list-tbody" lookups. selectMode feeds
  // the +1 leading-sentinel offset — so the cell-editor host pairs with the
  // select column only (NOT rownum, which would add a second leading sentinel
  // the seam's single-offset mapping doesn't account for).
  function decorateCellEditor() {
    if (!config.edit || config.edit.host !== "cell-editor") return;
    cellEditor.decorate({
      view: host,
      tableRoot: table,
      spec: config.edit.spec || { columns },
      editMode: mode === "edit",
      selectMode: !!config.select,
      isPlatformAdmin: !!config.edit.isPlatformAdmin,
      chipRender: config.edit.chipRender,
    });
  }

  // ── selection helpers (keyed by rowKey, NOT the DOM) ───────────────────────
  function emitSelection() {
    config.select && config.select.onChange && config.select.onChange(new Set(selected));
  }

  function syncSelectAll() {
    const box = thead.querySelector("input[data-sel-all]");
    if (!box) return;
    const total = rows.length;
    const n = selected.size;
    box.checked = total > 0 && n === total;
    box.indeterminate = n > 0 && n < total;
  }

  // ── sort (single 3-state for B; multi shift-add for A) ─────────────────────
  function applySortClick(key, shift) {
    if (!config.sort) return;
    const multi = !!config.sort.multi;
    const idx = sortKeys.findIndex((k) => k.key === key);
    if (multi && shift) {
      // shift-click: add the key, or flip its dir if already present.
      if (idx === -1) sortKeys.push({ key, dir: 1 });
      else sortKeys[idx].dir = -sortKeys[idx].dir;
    } else if (multi) {
      // plain click in multi mode: single key asc, flip if it's the only key.
      if (idx === 0 && sortKeys.length === 1) sortKeys[0].dir = -sortKeys[0].dir;
      else sortKeys = [{ key, dir: 1 }];
    } else {
      // single 3-state cycle: (none) → desc → asc → clear (fork B semantics).
      if (idx === -1) sortKeys = [{ key, dir: -1 }];
      else if (sortKeys[0].dir < 0) sortKeys = [{ key, dir: 1 }];
      else sortKeys = [];
    }
    renderHead();
    config.sort.onSort && config.sort.onSort(sortKeys.map((k) => ({ key: k.key, dir: k.dir })));
  }

  // ── column drag-reorder (B) — insertBefore the trailing sentinel ───────────
  // ([[sentinel-columns-in-reorder]]): NEVER appendChild in a loop — that would
  // walk a trailing sentinel (rp-redtable-hide-th/cell) out of last position.
  let dragKey = null;
  function clearDropMarks() {
    thead.querySelectorAll(".is-drop-before, .is-drop-after")
      .forEach((th) => th.classList.remove("is-drop-before", "is-drop-after"));
  }

  function reorderColumns(fromKey, toKey, after) {
    if (fromKey === toKey) return;
    const order = visibleColumns().map((c) => c.key);
    const fromI = order.indexOf(fromKey);
    if (fromI === -1) return;
    order.splice(fromI, 1);
    let toI = order.indexOf(toKey);
    if (toI === -1) return;
    if (after) toI += 1;
    order.splice(toI, 0, fromKey);
    // Re-sort the FULL columns list (incl. hidden) to honor the new visible
    // order; hidden columns keep their relative slots after the visible run.
    const rank = new Map(order.map((k, i) => [k, i]));
    columns.sort((a, b) => {
      const ra = rank.has(a.key) ? rank.get(a.key) : Infinity;
      const rb = rank.has(b.key) ? rank.get(b.key) : Infinity;
      return ra - rb;
    });
    renderHead();
    renderBody();
    decorateCellEditor();
    config.reorder.onReorder && config.reorder.onReorder(order.slice());
  }

  // ── delegated handlers on the table root (survive tbody re-render) ─────────
  // thead click → sort.
  thead.addEventListener("click", (e) => {
    const th = e.target.closest("th.is-sortable");
    if (!th || !thead.contains(th)) return;
    applySortClick(th.dataset.colKey, e.shiftKey);
  });

  // thead change → select-all.
  thead.addEventListener("change", (e) => {
    const box = e.target.closest("input[data-sel-all]");
    if (!box) return;
    if (box.checked) rows.forEach((r, i) => selected.add(rowKey(r, i)));
    else selected.clear();
    refreshBody();
    decorateCellEditor();   // refreshBody re-renders tbody; re-attach editors (symmetry with refresh())
    syncSelectAll();
    emitSelection();
  });

  // tbody change → per-row selection.
  tbody.addEventListener("change", (e) => {
    const chk = e.target.closest(".rp-redtable-chk");
    if (!chk) return;
    const tr = chk.closest("tr[data-row-key]");
    if (!tr) return;
    const key = tr.dataset.rowKey;
    if (chk.checked) selected.add(key);
    else selected.delete(key);
    tr.classList.toggle("is-selected", chk.checked);
    syncSelectAll();
    emitSelection();
  });

  // tbody click → delete-mode row delete.
  tbody.addEventListener("click", (e) => {
    if (mode !== "delete" || !config.del) return;
    const tr = e.target.closest("tr[data-row-key]");
    if (!tr || !tbody.contains(tr)) return;
    config.del.onDelete && config.del.onDelete(tr.dataset.rowKey);
  });

  // ── inline edit — raw contenteditable commit (fork A) ──────────────────────
  if (config.edit && config.edit.host === "contenteditable") {
    tbody.addEventListener("focusin", (e) => {
      if (mode !== "edit") return;
      const td = e.target.closest("td.editable");
      if (!td) return;
      td.dataset.editOriginal = td.textContent;
    });
    tbody.addEventListener("keydown", (e) => {
      if (mode !== "edit") return;
      const td = e.target.closest("td.editable");
      if (!td) return;
      if (e.key === "Enter") { e.preventDefault(); td.blur(); }
      else if (e.key === "Escape") {
        e.preventDefault();
        td.textContent = td.dataset.editOriginal ?? "";
        td.blur();
      }
    });
    tbody.addEventListener("focusout", (e) => {
      if (mode !== "edit") return;
      const td = e.target.closest("td.editable");
      if (!td) return;
      const tr = td.closest("tr[data-row-key]");
      const value = td.textContent.trim();
      const original = (td.dataset.editOriginal ?? "").trim();
      if (value === original) return;                 // no-op guard
      config.edit.onCommit && config.edit.onCommit(tr.dataset.rowKey, td.dataset.colKey, value);
    });
  }

  // ── inline edit — cell-editor seam commit (fork B) ─────────────────────────
  // The interaction layer (focusin snapshot / Enter-Esc / focusout+change
  // commit) is part of the seam contract; the framework save()/PATCH lives in
  // cell-editor.js. Page side-effects (undo/redo/log) stay in the caller via
  // edit.onCommit, which receives the cellEditor.save() result.
  if (config.edit && config.edit.host === "cell-editor") {
    const editApi = config.edit.api;
    const editSpec = () => config.edit.spec || { columns };

    tbody.addEventListener("focusin", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (!td) return;
      const sel = td.querySelector("select.rp-cell-edit-select");
      td.dataset.editOriginal = sel ? sel.value : td.textContent.trim();
    });
    tbody.addEventListener("keydown", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (!td) return;
      if (e.key === "Enter") {
        e.preventDefault();
        (td.querySelector("select.rp-cell-edit-select") || td).blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const sel = td.querySelector("select.rp-cell-edit-select");
        if (sel) sel.value = td.dataset.editOriginal ?? "";
        else td.textContent = td.dataset.editOriginal ?? "";
        (sel || td).blur();
      }
    });
    const commitCell = async (td) => {
      if (!editApi) return;
      const tr = td.closest("tr[data-row-key]");
      if (!tr) return;
      try {
        const result = await cellEditor.save({
          td, rid: tr.dataset.rowKey, spec: editSpec(), api: editApi,
        });
        if (result) {
          config.edit.onCommit
            && config.edit.onCommit(tr.dataset.rowKey, result.key, result.value, result);
        }
      } catch (err) {
        td.textContent = td.dataset.editOriginal ?? "";
        if (config.edit.onError) config.edit.onError(err);
        else console.warn("[redtable] cell-edit failed:", err);
      }
    };
    tbody.addEventListener("focusout", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (td) commitCell(td);
    });
    // chip-enum <select> commits immediately on change (no wait-for-blur); the
    // no-op guard in cellEditor.save() prevents the duplicate PATCH focusout
    // would otherwise cause.
    tbody.addEventListener("change", (e) => {
      const td = e.target.closest("td.editable[data-edit-key]");
      if (td && e.target.closest("select.rp-cell-edit-select")) commitCell(td);
    });
  }

  // ── column drag-reorder handlers (B) ───────────────────────────────────────
  if (config.reorder) {
    thead.addEventListener("dragstart", (e) => {
      const th = e.target.closest('th[draggable="true"]');
      if (!th || !th.dataset.colKey) return;
      dragKey = th.dataset.colKey;
      th.classList.add("is-dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    thead.addEventListener("dragover", (e) => {
      const th = e.target.closest('th[draggable="true"]');
      if (!th || !th.dataset.colKey || th.dataset.colKey === dragKey) return;
      e.preventDefault();
      clearDropMarks();
      const rect = th.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      th.classList.add(after ? "is-drop-after" : "is-drop-before");
    });
    thead.addEventListener("drop", (e) => {
      const th = e.target.closest('th[draggable="true"]');
      if (!th || !th.dataset.colKey || dragKey == null) return;
      e.preventDefault();
      const after = th.classList.contains("is-drop-after");
      clearDropMarks();
      reorderColumns(dragKey, th.dataset.colKey, after);
      dragKey = null;
    });
    thead.addEventListener("dragend", () => {
      clearDropMarks();
      thead.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
      dragKey = null;
    });
  }

  // ── mode application (mutually exclusive) ──────────────────────────────────
  function applyMode(next) {
    mode = next === "select" || next === "edit" || next === "delete" ? next : "view";
    table.classList.remove(...MODE_CLASSES);
    if (mode !== "view") table.classList.add("mode-" + mode);
    // Leaving select/edit/delete clears selection (legacy parity).
    if (mode !== "select") { selected.clear(); emitSelection(); syncSelectAll(); }
    refreshBody();
    decorateCellEditor();    // strip on leave-edit / activate on enter-edit
  }

  // ── first paint ────────────────────────────────────────────────────────────
  renderHead();
  renderBody();
  syncEmpty();
  syncSelectAll();
  decorateCellEditor();

  // ── controller ──────────────────────────────────────────────────────────────
  return {
    el: host,
    /** Swap the backing rows; clears selection (per-render, legacy parity). */
    setRows(next) {
      rows = Array.isArray(next) ? next : [];
      selected.clear();
      renderBody();
      syncEmpty();
      syncSelectAll();
      emitSelection();
      decorateCellEditor();
    },
    /** Swap the column set (e.g. column show/hide, new file). */
    setColumns(cols) {
      columns = (cols || []).slice();
      renderHead();
      renderBody();
      decorateCellEditor();
    },
    /** Set the exclusive mode: "view" | "select" | "edit" | "delete". */
    setMode(m) { applyMode(m); },
    /** Re-render the current window/body in place (after a value/state change). */
    refresh() { refreshBody(); decorateCellEditor(); syncSelectAll(); },
    /** The current selection as a fresh Set of rowKeys. */
    getSelection() { return new Set(selected); },
    /** Detach listeners + the virtualizer's scroll listener (teardown). */
    destroy() {
      if (vrows) { vrows.destroy(); vrows = null; }
      host.innerHTML = "";
    },
  };
}

register("redtable", mountRedTable);
