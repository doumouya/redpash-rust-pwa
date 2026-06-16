/* filter-panel — the builder for the shared FilterNode tree. Lives in a
   ~280px side panel (Linear density). It OWNS its markup; all FilterNode <->
   row logic is the pure filter-node.js (so it is unit-tested without a DOM).

   mountFilterPanel(host, {
     columns: [{ key, label }],        // the column <select> options
     value?:  FilterNode,              // seed rows by decomposing a top Group
     onApply(node: FilterNode),        // assembled Group{op, children:[Pred|Group…]}
     onClear(),                        // rows emptied to one blank row
   }) -> { el, update({columns, value}), destroy }

   A row is either a PREDICATE row (column <select> + op <select> + a value input
   that ADAPTS to the op) or a nested GROUP row (its own All/Any toggle + child
   rows). "Add condition" appends a blank predicate; "Add group" nests an AND/OR
   group (DC3c) up to MAX_GROUP_DEPTH deep. The top combinator (All / Any) shows
   only when >1 top-level row. Footer: Apply (accent) + Clear (ghost). */

import { el } from "../boot/dom.js";
import { button, input } from "../atoms/atoms.js";
import { mountSelect } from "../select/select.js";
import { register } from "../registry/component-registry.js";
import {
  PRED_OPS,
  VALUELESS_OPS,
  RANGE_OPS,
  LIST_OPS,
  blankRow,
  blankGroup,
  assembleFilter,
  decomposeFilter,
} from "./filter-node.js";

/** How deep "Add group" will nest (root rows = depth 0; a group at this depth
    no longer offers nesting). Keeps a hand-built tree legible in a 280px panel. */
const MAX_GROUP_DEPTH = 2;

export function mountFilterPanel(host, cfg) {
  let columns = cfg.columns ?? [];
  const rows = []; // identity is STABLE — seed/clear mutate in place so the top
  let combinator = "and"; // add bar (built once, closes over `rows`) stays live.

  const root = el("div", { class: "rp-fp" });
  const combo = el("div", { class: "rp-fp-combo" });
  const list = el("div", { class: "rp-fp-rows" });
  const topAdd = addBar(rows, 0);
  const foot = el(
    "div",
    { class: "rp-fp-foot" },
    button({ label: "Clear", variant: "ghost", onClick: clearAll }),
    button({ label: "Apply", variant: "accent", onClick: apply })
  );
  root.append(combo, list, topAdd, foot);

  /* Replace the row set IN PLACE (rows identity must stay stable — see above). */
  function setRows(next) {
    rows.length = 0;
    rows.push(...next);
  }

  function seed(value) {
    const d = decomposeFilter(value);
    setRows(d.rows);
    combinator = d.combinator;
  }

  function columnOptions() {
    return columns.map((c) => ({ value: c.key, label: c.label ?? c.key }));
  }

  /* the value cell adapts to the op — returns the node to slot into the row. */
  function valueCell(row) {
    const cell = el("span", { class: "rp-fp-value" });
    if (VALUELESS_OPS.has(row.op)) {
      return cell; // empty placeholder keeps the grid aligned
    }
    if (RANGE_OPS.has(row.op)) {
      const lo = input({ type: "number", placeholder: "min", value: row.from, onInput: (v) => (row.from = v) });
      const hi = input({ type: "number", placeholder: "max", value: row.to, onInput: (v) => (row.to = v) });
      lo.classList.add("rp-fp-num");
      hi.classList.add("rp-fp-num");
      cell.append(lo, el("span", { class: "rp-fp-and" }, "and"), hi);
      return cell;
    }
    const placeholder = LIST_OPS.has(row.op) ? "a, b, c" : "value";
    const txt = input({ placeholder, value: row.value, onInput: (v) => (row.value = v) });
    txt.classList.add("rp-fp-text");
    cell.append(txt);
    return cell;
  }

  /* An All / Any segmented toggle bound to `getOp`/`setOp`. Shared by the top
     combinator and each nested group's own operator. */
  function comboSeg(activeOp, onChange) {
    const seg = el("div", { class: "rp-fp-seg", role: "group", "aria-label": "Match" });
    for (const opt of [{ v: "and", l: "All" }, { v: "or", l: "Any" }]) {
      seg.append(
        el(
          "button",
          {
            class: `rp-fp-seg-btn${activeOp === opt.v ? " is-active" : ""}`,
            type: "button",
            "aria-pressed": activeOp === opt.v ? "true" : "false",
            onclick: () => onChange(opt.v),
          },
          opt.l
        )
      );
    }
    return seg;
  }

  /* A predicate row. `arr` is the array that holds it (top rows or a group's
     children) so remove splices the right list. */
  function predRow(row, arr, i) {
    const colHost = el("span", { class: "rp-fp-col" });
    mountSelect(colHost, {
      options: [{ value: "", label: "Column…" }, ...columnOptions()],
      value: row.col,
      onChange: (v) => (row.col = v),
    });
    const opHost = el("span", { class: "rp-fp-op" });
    mountSelect(opHost, {
      options: PRED_OPS,
      value: row.op,
      onChange: (v) => {
        row.op = v;
        render(); // op change reshapes the value cell
      },
    });
    const remove = button({
      label: "✕",
      variant: "ghost",
      size: "sm",
      onClick: () => removeAt(arr, i),
    });
    remove.classList.add("rp-fp-remove");
    remove.setAttribute("aria-label", "Remove condition");
    return el("div", { class: "rp-fp-row" }, colHost, opHost, valueCell(row), remove);
  }

  /* A nested AND/OR group row: its own All/Any toggle + a remove, then its child
     rows, then its own add bar. Renders recursively (depth feeds the nest cap). */
  function groupRow(row, arr, i, depth) {
    const remove = button({
      label: "✕",
      variant: "ghost",
      size: "sm",
      onClick: () => removeAt(arr, i),
    });
    remove.classList.add("rp-fp-remove");
    remove.setAttribute("aria-label", "Remove group");
    const head = el(
      "div",
      { class: "rp-fp-group-head" },
      comboSeg(row.op, (v) => {
        row.op = v;
        render();
      }),
      remove
    );
    const childList = el("div", { class: "rp-fp-rows" });
    renderInto(childList, row.children, depth + 1);
    return el("div", { class: "rp-fp-group" }, head, childList, addBar(row.children, depth + 1));
  }

  function buildRow(row, arr, i, depth) {
    return row && row.group ? groupRow(row, arr, i, depth) : predRow(row, arr, i);
  }

  function renderInto(container, arr, depth) {
    container.replaceChildren(...arr.map((r, i) => buildRow(r, arr, i, depth)));
  }

  /* "+ Add condition" (+ "+ Add group" until the nest cap) for a given list. */
  function addBar(arr, depth) {
    const bar = el("div", { class: "rp-fp-add" });
    bar.append(
      button({ label: "+ Add condition", variant: "ghost", size: "sm", onClick: () => { arr.push(blankRow()); render(); } })
    );
    if (depth < MAX_GROUP_DEPTH) {
      bar.append(
        button({ label: "+ Add group", variant: "ghost", size: "sm", onClick: () => { arr.push(blankGroup()); render(); } })
      );
    }
    return bar;
  }

  /* Remove from a list; the TOP list never goes empty (reseed one blank row) so
     the panel always shows something. A nested group may empty — assembleFilter
     drops a childless group, and the user can still remove the group itself. */
  function removeAt(arr, i) {
    arr.splice(i, 1);
    if (arr === rows && rows.length === 0) rows.push(blankRow());
    render();
  }

  function renderCombo() {
    combo.replaceChildren();
    if (rows.length <= 1) return;
    combo.append(
      el("span", { class: "rp-fp-combo-label" }, "Match"),
      comboSeg(combinator, (v) => {
        combinator = v;
        renderCombo();
      })
    );
  }

  function render() {
    renderInto(list, rows, 0);
    renderCombo();
  }

  function clearAll() {
    setRows([blankRow()]);
    combinator = "and";
    render();
    cfg.onClear?.();
  }

  function apply() {
    cfg.onApply?.(assembleFilter(rows, combinator));
  }

  seed(cfg.value);
  render();
  host.append(root);

  return {
    el: root,
    update: (p = {}) => {
      if (p.columns) columns = p.columns;
      if ("value" in p) seed(p.value);
      render();
    },
    destroy: () => root.remove(),
  };
}

register("filter-panel", mountFilterPanel);
