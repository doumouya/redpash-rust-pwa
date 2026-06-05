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
// All field rows reuse the filter panel's `rp-pred` family — no new
// UI components, just BEM modifiers (`rp-pred--stack`, `rp-pred--inline`)
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
      '<div class="rp-pred rp-pred--stack">'
      + '<label class="rp-pred-lbl">' + esc(label) + '</label>'
      + '<select class="rp-pred-col" data-key="' + esc(key) + '">'
      +   columns.map((c) =>
            '<option value="' + esc(c.name) + '">' + esc(c.name) + '</option>').join("")
      + '</select>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value,
  }),

  enum: ({ key, label, options }) => ({
    html:
      '<div class="rp-pred rp-pred--stack">'
      + '<label class="rp-pred-lbl">' + esc(label) + '</label>'
      + '<select class="rp-pred-op" data-key="' + esc(key) + '">'
      +   options.map(([v, l]) =>
            '<option value="' + esc(v) + '">' + esc(l) + '</option>').join("")
      + '</select>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value,
  }),

  text: ({ key, label, placeholder }) => ({
    html:
      '<div class="rp-pred rp-pred--stack">'
      + '<label class="rp-pred-lbl">' + esc(label) + '</label>'
      + '<input class="rp-pred-val" data-key="' + esc(key) + '"'
      + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + ' />'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').value.trim(),
  }),

  boolean: ({ key, label }) => ({
    html:
      '<div class="rp-pred rp-pred--inline">'
      + '<label class="rp-pred-lbl">'
      +   '<input type="checkbox" class="rp-redtable-chk" data-key="' + esc(key) + '" /> ' + esc(label)
      + '</label>'
      + '</div>',
    read: (root) => root.querySelector('[data-key="' + key + '"]').checked,
  }),

  // Multi-column: a vertical list of checkboxes, one per active column.
  // Returns the array of checked column names (or [] if none).
  multicolumn: ({ key, label, columns }) => ({
    html:
      '<div class="rp-pred rp-pred--stack">'
      + '<label class="rp-pred-lbl">' + esc(label) + '</label>'
      + '<div class="rp-pred-multi" data-key="' + esc(key) + '">'
      +   columns.map((c) =>
            '<label class="rp-menu-item"><input type="checkbox" class="rp-redtable-chk" value="'
              + esc(c.name) + '" /> ' + esc(c.name) + '</label>').join("")
      + '</div>'
      + '</div>',
    read: (root) => Array.from(
      root.querySelectorAll('[data-key="' + key + '"] input:checked')
    ).map((el) => el.value),
  }),

  // Sentinel picker — the junk-value scan-and-pick. The chips are
  // populated ASYNC by tools.js (`populateSentinels`) after the sheet
  // mounts, since the file scan (GET /files/:rid/sentinels) can't run in
  // a sync FIELDS renderer. Here we render the container + the
  // "add your own" input; `read` collects the ticked chips + typed values.
  sentinels: ({ key, label }) => ({
    html:
      '<div class="rp-pred rp-pred--stack rp-sentinel-pick" data-key="' + esc(key) + '">'
      + '<label class="rp-pred-lbl">' + esc(label) + '</label>'
      + '<div class="rp-sentinel-found" data-sentinel-found>'
      +   '<span class="rp-sentinel-scanning">Scanning this file…</span>'
      + '</div>'
      + '<input class="rp-pred-val rp-sentinel-add" data-sentinel-add'
      +   ' placeholder="add your own — comma-separated (remembered in Settings)" />'
      + '</div>',
    read: (root) => {
      const wrap = root.querySelector('.rp-sentinel-pick[data-key="' + key + '"]');
      if (!wrap) return [];
      const picked = Array.from(
        wrap.querySelectorAll('input[type="checkbox"][data-sentinel-val]:checked')
      ).map((c) => c.getAttribute("data-sentinel-val"));
      const typed = (wrap.querySelector("[data-sentinel-add]")?.value || "")
        .split(",").map((t) => t.trim()).filter(Boolean);
      return [...new Set([...picked, ...typed])];
    },
  }),
};
