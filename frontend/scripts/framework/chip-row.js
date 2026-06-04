/* Purpose: Chip-row framework component — the horizontal meta/filter pill row that composes the rp-chip atom.
   Doc: docs/internal/code/frontend/scripts/framework/chip-row.md */
// ── Chip-row (framework component, CAS_37B2E1BF) ────────────────────────────
// The horizontal pill-selector: a flat flex container (rp-chip-row) holding an
// optional muted label (rp-chip-row-label) before a run of rp-chip atoms — the
// canonical segmented-control look (rounded capsule, the active option carries
// .is-active). Generic + data-driven: mountChipRow(host, config) emits the
// rp-chip-row structure from a config of chips + an onChip handler, so a page
// supplies the data and the builder owns the structure + the delegated click
// ("lego brick").
//
// Composes, not duplicates:
//   - rp-chip atom (atoms.css A4) for every chip — the row is JUST the flex
//     container; chip styling lives in the atom, NEVER redeclared here.
// The per-context variants (cases rail flat-wrap, done-window, detail-path) are
// CSS ancestor-overrides (chip-row.css), reached by passing rowClass / chipClass
// + the relevant data-* attribute name — not separate builders.
//
// The data-* attribute contract is load-bearing + NON-uniform per context
// (data-value for Home, data-window for Monitoring, data-chip-assignee for the
// cases rail, …) and is read by handlers, the main.js audit MutationObserver,
// and audit/snapshot.js. The builder keeps the caller's chosen attribute name
// AND always sets data-value when a value is present, so the cross-cutting audit
// observer (which reads data-value on .rp-chip.is-active) keeps working.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

// ── config shape ────────────────────────────────────────────────────────────
//   label    : string                         → optional rp-chip-row-label prefix
//   name     : string                         → data-chip-name on the row (Home)
//   chips    : [{ value, label, active, disabled, title }]
//   attr     : string  (default "value")      → the chip's data-<attr> key, e.g.
//              "window" → data-window; "chip-assignee" → data-chip-assignee. The
//              builder ALSO emits data-value (the audit-observer contract) when a
//              value is present, unless attr is already "value".
//   rowClass : string                         → extra class(es) on the row, for a
//              CSS variant ancestor (e.g. "rp-cases-done-window")
//   chipClass: string                         → extra class(es) on every chip
//              (e.g. "rp-cases-done-chip")
//   role     : string, ariaLabel : string     → a11y on the row (e.g. role="group")
//   onChip   : (value, chip, row) => void      → delegated click handler
// The handler receives the clicked chip's value + the chip/row elements; the
// builder flips .is-active (clears siblings, sets the clicked) before calling it.

/** Build + wire the chip-row into `host`. `host` becomes the `.rp-chip-row`. */
export function mountChipRow(host, config = {}) {
  if (!host) return null;
  const attr = config.attr || "value";

  host.className = ("rp-chip-row " + (config.rowClass || "")).trim();
  if (config.name != null) host.setAttribute("data-chip-name", String(config.name));
  if (config.role) host.setAttribute("role", config.role);
  if (config.ariaLabel) host.setAttribute("aria-label", config.ariaLabel);

  host.innerHTML = labelHTML(config) + chipsHTML(config, attr);

  // One delegated click routes every chip — survives a re-render via setChips
  // without re-binding per element.
  host.addEventListener("click", (e) => {
    const chip = e.target.closest(".rp-chip");
    if (!chip || !host.contains(chip) || chip.disabled) return;
    const value = chip.dataset[camel(attr)] ?? chip.dataset.value ?? "";
    host.querySelectorAll(".rp-chip.is-active").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
    config.onChip?.(value, chip, host);
  });

  return {
    el: host,
    /** Re-render the chips in place (e.g. async per-agent chips) after a data change. */
    setChips(chips) {
      host.innerHTML = labelHTML(config) + chipsHTML({ ...config, chips }, attr);
    },
    /** Programmatically mark a value active (clears siblings) — for pref-driven init. */
    select(value) {
      host.querySelectorAll(".rp-chip").forEach((c) => {
        const v = c.dataset[camel(attr)] ?? c.dataset.value ?? "";
        c.classList.toggle("is-active", v === String(value));
      });
    },
  };
}

// ── section renderers (pure HTML, all dynamic content via esc()) ─────────────

function labelHTML(c) {
  return c.label ? '<span class="rp-chip-row-label">' + esc(c.label) + '</span>' : "";
}

function chipsHTML(c, attr) {
  return (c.chips || []).map((ch) => {
    const extra = c.chipClass ? " " + c.chipClass : "";
    // The caller's data-<attr> carries the value; ALSO emit data-value (unless
    // attr already IS "value") so the cross-cutting audit observer keeps reading it.
    const valAttr = ' data-' + esc(attr) + '="' + esc(ch.value) + '"';
    const auditAttr = attr === "value" ? "" : ' data-value="' + esc(ch.value) + '"';
    return '<button type="button" class="rp-chip' + (ch.active ? " is-active" : "") + extra + '"'
      + valAttr + auditAttr
      + (ch.disabled ? " disabled" : "")
      + (ch.title ? ' title="' + esc(ch.title) + '"' : "")
      + '>' + esc(ch.label) + '</button>';
  }).join("");
}

// dataset keys are camelCased: data-chip-assignee → dataset.chipAssignee.
function camel(attr) {
  return attr.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

register("chip-row", mountChipRow);
