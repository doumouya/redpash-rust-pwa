/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/editor-text.md */
import { editorRegistry } from "/scripts/framework/editor-registry.js";

// "text" — the universal contenteditable editor + the framework's
// safety fallback. Honors the data-full render rules (data-trunc /
// data-prefix) on exit so the cell snaps back to display form.
//
// Pattern lifted from home.js decorateEditMode / saveCellEdit closures
// (CAS_A5A4… data-full rule) — semantics preserved; only the dispatch
// shape changes (framework module + editor-registry id).

editorRegistry.register({
  id: "text",
  // Activate edit mode on a cell. Expands the source-of-truth value
  // (data-full) into the visible text so the user edits the bare
  // string — no truncation, no prefix decoration. The caller is
  // expected to mark the cell with .editable + data-edit-key BEFORE
  // calling buildOn; this editor handles the contenteditable swap +
  // value expansion.
  buildOn(td /*, ctx */) {
    td.classList.add("editable");
    td.setAttribute("contenteditable", "plaintext-only");
    if (td.dataset.full !== undefined) {
      td.textContent = td.dataset.full;
    }
  },
  // Deactivate edit mode. Re-renders the display form using the
  // data-trunc + data-prefix rules so the user sees the same shape
  // they saw before editing. Empty values render as "—" so a stale
  // prefix doesn't sit alone.
  buildOff(td /*, ctx */) {
    td.classList.remove("editable");
    td.removeAttribute("contenteditable");
    if (td.dataset.full !== undefined) {
      const trunc  = parseInt(td.dataset.trunc || "0", 10) || 0;
      const prefix = td.dataset.prefix || "";
      const full   = td.dataset.full;
      const display = trunc > 0 ? (full.slice(0, trunc) || "") : full;
      td.textContent = display ? (prefix + display) : "—";
    }
  },
  // Read the edited value. textContent.trim() matches the existing
  // saveCellEdit behavior — no rich-text, no whitespace at edges.
  readValue(td) {
    return td.textContent.trim();
  },
});
