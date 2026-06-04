/* Purpose: Stat framework component — the rp-stat tile + the kpi/hero/composite strip grids.
   Doc: docs/internal/code/frontend/scripts/framework/stat.md */
// ── Stat (framework component, STAT-HERO) ───────────────────────────────────
// The rp-stat tile (a glass card = a label + a brand-typed value) and the three
// strip layouts that POSITION it: rp-stat-strip (standalone auto-fit grid),
// rp-stat-hero (3-col chart·stats·chart), rp-list-composite (5-col, same stats
// sub-grid; sub-grids are rp-stat-hero-stats / rp-list-composite-stats, flat-kebab). mountStatStrip(host, config) emits the whole rp-stat-* structure
// from a plain config of demo-able data — pages supply the data, the builder
// owns the structure ("lego brick").
//
// Composes, not duplicates:
//   - rp-label atom (.rp-stat context, margin zeroed) for the tile label
//   - rp-mono-pill atom for the inline run-summary chip (rp-stat--chip)
//   The brand-number value (rp-stat-value) is a NEW sub-element — no atom exists.
//
// Tiles take two shapes, both supported:
//   - baked   { label, value }  → value rendered inline, final at render
//   - async   { label, id }     → value starts as the '—' em-dash placeholder,
//                                  filled later by the returned `set(id, val)`
//                                  (the framework form of the legacy setKpi).
//
// Chart slots: the hero/composite grids reserve the flanking columns for
// rp-chart-card children (owned by the chart unit). This builder emits empty,
// layout-reserving slots (rp-chart-card--empty) for `chartSlots` so the column
// math reads correctly; the chart unit mounts canvases into them. This unit does
// NOT style rp-chart-card.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── config shape ─────────────────────────────────────────────────────────────
//   variant    : "kpi" | "hero" | "composite"   (default "kpi")
//   stats      : [{ label, value }]  (baked)  OR  [{ label, id }]  (async)
//   chartSlots : number   → how many empty rp-chart-card slots to reserve
//                           (hero positions slots as [chart][stats][chart];
//                            composite as [chart][chart][stats][chart][chart]).
//                           Ignored by the "kpi" variant (it has no chart slots).
// The em-dash placeholder for an async (id-bearing) tile, replaced in place by set().
const PLACEHOLDER = "—";

/** Build the stat strip into `host`. Returns a handle with a `set(id, val)`. */
export function mountStatStrip(host, config = {}) {
  if (!host) return null;
  const variant = config.variant || "kpi";
  const stats = config.stats || [];
  const slots = Number.isFinite(config.chartSlots) ? config.chartSlots : 0;

  if (variant === "hero") {
    host.className = "rp-stat-hero";
    // 3-col: [chart 0][stats sub-grid][chart 1]. Reserve one slot per flank.
    host.innerHTML =
        chartSlotHTML(0 < slots)
      + '<div class="rp-stat-hero-stats">' + statsHTML(stats) + '</div>'
      + chartSlotHTML(1 < slots);
  } else if (variant === "composite") {
    host.className = "rp-list-composite";
    // 5-col: [chart 0][chart 1][stats sub-grid][chart 2][chart 3].
    host.innerHTML =
        chartSlotHTML(0 < slots)
      + chartSlotHTML(1 < slots)
      + '<div class="rp-list-composite-stats">' + statsHTML(stats) + '</div>'
      + chartSlotHTML(2 < slots)
      + chartSlotHTML(3 < slots);
  } else {
    host.className = "rp-stat-strip";
    host.innerHTML = statsHTML(stats);
  }

  return {
    el: host,
    /** Fill an async tile's value in place; no-op if the tile isn't mounted. */
    set(id, val) {
      const el = host.querySelector("#" + id);
      if (el) el.textContent = val;
    },
  };
}

// ── tile renderers (pure HTML, all dynamic content via esc()) ────────────────

function statsHTML(stats) {
  return stats.map(tileHTML).join("");
}

// A single rp-stat tile. Baked tiles carry { value }; async tiles carry { id }
// and start as the '—' placeholder for a later set() call.
function tileHTML(t) {
  const value = t.id != null
    ? '<span class="rp-stat-value" id="' + esc(t.id) + '">' + PLACEHOLDER + '</span>'
    : '<span class="rp-stat-value">' + esc(String(t.value)) + '</span>';
  return '<div class="rp-stat">'
    + '<span class="rp-label rp-stat-label">' + esc(t.label) + '</span>'
    + value
    + '</div>';
}

// An empty chart slot the grid reserves for the chart unit to mount into. This
// unit does NOT style rp-chart-card; it only leaves the slot in the right column.
function chartSlotHTML(present) {
  if (!present) return "";
  return '<div class="rp-chart-card rp-chart-card--empty"><div class="rp-chart-canvas"></div></div>';
}

register("stat-strip", mountStatStrip);
