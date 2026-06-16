/* column-manager — the Data Cleaner's per-column cleaning surface (DC3b). Sole
   owner of .rp-colmgr-*. knobs: --rp-colmgr-cols-max-h
   A column multi-select + the clean-op palette (global + column-scoped), with an
   INLINE action-sheet (built from field.js) for ops that take params. The ops
   are DATA (the page's clean-catalog) — this component reads only the generic
   id/label/icon/scope/min/max/fields and emits onApply; the page owns op.build,
   so the framework never depends on a page module. */

import { el } from "../boot/dom.js";
import { button, input } from "../atoms/atoms.js";
import { mountField } from "../field/field.js";
import { mountSelect } from "../select/select.js";
import { register } from "../registry/component-registry.js";

/** Is `op` runnable for `n` selected columns? Mirrors clean-catalog's opEnabled,
    inlined so the framework layer doesn't import a page module (scope/min/max are
    plain data on each op). Global ops are always runnable. */
function enabled(op, n) {
  if (op.scope === "global") return true;
  const min = op.min ?? 1;
  const max = op.max ?? Infinity;
  return n >= min && n <= max;
}

/** A human reason an op is currently disabled (for the button title). */
function disabledReason(op, n) {
  const min = op.min ?? 1;
  const max = op.max ?? Infinity;
  if (min === max) return `Select exactly ${min} column${min > 1 ? "s" : ""}`;
  if (n < min) return `Select at least ${min} column${min > 1 ? "s" : ""}`;
  return `Select at most ${max} columns`;
}

const splitList = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");

/**
 * Mount the column-manager.
 * @param {HTMLElement} host
 * @param {{ columns: {key:string,label?:string}[], ops: object[],
 *           onApply: (op:object, cols:string[], values:object) => void }} cfg
 * @returns {{ el: HTMLElement, update: (p?:{columns?:object[]}) => void, destroy: () => void }}
 */
export function mountColumnManager(host, cfg) {
  let columns = cfg.columns ?? [];
  const ops = cfg.ops ?? [];
  const selected = new Set();
  let activeOp = null; // the op whose action-sheet is open
  let values = {}; // field values for the active op

  const root = el("div", { class: "rp-colmgr" });
  const head = el("div", { class: "rp-colmgr-head" });
  const colsEl = el("div", { class: "rp-colmgr-cols" });
  const opsEl = el("div", { class: "rp-colmgr-ops" });
  const sheetEl = el("div", { class: "rp-colmgr-sheet" });
  root.append(head, colsEl, opsEl, sheetEl);

  function defaults(op) {
    const v = {};
    for (const f of op.fields ?? []) {
      v[f.key] = f.default ?? (f.type === "bool" ? false : f.type === "sentinels" ? [] : "");
    }
    return v;
  }

  /* the control node for one field, wired to write back into `values`. */
  function controlFor(f) {
    if (f.type === "enum") {
      const hostEl = el("span", { class: "rp-colmgr-control" });
      mountSelect(hostEl, {
        options: (f.options ?? []).map(([value, label]) => ({ value, label })),
        value: values[f.key],
        onChange: (v) => (values[f.key] = v),
      });
      return hostEl;
    }
    if (f.type === "bool") {
      const box = el("input", { type: "checkbox" });
      box.checked = !!values[f.key];
      box.addEventListener("change", () => (values[f.key] = box.checked));
      return box;
    }
    if (f.type === "sentinels") {
      return input({
        placeholder: f.placeholder ?? "N/A, -, ???",
        value: (values[f.key] ?? []).join(", "),
        onInput: (v) => (values[f.key] = splitList(v)),
      });
    }
    return input({
      type: f.type === "number" ? "number" : "text",
      placeholder: f.placeholder,
      value: values[f.key] ?? "",
      onInput: (v) => (values[f.key] = v),
    });
  }

  function openOp(op) {
    if (!enabled(op, selected.size)) return;
    if (!(op.fields && op.fields.length)) {
      cfg.onApply?.(op, [...selected], {});
      return;
    }
    activeOp = op;
    values = defaults(op);
    render();
  }

  function opButton(op) {
    const on = enabled(op, selected.size);
    const b = button({
      label: op.label,
      icon: op.icon,
      variant: activeOp === op ? "accent" : "ghost",
      disabled: !on,
      title: on ? undefined : disabledReason(op, selected.size),
      onClick: () => openOp(op),
    });
    b.classList.add("rp-colmgr-op");
    return b;
  }

  function renderHead() {
    head.replaceChildren(el("span", { class: "rp-colmgr-title" }, "Columns"));
    if (selected.size) {
      head.append(
        el("span", { class: "rp-colmgr-count" }, `${selected.size} selected`),
        button({
          label: "Clear",
          variant: "ghost",
          size: "sm",
          onClick: () => {
            selected.clear();
            render();
          },
        })
      );
    }
  }

  function renderCols() {
    colsEl.replaceChildren(
      ...columns.map((c) => {
        const box = el("input", { type: "checkbox" });
        box.checked = selected.has(c.key);
        box.addEventListener("change", () => {
          if (box.checked) selected.add(c.key);
          else selected.delete(c.key);
          render();
        });
        return el("label", { class: "rp-colmgr-col" }, box, el("span", { class: "rp-colmgr-col-name" }, c.label ?? c.key));
      })
    );
    if (!columns.length) {
      colsEl.append(el("p", { class: "rp-colmgr-empty" }, "No columns."));
    }
  }

  function renderOps() {
    const global = ops.filter((o) => o.scope === "global");
    const column = ops.filter((o) => o.scope !== "global");
    opsEl.replaceChildren(
      el("div", { class: "rp-colmgr-group-label" }, "Whole file"),
      el("div", { class: "rp-colmgr-op-row" }, ...global.map(opButton)),
      el("div", { class: "rp-colmgr-group-label" }, "Selected columns"),
      selected.size
        ? el("div", { class: "rp-colmgr-op-row" }, ...column.map(opButton))
        : el("p", { class: "rp-colmgr-empty" }, "Select one or more columns to clean them.")
    );
  }

  function renderSheet() {
    sheetEl.replaceChildren();
    if (!activeOp) return;
    const op = activeOp;
    sheetEl.append(el("div", { class: "rp-colmgr-sheet-title" }, op.label));
    for (const f of op.fields ?? []) {
      mountField(sheetEl, { label: f.label, control: controlFor(f) });
    }
    sheetEl.append(
      el(
        "div",
        { class: "rp-colmgr-sheet-foot" },
        button({
          label: "Cancel",
          variant: "ghost",
          onClick: () => {
            activeOp = null;
            render();
          },
        }),
        button({
          label: "Apply",
          variant: "accent",
          onClick: () => {
            cfg.onApply?.(op, [...selected], values);
            activeOp = null;
            render();
          },
        })
      )
    );
  }

  function render() {
    // a selection change can invalidate an open sheet (e.g. dropped below min).
    if (activeOp && !enabled(activeOp, selected.size)) activeOp = null;
    renderHead();
    renderCols();
    renderOps();
    renderSheet();
  }

  render();
  host.append(root);

  return {
    el: root,
    update: (p = {}) => {
      if (p.columns) {
        columns = p.columns;
        const keys = new Set(columns.map((c) => c.key));
        for (const k of [...selected]) if (!keys.has(k)) selected.delete(k);
      }
      render();
    },
    destroy: () => root.remove(),
  };
}

register("column-manager", mountColumnManager);
