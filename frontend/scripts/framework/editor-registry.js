/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/framework/editor-registry.md */

// Open editor registry. Editor modules register themselves on import
// side-effect via editorRegistry.register({ id, buildOn, buildOff,
// readValue }). cell-editor.js (the orchestrator) imports all editor
// modules it wants available — that's how new editors land: add a
// frontend/scripts/framework/editor-<id>.js + import it from
// cell-editor.js. No edits to this module.
//
// Per spec §5.1, backend treats `editor` as an opaque string + never
// validates against an FE-known list. This registry is the FE-side
// counterpart: an unknown editor id resolves to the universal `text`
// fallback (cell stays editable, PATCH still fires, worst case is
// "no fancy widget"). The text fallback is REQUIRED — every framework
// consumer relies on it; missing-text would be a hard error not a
// downgrade.

const editors = new Map();

export const editorRegistry = {
  register(impl) {
    if (!impl || typeof impl.id !== "string" || !impl.id) {
      throw new Error("editor-registry: register() requires an impl with a non-empty string id");
    }
    if (typeof impl.buildOn !== "function" || typeof impl.buildOff !== "function" || typeof impl.readValue !== "function") {
      throw new Error("editor-registry: register() requires { id, buildOn, buildOff, readValue } per spec §5.2");
    }
    editors.set(impl.id, impl);
  },
  // Resolve an editor by id; falls back to "text" when the id is
  // unknown. Returns null only when "text" itself isn't registered yet
  // (e.g. cell-editor.js imported before editor-text.js — caller can
  // detect + report). Universal fallback is the §5 disposability
  // property: a customer's custom editor id silently downgrades to
  // text instead of failing the cell.
  lookup(id) {
    return editors.get(id) || editors.get("text") || null;
  },
  has(id) {
    return editors.has(id);
  },
  ids() {
    return Array.from(editors.keys());
  },
};
