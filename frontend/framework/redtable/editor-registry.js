/* editor-registry — THE cell-editor index for redtable edit mode. Editors are
   data (an open registry keyed by dtype), exactly like components, types and
   behavior — so a new column type plugs an editor in without touching the
   table. register(dtype, factory) + editorFor(col) resolve a factory by the
   column's dtype, falling back to the text editor.

   A factory(td, { value, onCommit(value) }) takes over the <td>: it swaps the
   cell content for an input, commits on blur/Enter (calling onCommit with the
   parsed value), reverts on Escape, and restores the cell either way. It runs
   inside the table's edit interaction (redtable.js) — the table owns where the
   commit goes (onCellCommit); the editor only shapes the value.

   Composes the atoms.input STYLE via the shared .rp-input class (atoms.css owns
   it; this seam declares no classes of its own — no CSS sheet, ui-fork-audit
   R4 has nothing to own here). */

import { el } from "../boot/dom.js";

const editors = new Map(); // dtype → factory

/** register(dtype, factory) — last writer wins by design (an app may override
 *  the default numeric editor with a richer one without forking the table). */
export function register(dtype, factory) {
  editors.set(dtype, factory);
}

/** editorFor(col) → factory. Resolves by col.editor (explicit override) then
 *  col.dtype, falling back to the text editor — every column is editable. */
export function editorFor(col) {
  return editors.get(col?.editor) ?? editors.get(col?.dtype) ?? editors.get("text");
}

/* ── the built-in editors ──────────────────────────────────────────────── */

/** Shared swap-commit-revert harness. `parse` shapes the committed string;
 *  returning undefined cancels the commit (kept the old value). */
function makeEditor({ type = "text", parse = (s) => s } = {}) {
  return (td, { value, onCommit }) => {
    const prev = [...td.childNodes]; // restore exactly what was there
    const field = el("input", { class: "rp-input rp-redtable-editor", type });
    field.value = value == null ? "" : String(value);
    td.replaceChildren(field);
    field.focus();
    field.select();

    let done = false;
    const restore = () => td.replaceChildren(...prev);
    const commit = () => {
      if (done) return;
      done = true;
      const next = parse(field.value);
      restore();
      if (next !== undefined) onCommit?.(next);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      restore();
    };
    field.addEventListener("blur", commit);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); field.blur(); }
    });
    return { commit, cancel, el: field };
  };
}

// number parser: blank → "" (a cleared cell), non-numeric → undefined (cancel).
function parseNumber(s) {
  const t = s.trim();
  if (t === "") return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

register("text", makeEditor());
register("int", makeEditor({ type: "number", parse: parseNumber }));
register("float", makeEditor({ type: "number", parse: parseNumber }));
