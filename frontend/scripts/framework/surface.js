/* Purpose: Surface framework component — the chrome'd content card + the canonical head→chip→stats→table inner assembly.
   Doc: docs/internal/code/frontend/scripts/framework/surface.md */
// ── Surface (framework component, CAS_37B2E1BF) ─────────────────────────────
// The surface is the chrome'd content CARD every railed page renders into
// (Home #rpHomeView, Monitoring #rpMonView, Workspace #wsSurface, Cases board)
// PLUS the canonical INNER ASSEMBLY those pages already share: a head row, an
// optional chip-row band, a stat strip, then the list table — in that fixed
// order. The visual surface order was previously enforced only by the
// builder call-order hand-copied into home.js / monitoring.js / cases.js;
// mountSurface makes the ORDER itself the component (the map's "JS builders are
// the real assembler" finding).
//
// COMPOSES the four sibling builders by direct import — it owns the container +
// the order, they own each slot's markup (the "lego brick" assembly):
//   • mountHead       (head.js)      → the rp-head object header (id/title/delete/close)
//   • mountChipRow    (chip-row.js)  → the rp-chip-row band (0..n filter chips)
//   • mountStatStrip  (stat.js)      → the rp-stat-hero / rp-list-composite / rp-stat-strip
//   • mountSimpleTable (table.js)    → the rp-table-wrap > rp-table list
// (The plain rp-shell-head title+count row — Home/Monitoring section header — is
//  surface chrome in surface.css, distinct from the Cases object header rp-head.)
// Each config section is OPTIONAL — omit it and its slot is skipped — mirroring
// the rail's optional-section pattern. A page supplies the four configs; the
// surface owns the structure + the order.
//
// The OUTER container chain (.rp-shell > .rp-shell-body > .rp-main > .rp-surface)
// is authored as static HTML in the page partials today; mountSurface treats the
// passed `host` AS the .rp-surface (host.className = "rp-surface"), the same
// host-becomes-root contract mountRail / mountTopbar use. The CSS for the whole
// chain (shell/body/main/surface + overview + strips + states) lives in the
// twin sheet framework/styles/surface.css.
//
// SECURITY: mountSurface itself interpolates no caller strings into innerHTML —
// it only builds empty slot wrappers and hands each to its sibling builder,
// which escapes its own dynamic content via esc(). The loading/empty state text
// is escaped here as defence-in-depth.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";
import { mountHead } from "/scripts/framework/head.js";
import { mountChipRow } from "/scripts/framework/chip-row.js";
import { mountStatStrip } from "/scripts/framework/stat.js";
import { mountSimpleTable } from "/scripts/framework/table.js";

// ── config shape (every section optional) ───────────────────────────────────
//   head      : { objectId, title, editable, onDelete, closeHash }  → mountHead (rp-head)
//   chipRow   : { name, label, chips, onChip }     → mountChipRow (rp-chip-row)
//   statStrip : { variant, stats, chartSlots }     → mountStatStrip (composite|kpi|hero)
//   table     : { columns, rows, … }               → mountSimpleTable (rp-table-wrap)
//   loading   : string                             → seed an rp-shell-state placeholder
// The four section keys map 1:1 to the four sibling builders; the surface
// composes them into the canonical order and returns handles to each so the
// page can drive them after mount.

/** Build the surface chrome + inner assembly into `host`. `host` becomes the
 *  `.rp-surface` element. Returns { el, head, chipRow, statStrip, table }. */
export function mountSurface(host, config = {}) {
  if (!host) return null;

  // host IS the surface card (the .rp-shell/.rp-shell-body/.rp-main chain is the
  // static partial wrapper around it). Preserve any id/extra classes the partial
  // set (e.g. #rpHomeView, .rp-cases-board) — only ensure rp-surface is present.
  host.classList.add("rp-surface");

  // NOTE: the Workspace three-mode machine (is-landing-mode / is-designer-mode)
  // is NOT handled here — its CSS lives in the workspace/dashboards lane
  // (is-designer-mode is already in dashboards.css) and the landing-mode rules
  // port WITH the workspace surface. Emitting a mode class the framework can't
  // style yet would be a half-port; the cases-overview surface uses no modes.

  // Loading/empty seed — the rp-shell-state twin of the rp-empty atom. When a
  // page hasn't data yet it renders this single placeholder and returns; the
  // real assembly replaces it on the next paint.
  if (config.loading != null) {
    host.innerHTML = '<p class="rp-shell-state">' + esc(config.loading) + '</p>';
    return { el: host, head: null, chipRow: null, statStrip: null, table: null };
  }

  // ── canonical assembly order: head → chip-row → stat-strip → table ─────────
  // Emit one empty slot wrapper per present section, in order, then hand each to
  // its sibling builder. The ORDER lives here — that is the surface component.
  host.innerHTML =
      (config.head      ? '<div data-surface-slot="head"></div>'   : "")
    + (config.chipRow   ? '<div data-surface-slot="chip"></div>'   : "")
    + (config.statStrip ? '<div data-surface-slot="stats"></div>'  : "")
    + (config.table     ? '<div data-surface-slot="table"></div>'  : "");

  const handles = { el: host, head: null, chipRow: null, statStrip: null, table: null };

  if (config.head) {
    handles.head = mountHead(host.querySelector('[data-surface-slot="head"]'), config.head);
  }
  if (config.chipRow) {
    handles.chipRow = mountChipRow(host.querySelector('[data-surface-slot="chip"]'), config.chipRow);
  }
  if (config.statStrip) {
    handles.statStrip = mountStatStrip(host.querySelector('[data-surface-slot="stats"]'), config.statStrip);
  }
  if (config.table) {
    handles.table = mountSimpleTable(host.querySelector('[data-surface-slot="table"]'), config.table);
  }

  return handles;
}

register("surface", mountSurface);
