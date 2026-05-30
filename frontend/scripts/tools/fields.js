/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/tools/fields.md */
// Tools-panel field-type renderers — first slice of the
// frontend/scripts/tools.js decomposition (Em 2026-05-27 god-object
// campaign per Internal-Slack/broadcast.md 00:53).
//
// Each renderer returns { html, read(rootEl) }. `read` returns the
// typed value for that field; the parent tool config composes them
// into the step params POSTed to /api/files/:rid/steps.
//
// All field rows reuse the filter panel's `rt-pred` family — no new
// UI components, just BEM modifiers (`rt-pred--stack`, `rt-pred--inline`)
// on existing atoms. Source-of-truth for the BEM family is
// `frontend/styles/panel.css`.
//
// Module-private to the tools panel: consumed exactly once at
// `tools.js`'s sheet-renderer dispatch. No external consumers as of
// the v1 extract; if a future page wants to compose the same field
// renderers (cases form, settings form, etc.), promote the export
// + add a sibling spec doc.

import { esc } from "/scripts/dom.js";

export const FIELDS = {
  column: ({ key, label, columns }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<select class="rt-pred-col" data-key="' + esc(key) + '">'
      +   columns.map((c) =>
            '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>').join("")
      + '</select>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value,
  }),

  enum: ({ key, label, options }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<select class="rt-pred-op" data-key="' + esc(key) + '">'
      +   options.map(([v, l]) =>
            '<option value="' + esc(v) + '">' + esc(l) + '</option>').join("")
      + '</select>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value,
  }),

  text: ({ key, label, placeholder }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<input class="rt-pred-val" data-key="' + esc(key) + '"'
      + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + ' />'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value.trim(),
  }),

  boolean: ({ key, label }) => ({
    html:
      '<div class="rt-pred rt-pred--inline">'
      + '<label class="rt-pred-lbl">'
      +   '<input type="checkbox" class="rt-chk" data-key="' + esc(key) + '" /> ' + esc(label)
      + '</label>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').checked,
  }),

  // Multi-column: a vertical list of checkboxes, one per active column.
  // Returns the array of checked column names (or [] if none).
  multicolumn: ({ key, label, columns }) => ({
    html:
      '<div class="rt-pred rt-pred--stack">'
      + '<label class="rt-pred-lbl">' + esc(label) + '</label>'
      + '<div class="rt-pred-multi" data-key="' + esc(key) + '">'
      +   columns.map((c) =>
            '<label class="rt-dd-item"><input type="checkbox" class="rt-chk" value="'
              + esc(c.name) + '" /> ' + esc(c.name) + '</label>').join("")
      + '</div>'
      + '</div>',
    read: (root) => Array.from(
      root.querySelectorAll('[data-key="' + key + '"] input:checked')
    ).map((el) => el.value),
  }),
};
