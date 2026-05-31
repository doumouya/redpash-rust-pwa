/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/editor-chip-enum.md */
import { editorRegistry } from "/scripts/framework/editor-registry.js";

// "chip-enum" — swap a chip span for a <select> populated with the
// field's options. Used for fields whose data_type is enum (the §4
// validation contract) and whose presentation is a chip.
//
// ctx contract (provided by cell-editor.js when dispatching):
//   ctx.options    — string[]: the enum options for the select
//   ctx.renderChip — fn(value) -> html-string: chip-render function to
//                    rebuild the display chip on exit. Resolved by the
//                    caller from the chip-render registry (today
//                    chipRenderFor() in home.js, a future
//                    chip-registry.js module).
//
// Pattern lifted from home.js decorateEditMode chip-enum branch
// (CAS_E97414…) — semantics preserved; the chip-render dispatch is
// pulled out as a ctx callback so this module stays disposable (no
// hardcoded chip vocabulary).

editorRegistry.register({
  id: "chip-enum",
  buildOn(td, ctx) {
    const current = td.dataset.full || "";
    const select = document.createElement("select");
    select.className = "rp-cell-edit-select";
    (ctx && Array.isArray(ctx.options) ? ctx.options : []).forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = opt;
      if (opt === current) option.selected = true;
      select.appendChild(option);
    });
    while (td.firstChild) td.removeChild(td.firstChild);
    td.appendChild(select);
    td.classList.add("editable");
  },
  // SECURITY CONTRACT: renderers MUST escape their input value before
  // returning HTML. Every chip renderer in home.js's chipRenderFor()
  // (planChip / caseStatusChip / orgChip / ...) routes through esc()
  // for the default branch and dev-controlled HTML templates for the
  // typed branches — values from td.dataset.full are backend-served
  // strings (enum options, role labels, etc.) but defense-in-depth
  // requires renderers to escape regardless. The default fallback
  // below uses textContent-equivalent escaping (the "—" / value path)
  // to avoid surprise when ctx.renderChip is missing.
  //
  // Hardening the contract — switching renderers from
  // string-returning to Element/DocumentFragment-returning — is
  // tracked as future work; the existing pattern is preserved here
  // for parity with home.js cell-editor (CAS_E97414…) and to keep
  // Phase A purely additive.
  buildOff(td, ctx) {
    td.classList.remove("editable");
    if (ctx && typeof ctx.renderChip === "function") {
      // Dev-controlled renderer; chip vocabulary is source-defined in
      // home.js / future chip-registry, not user-controlled.
      td.innerHTML = ctx.renderChip(td.dataset.full || "");
    } else {
      // Safe textContent fallback when no renderer is supplied — used
      // by tests + the §6 acceptance smoke before chip-render lands.
      td.textContent = td.dataset.full || "—";
    }
  },
  // Read the selected value. select.value is the source of truth on
  // edit; textContent could be the option label (often identical, not
  // guaranteed) so we never read it for chip-enum.
  readValue(td) {
    const sel = td.querySelector("select.rp-cell-edit-select");
    return sel ? sel.value : (td.dataset.full || "");
  },
});
