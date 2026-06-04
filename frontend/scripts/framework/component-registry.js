/* Purpose: component registry — register/discover the single-source UI components (rp- only).
 * Doc: docs/internal/code/frontend/scripts/framework/component-registry.md */
// ── RedPash FE framework — component registry (CAS_37B2E1BF) ─────────────────
// Sibling to editor-registry.js (cell editors) and type-registry.js (TypeDefinitions):
// this one registers whole UI COMPONENTS (redtable, rail, create-action, …) so a single
// implementation of each is consumed by every page. A change to one — e.g. how a row
// renders, or dropping pagination — propagates to every redtable at once.
//
// CONTRACT (enforced by tools/ui-doc-audit's namespace lint):
//   • ONE class namespace: rp-, flat kebab. NO __ (BEM elements), NO rt-/ds-/ws-.
//   • One module per component (redtable.js, rail.js, create-action.js, …), each
//     self-registering at load:  register("redtable", createRedTable).
//   • Components are parameterized and proven in /framework-sandbox.html (rebuild the
//     7 real pages from registered components = the completeness test) BEFORE any live
//     page cuts over.
//
// Registry only — components live in sibling modules and import this.
"use strict";

const COMPONENTS = Object.create(null);

/** Register a component factory under a unique name. Returns the factory. */
export function register(name, factory) {
  if (COMPONENTS[name]) throw new Error("framework: component already registered: " + name);
  if (typeof factory !== "function") throw new Error("framework: factory must be a function: " + name);
  COMPONENTS[name] = factory;
  return factory;
}

/** Get a registered component factory, or null. */
export function get(name) { return COMPONENTS[name] || null; }

/** Sorted list of registered component names (the sandbox + ui-runtime-audit read this). */
export function list() { return Object.keys(COMPONENTS).sort(); }
