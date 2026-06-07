/* Purpose: Toolbar framework component — the RedTable control strip (search + modes + paging/cols/export/history), config-driven so one builder serves the Workspace DATA toolbar and the list-view subset.
   Doc: docs/internal/code/frontend/scripts/framework/toolbar.md */
// ── Toolbar (framework component, CAS_37B2E1BF) ──────────────────────────────
// The INTERACTIVE control strip above the rp-table: filter + search + edit/select/
// delete modes + undo/redo/refresh/rownum + rows-per-page pill + columns picker +
// selection chip + export + history/tools. UNIFIES the divergent live consumers
// into ONE config-driven builder:
//   - workspace.js — the canonical FULL data toolbar (static in workspace.html).
//   - list-page.js listToolbarHTML(spec) — a Workspace-parity SUBSET (most controls
//     disabled stubs; wired: search, refresh, rows, select/delete modes, sel-chip).
//   - tools.js — an in-panel column-manager variant (out of scope here; it wraps).
// Omit a config key → omit that control, so the same builder emits the full or the
// subset toolbar without forking templates ([[display-none-per-page]] in code).
//
// Composes, not duplicates:
//   - rp-btn-icon / --glass / --accent (atoms.css A1) — every button (was rp-btn-icon).
//   - rp-search (atoms.css A3) — the search box (was rt-search; already an atom).
//   - rp-chip (atoms.css A4) — the rows pill + selection chip, via the .rp-toolbar
//     context overrides (.rp-toolbar-pill / .rp-toolbar-selchip in toolbar.css).
//   - mountMenu + bindMenu (menu.js) — the 4 dropdowns (rows/cols/export/history);
//     the trigger is a [data-dd] button, the panel a .rp-menu. bindMenu's single
//     delegate drives open/close (mutex + outside-click); item clicks route through
//     the toolbar's own delegated handler below.
//
// State is NOT owned here. selectedRows / activeSteps / activeFilter / pageSize live
// in the page controller; the toolbar reaches OUT only via the config callbacks
// (onSearch / onMode / onUndo / …). The cols-picker + rownum mutate the table DOM,
// which is the consumer's job from the change callbacks — the toolbar emits the
// controls + fires the events, the page wires them to its table/closure state.
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { bindMenu } from "/scripts/framework/menu.js";
import { esc } from "/scripts/dom.js";

// ── config shape (every section optional → omit a key, omit that control) ─────
//   variant     : "data" | "designer"          → adds .rp-toolbar--data / --designer
//   className    : string                        → extra classes on the bar (e.g.
//                                                  "rp-list-toolbar" for list views)
//   filterToggle : { active, title }             → the filter button (.has-filter
//                                                  when active); fires onFilter
//   onFilter     : () => void
//   search       : { placeholder, value, onInput(q) }  → rp-search box
//   modes        : [{ mode, icon, title, active, disabled }]  → rp-toolbar-mode btns
//   onMode       : (mode) => void
//   undoRedo     : { undoDisabled, redoDisabled } → undo + redo buttons
//   onUndo / onRedo : () => void
//   refresh      : { title, disabled }            → refresh button (spins on click)
//   onRefresh    : () => void
//   rownum       : { active, title }              → row-number toggle
//   onRownum     : () => void
//   rows         : { options:[n…], value, label }  → rows-per-page pill + rp-menu
//   onRows       : (n) => void
//   cols         : { items:[{ index, label, checked }], disabled, title }  → cols rp-menu
//   onCol        : (index, checked) => void
//   selChip      : { count, show }                 → selection chip
//   onSelChip    : () => void
//   export       : { items:[{ fmt, label, icon }], disabled, title }  → export rp-menu
//   onExport     : (fmt) => void
//   history      : { items:[{ label, meta, icon }], title }  → history rp-menu
//   tools        : { active, title }               → tools-panel toggle; onTools
//   onTools      : () => void
//   designer     : { title, icon, addLabel, cfgActive }  → the --designer children
//   onAddChart / onCfgToggle : () => void

const ICON_FILTER  = "bi-funnel";
const ICON_UNDO    = "bi-arrow-return-left";
const ICON_REDO    = "bi-arrow-return-right";
const ICON_REFRESH = "bi-arrow-clockwise";
const ICON_ROWNUM  = "bi-list-ol";
const ICON_COLS    = "bi-layout-three-columns";
const ICON_SELCHIP = "bi-check2-square";
const ICON_EXPORT  = "bi-download";
const ICON_HISTORY = "bi-clock-history";
const ICON_TOOLS   = "bi-tools";

/** Build + wire the toolbar into `host`. `host` becomes the `.rp-toolbar` element.
 *  Returns { el, render(config), setSelection(count) } — render re-emits in place
 *  after a data change (matches the live re-render-in-place use). Self-registers
 *  as "toolbar". */
export function mountToolbar(host, config = {}) {
  if (!host) return null;
  let cfg = config;

  function sep() { return '<span class="rp-toolbar-sep"></span>'; }

  // ── per-control HTML (a missing config key emits "" → control omitted) ──────
  function filterHTML(c) {
    if (!c.filterToggle) return "";
    const f = c.filterToggle;
    return btn({
      cls: "rp-btn-icon" + (f.active ? " has-filter" : ""),
      action: "filter",
      icon: ICON_FILTER,
      title: f.title || "Filter",
    });
  }

  function searchHTML(c) {
    if (!c.search) return "";
    return '<div class="rp-search">'
      + '<i class="bi bi-search"></i>'
      + '<input type="search" data-tb-search placeholder="' + esc(c.search.placeholder || "Search…") + '"'
      + (c.search.value ? ' value="' + esc(c.search.value) + '"' : "") + " />"
      + "</div>";
  }

  function modesHTML(c) {
    if (!c.modes?.length) return "";
    return c.modes.map((m) =>
      '<button type="button" class="rp-btn-icon rp-toolbar-mode' + (m.active ? " is-active" : "") + '"'
      + ' data-tb-action="mode" data-mode="' + esc(m.mode) + '"'
      + (m.disabled ? " disabled" : "")
      + ' title="' + esc(m.title || m.mode) + '"><i class="bi ' + esc(m.icon) + '"></i></button>'
    ).join("");
  }

  function undoRedoHTML(c) {
    if (!c.undoRedo) return "";
    const u = c.undoRedo;
    return btn({ cls: "rp-btn-icon", action: "undo", icon: ICON_UNDO, title: "Undo", disabled: u.undoDisabled })
      + btn({ cls: "rp-btn-icon", action: "redo", icon: ICON_REDO, title: "Redo", disabled: u.redoDisabled });
  }

  function refreshHTML(c) {
    if (!c.refresh) return "";
    return '<button type="button" class="rp-btn-icon" data-tb-action="refresh"'
      + (c.refresh.disabled ? " disabled" : "")
      + ' title="' + esc(c.refresh.title || "Refresh") + '">'
      + '<i class="bi ' + ICON_REFRESH + ' rp-toolbar-spin"></i></button>';
  }

  function rownumHTML(c) {
    if (!c.rownum) return "";
    return btn({
      cls: "rp-btn-icon" + (c.rownum.active ? " is-active" : ""),
      action: "rownum",
      icon: ICON_ROWNUM,
      title: c.rownum.title || "Row numbers",
    });
  }

  // The rows pill is an rp-chip composed with the .rp-toolbar-pill context shape:
  // a left-label trigger + trailing chevron, opening the rows rp-menu.
  function rowsHTML(c) {
    if (!c.rows?.options?.length) return "";
    const label = c.rows.label != null ? c.rows.label : (c.rows.value + " rows");
    const items = c.rows.options.map((n) =>
      '<div class="rp-menu-item' + (n === c.rows.value ? " selected" : "") + '" data-tb-rows="' + esc(n) + '">'
      + "<span>" + esc(n + " rows") + "</span>"
      + (n === c.rows.value ? '<span class="rp-menu-tick">✓</span>' : "")
      + "</div>"
    ).join("");
    return '<div class="rp-menu-wrap">'
      + '<button type="button" class="rp-chip rp-toolbar-pill" data-dd="rp-tb-rows">'
      +   '<span data-tb-rows-label>' + esc(label) + "</span>"
      +   '<i class="bi bi-chevron-down rp-toolbar-chev"></i>'
      + "</button>"
      + '<div class="rp-menu" id="rp-tb-rows">' + items + "</div>"
      + "</div>";
  }

  // Columns picker: each row is a checkbox label (data-tb-col=index). The button
  // click stopPropagation is handled by the consumer's change handler staying open;
  // bindMenu opens/closes the panel as a normal [data-dd] trigger.
  function colsHTML(c) {
    if (!c.cols) return "";
    const items = (c.cols.items || []).map((it) =>
      '<label class="rp-menu-item">'
      + '<input type="checkbox" data-tb-col="' + esc(it.index) + '"' + (it.checked ? " checked" : "") + " />"
      + "<span>" + esc(it.label) + "</span></label>"
    ).join("");
    return '<div class="rp-menu-wrap">'
      + '<button type="button" class="rp-btn-icon" data-dd="rp-tb-cols"'
      +   (c.cols.disabled ? " disabled" : "")
      +   ' title="' + esc(c.cols.title || "Columns") + '"><i class="bi ' + ICON_COLS + '"></i></button>'
      + '<div class="rp-menu" id="rp-tb-cols">' + items + "</div>"
      + "</div>";
  }

  // Selection chip: an rp-chip in the .rp-toolbar-selchip context (accent-soft,
  // hidden until .show). Clicking it clears the selection (onSelChip).
  function selChipHTML(c) {
    if (!c.selChip) return "";
    const s = c.selChip;
    return '<span class="rp-chip rp-toolbar-selchip' + (s.show ? " show" : "") + '" data-tb-action="sel-chip">'
      + '<i class="bi ' + ICON_SELCHIP + '"></i>'
      + '<span data-tb-sel-count>' + esc(s.count ?? 0) + "</span>"
      + " selected</span>";
  }

  function exportHTML(c) {
    if (!c.export) return "";
    const items = (c.export.items || []).map((it) =>
      '<div class="rp-menu-item" data-tb-fmt="' + esc(it.fmt) + '">'
      + (it.icon ? '<i class="bi ' + esc(it.icon) + '"></i>' : "")
      + "<span>" + esc(it.label) + "</span></div>"
    ).join("");
    return '<div class="rp-menu-wrap">'
      + '<button type="button" class="rp-btn-icon" data-dd="rp-tb-export"'
      +   (c.export.disabled ? " disabled" : "")
      +   ' title="' + esc(c.export.title || "Export") + '"><i class="bi ' + ICON_EXPORT + '"></i></button>'
      + '<div class="rp-menu" id="rp-tb-export">' + items + "</div>"
      + "</div>";
  }

  function historyHTML(c) {
    if (!c.history) return "";
    const items = (c.history.items || []).length
      ? c.history.items.map((it) =>
          '<div class="rp-menu-item">'
          + (it.icon ? '<i class="bi ' + esc(it.icon) + '"></i>' : "")
          + "<span>" + esc(it.label) + "</span>"
          + (it.meta ? '<span class="rp-menu-tick">' + esc(it.meta) + "</span>" : "")
          + "</div>"
        ).join("")
      : '<p class="rp-empty">No history</p>';
    return '<div class="rp-menu-wrap">'
      + '<button type="button" class="rp-btn-icon" data-dd="rp-tb-history"'
      +   ' title="' + esc(c.history.title || "History") + '"><i class="bi ' + ICON_HISTORY + '"></i></button>'
      + '<div class="rp-menu" id="rp-tb-history">' + items + "</div>"
      + "</div>";
  }

  function toolsHTML(c) {
    if (!c.tools) return "";
    return btn({
      cls: "rp-btn-icon" + (c.tools.active ? " is-active" : ""),
      action: "tools",
      icon: ICON_TOOLS,
      title: c.tools.title || "Tools",
    });
  }

  // ── the two variants share the bar layout; designer swaps the children ──────
  function dataChildren(c) {
    return filterHTML(c)
      + searchHTML(c)
      + (c.modes?.length ? sep() : "")
      + modesHTML(c)
      + (c.undoRedo || c.refresh || c.rownum ? sep() : "")
      + undoRedoHTML(c)
      + refreshHTML(c)
      + rownumHTML(c)
      + (c.rows || c.cols ? sep() : "")
      + rowsHTML(c)
      + colsHTML(c)
      + selChipHTML(c)
      + (c.export || c.history || c.tools ? sep() : "")
      + exportHTML(c)
      + historyHTML(c)
      + toolsHTML(c);
  }

  function designerChildren(c) {
    const d = c.designer || {};
    return '<span class="rp-toolbar-title"><i class="bi ' + esc(d.icon || "bi-bar-chart-line") + '"></i>'
      +   "<span>" + esc(d.title || "") + "</span></span>"
      + '<span class="rp-toolbar-spacer"></span>'
      + (d.addLabel
          ? '<button type="button" class="rp-btn-icon rp-btn-icon--glass" data-tb-action="add-chart">'
            + '<i class="bi bi-plus-lg"></i><span>' + esc(d.addLabel) + "</span></button>"
          : "")
      + sep()
      + '<button type="button" class="rp-btn-icon' + (d.cfgActive ? " is-active" : "") + '"'
      +   ' data-tb-action="cfg-toggle" title="Configure"><i class="bi bi-sliders"></i></button>';
  }

  function render(next) {
    cfg = next || cfg;
    const variant = cfg.variant === "designer" ? "designer" : "data";
    host.className = "rp-toolbar rp-toolbar--" + variant + (cfg.className ? " " + cfg.className : "");
    host.innerHTML = variant === "designer" ? designerChildren(cfg) : dataChildren(cfg);
    // Our 4 dropdowns are hand-authored [data-dd] markup (not mountMenu'd), so we
    // wire the single delegated open/close/mutex handler here. bindMenu is
    // idempotent (module-singleton), so calling it on every render is cheap.
    if (host.querySelector("[data-dd]")) bindMenu();
  }

  // ── one delegated click handler routes every action by data-* attribute ─────
  host.addEventListener("click", (e) => {
    // Menu ITEM clicks (rows / cols / export) — these live inside .rp-menu panels;
    // bindMenu closes the panel after; we read the chosen value here.
    const rowsItem = e.target.closest("[data-tb-rows]");
    if (rowsItem && host.contains(rowsItem)) {
      const n = parseInt(rowsItem.dataset.tbRows, 10);
      if (Number.isFinite(n)) cfg.onRows?.(n);
      return;
    }
    const fmtItem = e.target.closest("[data-tb-fmt]");
    if (fmtItem && host.contains(fmtItem)) { cfg.onExport?.(fmtItem.dataset.tbFmt); return; }

    const el = e.target.closest("[data-tb-action]");
    if (!el || !host.contains(el)) return;
    if (el.disabled) return;
    switch (el.dataset.tbAction) {
      case "filter":    cfg.onFilter?.(); return;
      case "mode":      cfg.onMode?.(el.dataset.mode); return;
      case "undo":      cfg.onUndo?.(); return;
      case "redo":      cfg.onRedo?.(); return;
      case "refresh":   spin(el.querySelector(".rp-toolbar-spin")); cfg.onRefresh?.(); return;
      case "rownum":    cfg.onRownum?.(); return;
      case "sel-chip":  cfg.onSelChip?.(); return;
      case "tools":     cfg.onTools?.(); return;
      case "add-chart": cfg.onAddChart?.(); return;
      case "cfg-toggle": cfg.onCfgToggle?.(); return;
    }
  });

  // Search input (debounce is the consumer's concern — the page owns the JS↔Rust
  // refetch cadence; the builder just forwards the trimmed value on input).
  host.addEventListener("input", (e) => {
    const input = e.target.closest("[data-tb-search]");
    if (!input || !host.contains(input)) return;
    cfg.search?.onInput?.(input.value.trim());
  });

  // Columns checkbox: the cols-picker change toggles a column's display; the
  // consumer applies it to its table. stopPropagation keeps the menu open while
  // ticking multiple columns (matches the legacy rebuildColsDropdown behavior).
  host.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-tb-col]");
    if (!cb || !host.contains(cb)) return;
    e.stopPropagation();
    cfg.onCol?.(parseInt(cb.dataset.tbCol, 10), cb.checked);
  });

  render(config);

  return {
    el: host,
    render,
    /** Update just the selection-chip count + visibility without a full re-render. */
    setSelection(count) {
      const chip = host.querySelector(".rp-toolbar-selchip");
      if (!chip) return;
      const span = chip.querySelector("[data-tb-sel-count]");
      if (span) span.textContent = String(count);
      chip.classList.toggle("show", count > 0);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

// A plain icon button (rp-btn-icon). action → data-tb-action route key.
function btn({ cls, action, icon, title, disabled }) {
  return '<button type="button" class="' + cls + '" data-tb-action="' + esc(action) + '"'
    + (disabled ? " disabled" : "")
    + ' title="' + esc(title) + '"><i class="bi ' + esc(icon) + '"></i></button>';
}

// Re-trigger the one-shot spin on the refresh icon: remove → reflow → add, so a
// repeated refresh restarts the animation (matches the legacy rt-spinning trick).
function spin(icon) {
  if (!icon) return;
  icon.classList.remove("is-spinning");
  void icon.offsetWidth; // force reflow so the animation re-fires
  icon.classList.add("is-spinning");
}

register("toolbar", mountToolbar);
