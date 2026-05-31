/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/editor-entity-picker.md */
import { editorRegistry } from "/scripts/framework/editor-registry.js";
import { api } from "/scripts/api.js";

// "entity-picker" — pick a related entity by name and resolve it to its rid
// for the PATCH. Used for FieldDef.rel fields. The cell carries:
//   data-full  — the current rid (the PATCH value / source of truth)
//   data-label — the current display name (picker pre-fill + OFF re-render)
//
// ctx contract (from cell-editor.js buildCtx):
//   ctx.relType     — related type id (matches FieldDef.rel.type)
//   ctx.placeholder — optional input placeholder
//   ctx.renderChip  — fn(label) -> htmlString: rebuild the display chip on
//                     exit (resolved from the caller's chipRenderFor + col.render)
//
// FIRST REAL CONSUMER (Em 2026-06-01): Users-tab "Org" editing, relType
// "company". Per [[build-ready-dont-wire]] the search wiring lands against
// this real consumer. Companies are a small set, so a native <datalist>
// autocomplete fits — no debounced server search needed yet. The next
// consumer over a large set (case.assignee → user) adds its SOURCES row and
// can swap to debounced search WITHOUT touching any consumer.

// relType → how to fetch the option set + extract { rid, name } per row.
// Add a row only when a real consumer lands (don't speculate shapes ahead
// of need). Unknown relType → bare text input (rid typed, backend validates).
const SOURCES = {
  company: {
    // /admin/companies → Page<CompanySummary>; the Company fields serialize
    // FLAT on each row (redpash_id / name), not nested under `.company`.
    url:     "/admin/companies?size=500",
    extract: (page) => (page.rows || []).map((r) => ({ rid: r.redpash_id, name: r.name })),
  },
};

// Per-relType cache: relType -> Promise<{ items, byName: Map<name,rid> }>.
// Fetched once per session; a failed load clears so the next open retries.
const cache = {};
function loadSource(relType) {
  if (!SOURCES[relType]) return Promise.resolve(null);
  if (!cache[relType]) {
    cache[relType] = api.get(SOURCES[relType].url).then((page) => {
      const items  = SOURCES[relType].extract(page).filter((x) => x.rid && x.name);
      const byName = new Map(items.map((x) => [x.name, x.rid]));
      return { items, byName };
    }).catch((err) => {
      console.warn("[entity-picker] source load failed for", relType, err);
      cache[relType] = null;
      return null;
    });
  }
  return cache[relType];
}

editorRegistry.register({
  id: "entity-picker",
  buildOn(td, ctx) {
    const relType = ctx && ctx.relType;
    const label   = td.dataset.label || "";   // current display name
    const origRid = td.dataset.full  || "";    // current rid (PATCH source)

    const input = document.createElement("input");
    input.type        = "text";
    input.className   = "rp-cell-edit-input";
    input.value       = label;
    input.dataset.rid = origRid;               // default: unchanged → no-op
    if (ctx && typeof ctx.placeholder === "string") input.placeholder = ctx.placeholder;
    if (typeof relType === "string") input.dataset.relType = relType;

    while (td.firstChild) td.removeChild(td.firstChild);
    td.appendChild(input);
    td.classList.add("editable");

    // Autocomplete for known relTypes only (first consumer: company). An
    // unknown relType stays a bare text input — build-ready, not wired.
    if (SOURCES[relType]) {
      const listId = "rp-ep-" + relType;
      let datalist = td.ownerDocument.getElementById(listId);
      if (!datalist) {
        datalist = td.ownerDocument.createElement("datalist");
        datalist.id = listId;
        td.ownerDocument.body.appendChild(datalist);
      }
      input.setAttribute("list", listId);
      loadSource(relType).then((data) => {
        if (!data) return;
        if (!datalist.childElementCount) {
          data.items.forEach((it) => {
            const opt = td.ownerDocument.createElement("option");
            opt.value = it.name;
            datalist.appendChild(opt);
          });
        }
        input._byName = data.byName;
        // Keep dataset.rid honest for the pre-filled name.
        const pre = data.byName.get(input.value.trim());
        if (pre) input.dataset.rid = pre;
      });
      // On pick/type: resolve name → rid and update the display label so a
      // post-save exit re-renders the NEW company name (save() syncs
      // data-full=rid; data-label is ours to keep current).
      input.addEventListener("input", () => {
        const rid = input._byName ? input._byName.get(input.value.trim()) : null;
        if (rid) {
          input.dataset.rid = rid;
          td.dataset.label  = input.value.trim();
        }
      });
    }
  },

  buildOff(td, ctx) {
    td.classList.remove("editable");
    const label = td.dataset.label || "";
    // SECURITY CONTRACT (same as editor-chip-enum.js buildOff): renderChip is
    // a dev-defined renderer (here orgChip) that MUST escape its input. `label`
    // is data-label = a company NAME — user-writable free text (not a backend
    // enum), so the escape is load-bearing, not just defense-in-depth. orgChip
    // routes the name through esc() (home.js), so no live XSS. The string→HTML
    // innerHTML path here is tracked for the DOM-node-returning hardening in
    // CAS_BF208AA872BB42D788A95CAE44877C2C (convert all chip renderers + these
    // buildOff sites together — this is one of the free-text-backed ones).
    if (ctx && typeof ctx.renderChip === "function") {
      td.innerHTML = label ? ctx.renderChip(label) : '<span class="rp-meta">—</span>';
    } else {
      td.textContent = label || "—";
    }
  },

  // Return the resolved rid for the picked name, or the original rid when the
  // text doesn't match a known entity (a no-op edit — never PATCH a bare typed
  // string as a rid). save() compares against data-edit-original; the backend
  // re-validates the rid (404 on unknown) as the final guard.
  readValue(td) {
    const input = td.querySelector("input.rp-cell-edit-input");
    if (!input) return td.dataset.full || "";
    const typed    = input.value.trim();
    const resolved = input._byName ? input._byName.get(typed) : null;
    return resolved || input.dataset.rid || td.dataset.full || "";
  },
});
