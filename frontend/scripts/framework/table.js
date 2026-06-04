/* Purpose: Simple read-only table framework component — static thead/tbody render with priority-dot/status/id cells + row-click navigation, rp-table-*.
   Doc: docs/internal/code/frontend/scripts/framework/table.md */
// ── Simple table (framework component, CAS_37B2E1BF) ─────────────────────────
// The SIMPLE, read-only table: flat <thead>/<tbody> rebuilt wholesale on each
// render. This is NOT the full B3 RedTable — there is deliberately NO column
// sort, NO selection checkbox column, NO row-number column, NO inline-edit /
// delete mode, NO drag-reorder, NO pager, NO virtualization observer. Those are
// the interactive layers of a separate `rp-redtable` component that shares the
// same `rp-table` base. mountSimpleTable(host, config) emits the whole
// rp-table-* structure from a plain config of columns + rows (+ optional empty
// text + onRowClick), so a page supplies the data and the builder owns the
// structure + the one behavior the simple table has: row-click.
//
// Composes shared atoms — does NOT redefine them:
//   • rp-empty (A9) for the no-rows state (was .rt-empty + .rp-cases-ov-table-empty).
//   • rp-status (A12) for status-pill cells (kind:"status") — tone via is-* state.
//   • rp-mono-pill (A10) for inline id/method/kind cells (kind:"id").
// Cell GLYPH it owns (a reusable cell helper, not an atom): rp-priority-dot —
// the de-cased rp-cases-priority-dot, with all 4 tone states
// (is-low/medium/high/critical; critical adds a box-shadow ring). priorityDotHTML()
// emits it; the rail-context size override lives in table.css.
//
// SECURITY: every interpolated field (column label, cell value, dot title) is
// escaped via esc() before it reaches innerHTML. There is NO raw-HTML path here;
// all caller fields are plain strings, escaped. Never feed unsanitized HTML in.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── config shape ─────────────────────────────────────────────────────────────
//   columns : [{ key, label, kind }]   kind ∈ undefined|"text"|"num"|"status"|
//                                       "priority"|"id" — decides cell rendering
//   rows    : [ { <key>: value, … } ]  one object per row; cells read row[col.key]
//             a row MAY carry `rid` (string) → set on <tr data-rid> for click-nav
//   empty   : string                   text shown when rows is empty (default "—")
//   onRowClick : (rid, row) => void     fires when a row carrying a rid is clicked
// The builder owns the DOM + the row-click delegation; the caller owns what the
// click does (e.g. navigate to a detail hash).

const PRIORITY_TONES = new Set(["low", "medium", "high", "critical"]);

/** The priority-dot cell glyph (de-cased rp-cases-priority-dot). `level` ∈
 *  low|medium|high|critical → tone class; unknown level = the muted base dot.
 *  `label` (optional) trailing text rendered after the dot. */
export function priorityDotHTML(level, label) {
  const tone = PRIORITY_TONES.has(level) ? " is-" + level : "";
  const title = level ? ' title="Priority: ' + esc(level) + '"' : "";
  const dot = '<span class="rp-priority-dot' + tone + '"' + title + "></span>";
  return label == null || label === "" ? dot : dot + " " + esc(String(label));
}

// ── cell rendering — kind decides the composed atom / glyph ──────────────────
function cellHTML(col, row) {
  const raw = row[col.key];
  switch (col.kind) {
    case "priority":
      // value is the priority level (low|medium|high|critical); the dot carries
      // the tone, the level text trails it (matches the legacy Priority cell).
      return priorityDotHTML(raw, raw);
    case "status":
      // rp-status atom + tone state. The row may carry a per-column tone via
      // row[col.key + "Tone"] (e.g. "is-active"); else no tone (plain pill).
      {
        const tone = row[col.key + "Tone"];
        return '<span class="rp-status' + (tone ? " " + esc(tone) : "") + '">'
          + esc(raw == null ? "" : String(raw)) + "</span>";
      }
    case "id":
      // rp-mono-pill atom — inline monospace id/method/kind cell.
      return '<span class="rp-mono-pill">' + esc(raw == null ? "" : String(raw)) + "</span>";
    default:
      return esc(raw == null ? "" : String(raw));
  }
}

function theadHTML(columns) {
  const ths = columns.map((c) =>
    "<th" + (c.kind === "num" ? ' class="is-num"' : "") + ">" + esc(c.label || "") + "</th>"
  ).join("");
  return "<thead><tr>" + ths + "</tr></thead>";
}

function rowHTML(columns, row) {
  const rid = row.rid;
  const tds = columns.map((c) =>
    "<td" + (c.kind === "num" ? ' class="is-num"' : "") + ">" + cellHTML(c, row) + "</td>"
  ).join("");
  return '<tr class="rp-table-row"' + (rid != null ? ' data-rid="' + esc(String(rid)) + '"' : "")
    + ">" + tds + "</tr>";
}

/** Build the simple table's inner HTML (thead + tbody) OR the empty state. */
function tableHTML(config) {
  const columns = config.columns || [];
  const rows = config.rows || [];
  if (!rows.length) {
    return '<p class="rp-empty rp-table-empty">' + esc(config.empty || "—") + "</p>";
  }
  return '<table class="rp-table">'
    + theadHTML(columns)
    + "<tbody>" + rows.map((r) => rowHTML(columns, r)).join("") + "</tbody>"
    + "</table>";
}

/** Build + wire the simple table into `host`. `host` becomes the `.rp-table-wrap`
 *  scroll container; the <table class="rp-table"> (or empty state) is rebuilt on
 *  every render() so the row-click delegate (bound to the persistent host) keeps
 *  working across rebuilds. Returns { el, render(config) }. */
export function mountSimpleTable(host, config = {}) {
  if (!host) return null;
  let current = config;
  host.classList.add("rp-table-wrap");
  host.innerHTML = tableHTML(current);

  // Row-click is delegated on the persistent host (survives innerHTML rebuilds).
  host.addEventListener("click", (e) => {
    const fn = current.onRowClick;
    if (!fn) return;
    const tr = e.target.closest(".rp-table-row");
    if (!tr || !host.contains(tr)) return;
    const rid = tr.dataset.rid;
    if (rid) fn(rid, tr);
  });

  return {
    el: host,
    /** Re-render the table in place from a new config (merged over the mount one). */
    render(next) {
      current = { ...current, ...(next || {}) };
      host.innerHTML = tableHTML(current);
    },
  };
}

register("table", mountSimpleTable);
