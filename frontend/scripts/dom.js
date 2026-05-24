// dom.js — DOM utility primitives shared across every page that
// renders HTML strings. Extracted from 9 duplicate copies (audit
// 2026-05-24: `esc` x9, `cssEsc` x3, `escHTML` x2) so a bug fix in
// one place flows to every surface.

// HTML-attribute / text escape — the canonical version. Used by
// every `'<div>' + esc(value) + '</div>'` template across the
// frontend. Replace the 4 HTML-significant chars; leave everything
// else untouched (numeric/Unicode are fine in HTML5).
export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// CSS-selector escape — escapes characters that would break a
// querySelector when interpolated. Prefers the browser builtin
// (`CSS.escape`) when available; falls back to a regex-replace for
// the two characters we actually hit in practice (quotes +
// backslashes inside attribute selectors built from user RIDs).
export function cssEsc(s) {
  return window.CSS?.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, "\\$&");
}
