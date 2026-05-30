/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/page-row.md */
// page-row.js — `.rp-page__row` template helpers.
//
// Settings + Profile are largely a stack of `.rp-page__row` instances
// repeating the same label / control skeleton. The audit (html-audit
// 2026-05-25) flagged `page__row` as the highest-saved candidate
// (~48 LOC across 11 occurrences spanning both pages). The pages now
// declare their rows as data + ship one render call; structural
// drift between flavors can't accumulate silently any more.
//
// Four flavors cover every page__row site today; each is one helper
// here. Helpers return HTML strings (the codebase pattern — same as
// kpiStripHTML / compositeStripHTML / chartsStripHTML in list-page.js).
// Click delegation in the consuming page reads `[data-pref]` +
// `[data-value]` attributes; helpers emit them.

import { esc } from "/scripts/dom.js";

// Shared label cell. `hint` renders as a small under the label;
// `hintClass` carries the per-page modifier (rp-settings__hint /
// rp-profile__hint).
function labelHTML(spec) {
  let s = '<span class="rp-page__row-label">' + esc(spec.label);
  if (spec.hint) {
    const cls = spec.hintClass || "rp-settings__hint";
    s += ' <small class="' + esc(cls) + '">' + esc(spec.hint) + '</small>';
  }
  s += '</span>';
  return s;
}

function rowOpen(spec) {
  const cls = spec.col ? 'rp-page__row rp-page__row--col' : 'rp-page__row';
  return '<div class="' + cls + '">';
}

function btnHTML(opt) {
  const cls   = 'rt-btn';
  const title = opt.title ? ' title="' + esc(opt.title) + '"' : '';
  const icon  = opt.icon  ? '<i class="bi bi-' + esc(opt.icon) + '"></i> ' : '';
  return '<button class="' + cls + '" type="button" data-value="'
    + esc(opt.value) + '"' + title + '>' + icon + esc(opt.label) + '</button>';
}

// Options-group row — buttons under a single `[data-pref]` group.
// Click delegation in settings.js / profile.js wires the rest.
//
//   { label, hint?, hintClass?, col?, pref, options:[{value,label,icon?,title?}] }
export function prefRow(spec) {
  return rowOpen(spec)
    + labelHTML(spec)
    + '<div class="rp-page__row-control" data-pref="' + esc(spec.pref) + '">'
    + spec.options.map(btnHTML).join("")
    + '</div>'
    + '</div>';
}

// Readonly value row — label + a `<span>` value mount filled at
// runtime (display name, username, etc).
//
//   { label, hint?, hintClass?, col?, id, initial? }
export function valueRow(spec) {
  return rowOpen(spec)
    + labelHTML(spec)
    + '<span class="rp-page__row-value" id="' + esc(spec.id) + '">'
    + esc(spec.initial == null ? "—" : spec.initial)
    + '</span>'
    + '</div>';
}

// Actions row — a set of buttons / links inside `.rp-page__row-control`
// with no `[data-pref]` (the click handlers wire by id or href).
//
//   { label, hint?, hintClass?, col?, actions:[{kind:"button"|"a", id?, href?, label, icon?, title?}] }
export function actionsRow(spec) {
  const item = (a) => {
    const icon  = a.icon  ? '<i class="bi bi-' + esc(a.icon)  + '"></i> ' : '';
    const title = a.title ? ' title="' + esc(a.title) + '"' : '';
    if (a.kind === "a") {
      return '<a class="rt-btn" href="' + esc(a.href || "#") + '"' + title
        + (a.id ? ' id="' + esc(a.id) + '"' : '') + '>' + icon + esc(a.label) + '</a>';
    }
    return '<button class="rt-btn" type="button"'
      + (a.id ? ' id="' + esc(a.id) + '"' : '') + title + '>'
      + icon + esc(a.label) + '</button>';
  };
  return rowOpen(spec)
    + labelHTML(spec)
    + '<div class="rp-page__row-control">'
    + spec.actions.map(item).join("")
    + '</div>'
    + '</div>';
}

// Input-field row — label + a single `<input>` in the control cell.
// Covers profile's display-name / username / email / job-title rows.
// `readonly` defaults to true (Profile starts read-only; edit-mode
// toggles `[name]` inputs writable via setEditMode).
//
//   { label, hint?, hintClass?, col?, id, type?, name?, autocomplete?, placeholder?, readonly? }
export function inputRow(spec) {
  const type = spec.type || "text";
  const attrs = [
    'id="' + esc(spec.id) + '"',
    'class="rp-input"',
    'type="' + esc(type) + '"',
  ];
  if (spec.name)         attrs.push('name="' + esc(spec.name) + '"');
  if (spec.autocomplete) attrs.push('autocomplete="' + esc(spec.autocomplete) + '"');
  if (spec.placeholder)  attrs.push('placeholder="' + esc(spec.placeholder) + '"');
  if (spec.readonly !== false) attrs.push('readonly');
  return rowOpen(spec)
    + labelHTML(spec)
    + '<span class="rp-page__row-control">'
    + '<input ' + attrs.join(" ") + ' />'
    + '</span>'
    + '</div>';
}

// Mount-point row — col-stacked container the page fills async at
// mount (sentinels, memberships). `containerClass` / `emptyClass`
// carry the per-page modifier.
//
//   { label, hint?, hintClass?, id, containerClass, emptyClass, initial }
export function mountRow(spec) {
  return '<div class="rp-page__row rp-page__row--col">'
    + labelHTML(spec)
    + '<div class="' + esc(spec.containerClass) + '" id="' + esc(spec.id) + '">'
    + '<span class="' + esc(spec.emptyClass) + '">'
    + esc(spec.initial || "Loading…")
    + '</span>'
    + '</div>'
    + '</div>';
}
