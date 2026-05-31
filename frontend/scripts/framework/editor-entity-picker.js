/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/editor-entity-picker.md */
import { editorRegistry } from "/scripts/framework/editor-registry.js";

// "entity-picker" — text input that resolves a rid against a related
// entity type. Used for FieldDef.rel fields (case.assignee → user,
// case.reporter → user, file.project_id → project, etc.).
//
// ctx contract (provided by cell-editor.js when dispatching):
//   ctx.relType    — string: the type id this picker resolves against
//                    (matches FieldDef.rel.type, e.g. "user", "project")
//   ctx.placeholder — string: optional input placeholder
//   ctx.renderRid   — fn(rid) -> string: display string for a rid on
//                    exit (e.g. user display_name lookup). Resolved by
//                    the caller from a future entity-display registry.
//
// Phase A status: BUILD-READY, NOT WIRED. The search + autocomplete
// machinery (debounced /api/<type>?q= calls, dropdown DOM, keyboard
// nav) is intentionally NOT shipped in this module — it lands when
// the first real consumer (cell-editor.js dispatching to entity-
// picker for case.assignee editing) needs it. Per
// [[build-ready-dont-wire]] the reusable shape ships now; the search
// wiring happens against the real consumer's UX requirements, not
// against a hypothetical one.

editorRegistry.register({
  id: "entity-picker",
  buildOn(td, ctx) {
    const current = td.dataset.full || "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "rp-cell-edit-input";
    input.value = current;
    if (ctx && typeof ctx.placeholder === "string") {
      input.placeholder = ctx.placeholder;
    }
    if (ctx && typeof ctx.relType === "string") {
      input.dataset.relType = ctx.relType;
    }
    while (td.firstChild) td.removeChild(td.firstChild);
    td.appendChild(input);
    td.classList.add("editable");
    // Search + autocomplete wiring lands with the first real consumer
    // (build-ready-don't-wire; CAS_8A210C7A resumption).
  },
  buildOff(td, ctx) {
    td.classList.remove("editable");
    if (td.dataset.full !== undefined) {
      const renderer = (ctx && typeof ctx.renderRid === "function")
        ? ctx.renderRid
        : (rid) => rid || "—";
      td.textContent = renderer(td.dataset.full);
    }
  },
  // Read the entered value. v1 is a bare-string read — the caller is
  // expected to validate that the value matches a rid for ctx.relType
  // before PATCHing (backend rejects unknown rids with 404 per spec
  // §4.2, so an invalid rid round-trips visibly).
  readValue(td) {
    const input = td.querySelector("input.rp-cell-edit-input");
    return input ? input.value.trim() : (td.dataset.full || "");
  },
});
