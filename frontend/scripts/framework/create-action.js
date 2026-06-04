/* Purpose: context-aware create-action factory — one createSpec → the rail's on.create handler (route | modal).
   Doc: docs/internal/code/frontend/scripts/framework/create-action.md */
// ── Create-action (framework, CAS_37B2E1BF — S4) ─────────────────────────────
// ONE context-aware create affordance, replacing the per-page create logic
// hand-copied across Home (per-tab createSpec), Workspace (3 static buttons), and
// Cases (bespoke create-case modal). The RAIL owns the create BUTTON (mountRail
// footer.create + its on.create hook — Torv-A's lane); this module owns the
// ACTION the button triggers. A page wires them:
//
//   mountRail(host, { footer: { create: { label: spec.label } },
//                     on:     { create: createAction(spec) } });
//
// A createSpec (the shape Home already uses):
//   { kind: "route", href }                                  → navigate
//   { kind: "modal", title, label, icon, endpoint, fields[], → open the generic
//     onSubmit?, afterCreate? }                                 modal, POST, refresh
//
// Render-first: the factory + modal open are wired; the POST is a sensible
// DEFAULT (api.post(endpoint, values)) that a page overrides via spec.onSubmit —
// the seam to each page's real create flow at cutover.
"use strict";

import { openModal } from "/scripts/framework/modal.js";

/**
 * Build the rail's `on.create` handler from a createSpec.
 * @param {{kind?:string, href?:string, title?:string, label?:string, icon?:string,
 *          endpoint?:string, fields?:Array, onSubmit?:Function, afterCreate?:Function}} spec
 * @returns {() => void}
 */
export function createAction(spec) {
  return function onCreate() {
    if (!spec) return;

    // kind:"route" — the create is a navigation (Home Files→Workspace upload,
    // Charts→Designer). Default kind when an href is present + no fields.
    if (spec.kind === "route" || (spec.href && !spec.fields)) {
      if (spec.href) location.hash = spec.href;
      return;
    }

    // kind:"modal" — open the generic dialog built from spec.fields, then submit.
    openModal({
      title: spec.title || spec.label || "Create",
      fields: spec.fields || [],
      submitLabel: spec.label || "Create",
      submitIcon: spec.icon || "bi-plus-lg",
      onSubmit: async (values, modal) => {
        if (typeof spec.onSubmit === "function") {
          await spec.onSubmit(values, modal);            // page-owned create flow
        } else if (spec.endpoint) {
          const { api } = await import("/scripts/api.js"); // default: POST the JSON body
          await api.post(spec.endpoint, values);
        }
        if (typeof spec.afterCreate === "function") spec.afterCreate(values);
      },
    });
  };
}
