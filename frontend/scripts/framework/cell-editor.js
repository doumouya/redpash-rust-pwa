/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/cell-editor.md */
import { editorRegistry } from "/scripts/framework/editor-registry.js";
import "/scripts/framework/editor-text.js";            // universal fallback — first
import "/scripts/framework/editor-chip-enum.js";
import "/scripts/framework/editor-entity-picker.js";

// Cell-editor orchestrator. Walks a redtable's editable cells, dispatches
// edit-mode on/off to the editor-registry, and exposes a save() helper
// that uses the resolved editor's readValue() before issuing the PATCH.
//
// Page-specific state (editHistory / editFuture / logAction / per-tab
// reset) stays in the caller — this module is stateless. The caller is
// expected to push to its undo stack + write its action log on every
// successful save() return.
//
// Lifted from pages/home.js decorateEditMode + saveCellEdit closures
// (CAS_8A210C7A, CAS_A5A4… data-full pattern, CAS_E97414… chip-enum
// pattern, CAS_D78667D1 per-column editEndpoint). Semantics preserved;
// the framework version takes a `chipRender(name) → fn` callback so
// the chip vocabulary stays in the caller until the chip-registry
// extraction (CAS_BF208AA8) lands.

// Build the editor-specific ctx object from a col spec.
function buildCtx(col, chipRender) {
  if (!col) return {};
  if (col.editor === "chip-enum") {
    return {
      options: col.options,
      // chipRender is the caller's chipRenderFor; chipRender(name)
      // returns the actual render fn (or undefined if name is null /
      // unknown — buildOff handles that with a textContent fallback).
      renderChip: (chipRender && col.render) ? chipRender(col.render) : undefined,
    };
  }
  if (col.editor === "entity-picker") {
    return {
      relType: col.rel && col.rel.type,
      placeholder: col.placeholder,
      // Chip renderer for the OFF re-render (no-save exit). Resolved like
      // chip-enum's, from the caller's chipRenderFor + col.render. Applied
      // to the cell's data-label (display name), not the rid.
      renderChip: (chipRender && col.render) ? chipRender(col.render) : undefined,
    };
  }
  return {};
}

export const cellEditor = {
  // decorate({ view, spec, editMode, selectMode, isPlatformAdmin, chipRender, tableRoot })
  //   view              — DOM root containing the redtable. Used only as
  //                       the fallback scope when tableRoot is omitted
  //                       (legacy ".rp-redtable" / "#rp-home-list-tbody"
  //                       lookups stay view-scoped, exactly as before).
  //   spec              — page spec (spec.columns[] carries editKey,
  //                       editor, options, render, requiresAdmin, ...)
  //   editMode          — boolean. true → activate edit mode on
  //                       editable cells; false → strip back to display.
  //   selectMode        — boolean. true → leading sel-column adds a +1
  //                       offset when mapping spec col positions to TD
  //                       indices. Caller's closure state; framework
  //                       doesn't infer from DOM (DOM/state can lag).
  //   isPlatformAdmin   — boolean. Gates col.requiresAdmin fields
  //                       (e.g. Platform role on Users tab).
  //   chipRender        — fn(name) → fn(value) → htmlString. Resolves
  //                       the chip renderer for a chip name. The caller
  //                       owns the chip vocabulary; this module just
  //                       passes the resolved renderer to chip-enum's
  //                       ctx so it can rebuild the chip on buildOff.
  //   tableRoot         — OPTIONAL <table> element. When supplied, the
  //                       tbody, thead row + tr[data-rid] are derived
  //                       FROM this root (so rp-redtable can pass its
  //                       <table class="rp-redtable">). When OMITTED,
  //                       falls back to the legacy view-scoped lookups
  //                       (".rp-redtable thead tr" + "#rp-home-list-tbody")
  //                       — every existing caller (home.js,
  //                       typedef-acceptance.js) behaves IDENTICALLY.
  decorate({ view, spec, editMode, selectMode, isPlatformAdmin, chipRender, tableRoot }) {
    // tbody: when a tableRoot is given, the editable cells live in THAT
    // table's tbody; otherwise keep the legacy hard-coded id, view-scoped.
    const tbody = tableRoot
      ? tableRoot.querySelector("tbody")
      : view.querySelector("#rp-home-list-tbody");
    if (!tbody) return;
    const colByKey = new Map(
      (spec.columns || []).filter((c) => c.editKey).map((c) => [c.editKey, c]),
    );
    // STRIP — every .editable cell exits edit mode via its editor's
    // buildOff. Run unconditionally so toggling editMode off cleanly
    // restores display form. data-edit-key removal is the orchestrator's
    // concern (the editor doesn't own the attribute it didn't add).
    tbody.querySelectorAll("td.editable").forEach((td) => {
      const editKey = td.dataset.editKey;
      const col = editKey ? colByKey.get(editKey) : null;
      const editor = editorRegistry.lookup((col && col.editor) || "text");
      if (editor) editor.buildOff(td, buildCtx(col, chipRender));
      td.removeAttribute("data-edit-key");
    });
    if (!editMode) return;
    // ACTIVATE — walk spec's editable cols, resolve each TD by the
    // CURRENT thead position (survives column reorder), dispatch
    // buildOn per editor id.
    // thead row: derived from tableRoot when supplied (rp-redtable),
    // else the legacy view-scoped ".rp-redtable thead tr" lookup.
    const thead = tableRoot
      ? tableRoot.querySelector("thead tr")
      : view.querySelector(".rp-redtable thead tr");
    if (!thead) return;
    const dataTHs = [...thead.querySelectorAll("th[data-col-key]")];
    const keyToPos = new Map(dataTHs.map((th, i) => [th.dataset.colKey, i]));
    // selectMode adds a leading .rp-list-sel column; offset accordingly.
    const offset = selectMode ? 1 : 0;
    const editableCols = (spec.columns || []).filter(
      (col) => typeof col === "object" && col.editable && col.editKey
        // requiresAdmin gate: privilege-escalating columns become
        // editable only when the caller is a platform admin. Backend
        // 404s non-admins anyway (leak-free); this just hides the
        // affordance so non-admins don't see an editor that 404s.
        && (!col.requiresAdmin || isPlatformAdmin),
    );
    tbody.querySelectorAll("tr[data-rid]").forEach((tr) => {
      const tds = tr.querySelectorAll("td");
      editableCols.forEach((col) => {
        const pos = keyToPos.get(col.key);
        if (pos === undefined) return;
        const td = tds[pos + offset];
        if (!td) return;
        const editor = editorRegistry.lookup(col.editor || "text");
        if (!editor) return;
        td.setAttribute("data-edit-key", col.editKey);
        editor.buildOn(td, buildCtx(col, chipRender));
      });
    });
  },

  // save({ td, rid, spec, api })
  //   td   — the edited cell
  //   rid  — the row's rid
  //   spec — page spec (for col.editEndpoint resolution +
  //          spec.patchEndpoint fallback per CAS_D78667D1)
  //   api  — fetch wrapper (the caller's api.js import)
  //
  // Returns { key, value, oldValue } on a successful PATCH so the
  // caller can push to its undo stack + log the action. Returns null
  // when the value didn't change (no-op). Throws on PATCH failure;
  // the caller is responsible for revert + UI feedback.
  async save({ td, rid, spec, api }) {
    const key = td.dataset.editKey;
    if (!key) return null;
    const col = (spec.columns || []).find((c) => c && c.editKey === key);
    const editor = editorRegistry.lookup((col && col.editor) || "text");
    if (!editor) return null;
    const value = editor.readValue(td);
    const original = td.dataset.editOriginal ?? "";
    if (value === original) return null;
    // Per-column endpoint override (CAS_D78667D1): some cols mutate
    // via a different resource than the tab default (e.g. Platform
    // role lives at /admin/users/:rid, not /users/:rid).
    const patchBase = (col && col.editEndpoint) || spec.patchEndpoint || spec.endpoint;
    await api.patch(patchBase + "/" + encodeURIComponent(rid), { [key]: value });
    td.dataset.editOriginal = value;
    // data-full pattern: keep source-of-truth in sync for subsequent
    // edits + the exit-edit-mode re-truncate path.
    if (td.dataset.full !== undefined) {
      td.dataset.full = value;
    }
    return { key, value, oldValue: original };
  },
};
