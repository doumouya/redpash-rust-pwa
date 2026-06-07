/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/rail-controls.md */
// Rail interaction helpers — the two rail-control patterns that were
// hand-rolled per page (Em 2026-05-29 consolidation batch). The CSS
// atoms (.rp-rail / .rp-seg--rail) were already shared; this dedups
// the JS wiring so a new railed page (or a 3rd view-toggle) gets the
// behavior for free instead of copy-pasting it.
//
//   mountRailCollapse(rail, btn)   — the chevron collapse toggle that
//     was reimplemented 7× (workspace / home / cases / monitoring /
//     docs / settings / profile).
//   mountRailSeg(segEl, opts)      — the 2-option .rp-seg--rail toggle
//     that switches the rail's body view + persists a pref (workspace
//     Data↔Dashboards, cases Internal↔External).

import { getPref, setPref } from "/scripts/prefs.js";

// Collapse toggle — flips the rail's `.compact` modifier (rail.css
// shrinks it to the 3.75rem icon-only width) and swaps the chevron
// direction + the button title. classList.toggle on the icon (vs a
// full className rewrite) preserves any other icon classes.
export function mountRailCollapse(rail, btn) {
  if (!rail || !btn) return;
  btn.addEventListener("click", () => {
    const compact = rail.classList.toggle("compact");
    const icon = btn.querySelector("i");
    if (icon) {
      icon.classList.toggle("bi-chevron-double-left", !compact);
      icon.classList.toggle("bi-chevron-double-right", compact);
    }
    btn.title = compact ? "Expand" : "Collapse";
  });
}

// Rail segmented toggle — a 2+-option `.rp-seg--rail` whose buttons
// carry `data-rail-seg="<value>"`. Owns: click→persist→is-active sync,
// pref seeding + initial sync on mount. The caller supplies what the
// switch *does* via `onChange(value)` (CSS row-filter, server refetch,
// view swap — the helper doesn't care).
//
//   pref        — pref key to persist the active value under
//   fallback    — default value when the pref is unset
//   onChange    — called with the new value on an actual change (click)
//                 and on every explicit set(); NOT on mount unless
//                 fireOnMount is set
//   fireOnMount — also call onChange(initial) after the mount-time sync
//                 (use when the effect must apply on load, e.g.
//                 workspace's CSS row-filter attribute)
//
// Returns { set(value), current() } — `set` applies + fires onChange
// unconditionally (for "force this view after creating an object"
// flows); the click path no-ops when the value is unchanged.
export function mountRailSeg(segEl, { pref, fallback = null, onChange = null, fireOnMount = false } = {}) {
  const read = () => getPref(pref) || fallback;
  if (!segEl) return { set() {}, current: read };

  function sync(value) {
    segEl.querySelectorAll("[data-rail-seg]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.railSeg === value));
  }
  function set(value) {
    setPref(pref, value);
    sync(value);
    if (onChange) onChange(value);
  }

  segEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rail-seg]");
    if (!btn || !btn.dataset.railSeg) return;
    if (btn.dataset.railSeg === read()) return;   // already active — no-op
    set(btn.dataset.railSeg);
  });

  if (getPref(pref) == null && fallback != null) setPref(pref, fallback);
  sync(read());
  if (fireOnMount && onChange) onChange(read());

  return { set, current: read };
}
