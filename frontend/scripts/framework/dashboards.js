/* Purpose: framework Dashboards/designer view — canvas → 12-col grid → tiles (+ config seam), rp-dash-*.
   Doc: docs/internal/code/frontend/scripts/framework/dashboards.md */
// ── Dashboards / designer view (framework component, CAS_37B2E1BF) ──────────
// A de-cased, RENDER-FIRST port of the chart Designer (legacy frontend/scripts/
// designer.js, ds-* / rt-designer / span-N classes) into ONE reusable framework
// component on the rp-dash-* namespace. Render-first: emits the full designer
// DOM — canvas → 12-col grid → tiles [head(title + actions) / body(chart slot)]
// + an optional config panel skeleton — from a plain `tiles[]` config, so the
// sandbox proves the view rebuilds from framework parts. The MARKUP CONTRACT
// lives here + framework/styles/dashboards.css (rp-dash-* twin of the ds-* CSS).
//
// Splits the legacy mountChartTile orchestrator the way the manifest asks:
//   • markup half  → makeTile() here (emits the empty .rp-dash-chart slot).
//   • behaviour half (window.echarts.init + setOption(buildOption) + the tiles[]
//     registry, drag/resize, inline-rename, accordion config binding, PUT/DELETE
//     persistence) → DEFERRED to the designer cutover. See the SEAM blocks below.
// A behaviorless tile body is just a placeholder chart slot (div.rp-dash-chart
// inside .rp-dash-tile-body) the cutover fills with an ECharts instance.
//
// Composes shared atoms — does NOT redefine them:
//   • rp-title for tile titles (text role; the tile-scoped clamp lives in CSS).
//   • rp-btn-icon + --accent (A1) for the config-panel Save CTA (was rp-btn-icon--accent);
//     rp-dash-config-save is the sizing modifier on top.
//   • rp-empty (A9) for the no-tiles state, + a .rp-dash-grid > .rp-empty context override.
//   • config-panel form controls (label/input) are deferred to the cutover (render-first).
//
// SECURITY: every interpolated field (tile title, rid, span, error message,
// config-panel title) is escaped via esc() before it reaches innerHTML. There is
// NO raw-HTML path here — all caller fields are plain strings, escaped. (Same
// defence-in-depth contract comments.js follows.) Never feed unsanitized HTML in.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── span normalisation ──────────────────────────────────────────────────────
// The legacy grid is 12 columns; single-chart tiles span 12, dashboard tiles
// span 6. A tile config carries either a numeric `span` (3/5/6/7/12) or a
// pre-formed "rp-dash-span-N" string. spanClass() maps both to the renamed
// helper class; unknown spans fall back to the full-width 12.
const SPANS = new Set([3, 5, 6, 7, 12]);
function spanClass(span) {
  if (typeof span === "string" && span.startsWith("rp-dash-span-")) return span;
  const n = Number(span);
  return "rp-dash-span-" + (SPANS.has(n) ? n : 12);
}

// ── tile head — title + the 4 action buttons (edit / save / delete / close) ──
// Mirrors makeTile()'s head (legacy designer.js 313–322). The save button starts
// disabled; the cutover flips it via markTileDirty/setTileBusy. Icons: bi-pencil
// (edit) · bi-save (save) · bi-trash3 (delete) · bi-x-lg (remove from canvas).
function tileHeadHTML(title) {
  return ''
    + '<div class="rp-dash-tile-head">'
    +   '<span class="rp-dash-tile-title rp-title">' + esc(title) + '</span>'
    +   '<div class="rp-dash-tile-actions">'
    +     '<button class="rp-dash-tile-act rp-dash-tile-edit"  type="button" title="Edit chart"><i class="bi bi-pencil"></i></button>'
    +     '<button class="rp-dash-tile-act rp-dash-tile-save"  type="button" title="Save chart" disabled><i class="bi bi-save"></i></button>'
    +     '<button class="rp-dash-tile-act rp-dash-tile-del"   type="button" title="Delete chart"><i class="bi bi-trash3"></i></button>'
    +     '<button class="rp-dash-tile-act rp-dash-tile-close" type="button" title="Remove from canvas"><i class="bi bi-x-lg"></i></button>'
    +   '</div>'
    + '</div>';
}

// ── tile — the canonical single-tile markup ──────────────────────────────────
// Render-only port of makeTile() (legacy designer.js 304–325). Reads ONLY the
// tile title (head), redpash_id (data-rid), selected, and span — the body is the
// empty .rp-dash-chart mount slot. The ECharts init that fills that slot is the
// behaviour half, DEFERRED to the cutover (see mountDashboardView's SEAM note).
function tileHTML(tile) {
  const rid = tile.redpash_id || tile.rid || "";
  const title = tile.title || "Untitled chart";
  const cls = "rp-dash-tile"
    + (tile.selected ? " is-selected" : "")
    + (tile.dirty ? " rp-dash-tile--dirty" : "")
    + " " + spanClass(tile.span);
  return '<div class="' + cls + '" data-rid="' + esc(rid) + '">'
    +   tileHeadHTML(title)
    +   '<div class="rp-dash-tile-body">'
    +     '<div class="rp-dash-chart"></div>'   // SEAM: empty ECharts slot; cutover does echarts.init() here
    +   '</div>'
    + '</div>';
}

// ── error tile — recoverable placeholder for a widget whose chart failed ──────
// Render-only port of makeErrorTile() (legacy designer.js 240–250): same
// head/body skeleton as a real tile, but the body holds .rp-dash-tile-err with a
// warning glyph + the esc()'d message instead of a chart canvas.
function errorTileHTML(tile) {
  const title = tile.title || "Chart unavailable";
  const msg = tile.error || "couldn’t fetch widget";
  return '<div class="rp-dash-tile rp-dash-tile--error ' + spanClass(tile.span || 6) + '"'
    + (tile.rid ? ' data-rid="' + esc(tile.rid) + '"' : '') + '>'
    +   '<div class="rp-dash-tile-head"><span class="rp-dash-tile-title rp-title">' + esc(title) + '</span></div>'
    +   '<div class="rp-dash-tile-body">'
    +     '<div class="rp-dash-tile-err">'
    +       '<i class="bi bi-exclamation-triangle"></i> ' + esc(msg)
    +     '</div>'
    +   '</div>'
    + '</div>';
}

// ── grid — tiles, or the empty-state message ──────────────────────────────────
// Walks the config's tiles[]; an `error` field routes a tile to the error
// variant. With no tiles, emits the rp-empty atom (collapses legacy ds-empty);
// the dashboard centring (margin + grid-column:1/-1) is a CSS context override
// on .rp-dash-grid > .rp-empty, NOT a redefinition of the atom.
function gridHTML(tiles, emptyText) {
  if (!tiles.length) {
    return '<p class="rp-empty">' + esc(emptyText || "No chart loaded.") + '</p>';
  }
  return tiles.map((t) => (t.error ? errorTileHTML(t) : tileHTML(t))).join("");
}

// ── config panel — accordion skeleton (the .rp-dash-config aside) ─────────────
// The legacy designer hands its empty <aside.ds-config> to mountBuilder (in
// /scripts/charts/builder-ui.js), which owns the head + the six-section accordion
// (type/data/axes/legend/tooltip/style). The render-first port re-emits that
// CONTRACT as collapsed shells so the sandbox shows the panel structure; the
// per-section control bodies + open/close + dirty-tracking binding are the
// behaviour half, DEFERRED to the cutover (where this delegates to mountBuilder).
const CONFIG_SECTIONS = [
  { sec: "type",    icon: "bi-bar-chart",        label: "Type" },
  { sec: "data",    icon: "bi-database",         label: "Data" },
  { sec: "axes",    icon: "bi-rulers",           label: "Axes" },
  { sec: "legend",  icon: "bi-list-ul",          label: "Legend" },
  { sec: "tooltip", icon: "bi-chat-square-text", label: "Tooltip" },
  { sec: "style",   icon: "bi-palette",          label: "Style" },
];

function configSectionHTML(s, open) {
  return '<div class="rp-dash-sec' + (open ? " is-open" : "") + '" data-sec="' + esc(s.sec) + '">'
    +   '<button class="rp-dash-sec-head" type="button">'
    +     '<i class="bi bi-chevron-down rp-dash-sec-caret"></i>'
    +     '<i class="bi ' + esc(s.icon) + ' rp-dash-sec-icon"></i>'
    +     '<span class="rp-dash-sec-label">' + esc(s.label) + '</span>'
    +   '</button>'
    +   '<div class="rp-dash-sec-body"></div>'   // SEAM: cutover fills with rp-input/rp-label controls bound to the tile cfg
    + '</div>';
}

function configHTML(title) {
  const sections = CONFIG_SECTIONS
    .map((s, i) => configSectionHTML(s, i === 0))   // first section open by default
    .join("");
  return '<aside class="rp-dash-config">'
    +   '<div class="rp-dash-config-head">'
    +     '<span class="rp-dash-config-title"><i class="bi bi-sliders"></i> ' + esc(title || "Chart") + '</span>'
    +     '<button class="rp-btn-icon rp-btn-icon--accent rp-dash-config-save" type="button" disabled>Save</button>'
    +   '</div>'
    +   '<div class="rp-dash-config-body">' + sections + '</div>'
    + '</aside>';
}

/**
 * Render the Dashboards/designer view (canvas + 12-col tile grid + optional
 * config panel) into `host`. Render-first: emits markup only — ECharts init,
 * drag/resize, inline rename, accordion binding, and persistence are DEFERRED
 * to the designer cutover (see the SEAM comments above). Self-registers as
 * `"dashboards"` in the component registry.
 *
 * @param {Element} host  the designer shell container (gets class rp-dash-shell).
 * @param {Object}  [opts]
 * @param {Array<{redpash_id?:string, rid?:string, title?:string,
 *                type?:string, span?:(number|string), selected?:boolean,
 *                dirty?:boolean, error?:string, body?:string}>} [opts.tiles]
 *        Tile config. Each tile renders head(title + actions) + an empty
 *        .rp-dash-chart slot; `span` ∈ {3,5,6,7,12} (or a "rp-dash-span-N"
 *        string) → grid column-span; `selected`/`dirty` toggle the is-selected /
 *        rp-dash-tile--dirty state; an `error` string routes to the error tile.
 * @param {boolean} [opts.config=true]   render the config-panel skeleton aside.
 * @param {boolean} [opts.configHidden]  collapse the config panel (rp-dash-config-hidden).
 * @param {string}  [opts.configTitle]   config-panel head label (default "Chart").
 * @param {string}  [opts.emptyText]     empty-state message when tiles is empty.
 * @returns {Element} host
 */
export function mountDashboardView(host, opts = {}) {
  if (!host) return;
  const tiles = Array.isArray(opts.tiles) ? opts.tiles : [];
  const showConfig = opts.config !== false;

  host.className = "rp-dash-shell" + (opts.configHidden ? " rp-dash-config-hidden" : "");
  host.innerHTML =
      '<div class="rp-dash-canvas">'
    +   '<div class="rp-dash-grid">' + gridHTML(tiles, opts.emptyText) + '</div>'
    + '</div>'
    + (showConfig ? configHTML(opts.configTitle) : '');

  // SEAM: behaviour wiring lands at the designer cutover, when designer.js
  // deletes its inline makeTile/makeErrorTile/mountChartTile/renderCanvasEmpty
  // builders and delegates here. At that point this component:
  //   • resolves the ECharts theme + window.echarts.init(each .rp-dash-chart)
  //     and setOption(buildOption(cfg, t)); pushes entries to a tiles[] registry,
  //   • wires tile-head actions (edit/save/delete/close) + inline title rename,
  //   • delegates the .rp-dash-config aside to mountBuilder (builder-ui.js) for
  //     the six-section accordion + dirty-tracking save,
  //   • exposes load(payload) / resize() / unmount() / addChartWidget(chart) /
  //     getOpenDashboardRid() / getOpenDashboard() (the legacy control object).
  // Render-first stays markup-only so the sandbox proves the view first.

  return host;
}

register("dashboards", mountDashboardView);
