// charts/builder-ui.js — chart-spec authoring accordion.
//
// Slice C of the chart-pipeline unification (Em 2026-05-27). Lifts
// the right-side accordion (Chart type / Data / Axes / Legend /
// Tooltip / Style) out of designer.js so the Settings-driven
// Monitoring chart picker (Slice D) can mount the same UI against
// a different data source — e.g. a `monitoring-stats` endpoint
// instead of a workspace File.
//
// What this module does NOT own
// ------------------------------
// The accordion mutates a `cfg` object in place (the chart spec being
// edited). It does not own that object, persist it, or fetch the
// data — those are the caller's responsibilities exposed as the
// `ctx` hooks below. The accordion is a UI for editing whatever cfg
// the caller hands it; the caller decides what "save" means.
//
// Polymorphic source
// ------------------
// The Data section adapts to `ctx.getSource()`:
//
//   { kind: "file", label, columns }
//     → shows the File's rid + the cfg.group_by / cfg.agg_fn(agg_col)
//       chips (designer's default — picks land via the future column
//       picker UI; today they're set elsewhere in the workspace).
//
//   { kind: "monitoring-stats", endpoint, pointer, window, schema }
//     → shows the endpoint + the pointer field path (which JSON key
//       inside the stats response feeds the chart) + the window chip
//       (1h / 24h / 7d / 30d). `schema` is an optional list of the
//       fields the endpoint exposes — drives a pointer picker when
//       present, falls back to a free-text input when not.
//
// New source kinds are added by extending `renderDataSection`; the
// rest of the accordion is source-agnostic.
//
// Contract
// --------
//   mountBuilder(el, {
//     getCfg:      () => Object,           // current cfg being edited
//     getSource:   () => SourceDesc,       // polymorphic per above
//     onCfgChange: () => void,             // called after each edit
//     onSave:      () => Promise|void,     // save button handler
//   })
//   → {
//     render:    () => void,               // re-render the accordion
//                                          // (call after selection change
//                                          //  or external cfg replace)
//     setDirty:  (on: boolean) => void,    // enable/disable the save btn
//     destroy:   () => void,               // remove listeners + clear el
//   }

import { esc } from "/scripts/dom.js";
import { THEMES, TYPE_LIST, TYPE_TO_KIND, SMOOTHABLE } from "/scripts/charts/build.js";

const WINDOW_CHIPS = ["1h", "24h", "7d", "30d"];

export function mountBuilder(el, ctx) {
  // Shell. Save button lives in the header so the caller's setDirty
  // can flip it without re-rendering the body. Body is the accordion
  // sections, re-rendered on every render() call.
  el.innerHTML = ''
    + '<div class="ds-config-head">'
    +   '<span class="ds-config-title"><i class="bi bi-sliders"></i> Chart</span>'
    +   '<button class="ds-config-save rt-btn rt-btn--accent" type="button" disabled>'
    +     '<i class="bi bi-save"></i> Save'
    +   '</button>'
    + '</div>'
    + '<div class="ds-config-body" id="ds-acc-body"></div>';
  const saveBtn = el.querySelector(".ds-config-save");
  const accBody = el.querySelector("#ds-acc-body");

  // ── per-section renderers ────────────────────────────────────────
  function renderTypeSection(cfg) {
    const typeBtns = TYPE_LIST.map(([t, icon, label]) =>
      '<button type="button" class="ds-type-btn' + (t === cfg.type ? " active" : "") + '"'
      + ' data-type="' + esc(t) + '"><i class="bi ' + esc(icon) + '"></i>' + esc(label)
      + '</button>').join('');
    return '<div class="ds-type-grid">' + typeBtns + '</div>'
      + '<span class="ds-lbl">Title</span>'
      + '<input class="ds-input" data-key="title" value="' + esc(cfg.title || "") + '" />';
  }

  // Polymorphic per source.kind. Anything not matched falls back to a
  // muted "no source bound" line so the section still renders without
  // throwing — better than a blank panel.
  function renderDataSection(cfg, source) {
    if (!source) {
      return '<p class="ds-muted">No data source bound.</p>';
    }
    if (source.kind === "file") {
      const label = source.label || source.rid || "(no source bound)";
      return ''
        + '<span class="ds-lbl">Source view</span>'
        + '<div class="ds-source"><i class="bi bi-filetype-csv"></i> ' + esc(label) + '</div>'
        + '<span class="ds-lbl">Group by</span>'
        + '<div class="ds-chip-row">'
        +   (cfg.group_by
              ? '<span class="ds-chip">' + esc(cfg.group_by) + '</span>'
              : '<span class="ds-muted">— not set</span>')
        + '</div>'
        + '<span class="ds-lbl">Measure</span>'
        + '<div class="ds-chip-row">'
        +   '<span class="ds-chip">' + esc(cfg.agg_fn || "?") + '('
        +     esc(cfg.agg_col === "*" ? "*" : (cfg.agg_col || "?")) + ')</span>'
        + '</div>';
    }
    if (source.kind === "monitoring-stats") {
      const endpoint = source.endpoint || cfg.source?.endpoint || "";
      const pointer  = source.pointer  || cfg.source?.pointer  || "";
      const window_  = source.window   || cfg.source?.window   || "24h";
      // Schema-driven pointer picker when the source provides field
      // names; free-text input otherwise. The schema list is the
      // canonical set of fields the endpoint exposes (e.g. for
      // /monitoring/requests/stats: status_mix, top_routes, buckets.p95_ms,
      // buckets.count).
      const pointerCtl = Array.isArray(source.schema) && source.schema.length
        ? '<select class="ds-input" data-key="source.pointer">'
          + source.schema.map((p) =>
              '<option value="' + esc(p) + '"' + (p === pointer ? " selected" : "") + '>'
              + esc(p) + '</option>').join('')
          + '</select>'
        : '<input class="ds-input" data-key="source.pointer" value="' + esc(pointer) + '" placeholder="e.g. status_mix" />';
      const windowChips = WINDOW_CHIPS.map((w) =>
        '<button type="button" class="rp-chip' + (w === window_ ? " is-active" : "") + '"'
        + ' data-source-window="' + esc(w) + '">' + esc(w) + '</button>').join('');
      return ''
        + '<span class="ds-lbl">Endpoint</span>'
        + '<div class="ds-source"><i class="bi bi-cloud-download"></i> ' + esc(endpoint) + '</div>'
        + '<span class="ds-lbl">Field</span>'
        + pointerCtl
        + '<span class="ds-lbl">Window</span>'
        + '<div class="rp-chip-row">' + windowChips + '</div>';
    }
    return '<p class="ds-muted">Unknown source kind: ' + esc(source.kind) + '</p>';
  }

  function renderAxesSection(cfg) {
    if (["pie", "gauge", "radar"].includes(cfg.kind)) {
      return '<p class="ds-muted">Axes don\'t apply to this chart kind.</p>';
    }
    return toggleRow("splitLines", cfg.splitLines, "Show split lines")
      + toggleRow("axisLine", cfg.axisLine, "Show axis line");
  }

  function renderLegendSection(cfg) {
    return toggleRow("legend", cfg.legend, "Show legend")
      + '<span class="ds-lbl">Position</span>'
      + '<select class="ds-input" data-key="legendPos">'
      +   '<option value="bottom"' + (cfg.legendPos === "bottom" ? " selected" : "") + '>Bottom</option>'
      +   '<option value="top"'    + (cfg.legendPos === "top"    ? " selected" : "") + '>Top</option>'
      + '</select>';
  }

  function renderTooltipSection(cfg) {
    return toggleRow("tooltip", cfg.tooltip, "Show tooltip on hover");
  }

  function renderStyleSection(cfg) {
    const themeRows = Object.entries(THEMES).map(([key, t]) =>
      '<button type="button" class="ds-theme-opt' + (key === cfg.theme ? " active" : "") + '"'
      + ' data-theme="' + esc(key) + '">'
      + '<span class="ds-sw">' + t.series.slice(0, 5).map((c) =>
          '<i style="background:' + c + '"></i>').join('') + '</span>'
      + '<span>' + esc(t.name) + '</span>'
      + (key === cfg.theme ? '<i class="bi bi-check2 ds-check"></i>' : '')
      + '</button>').join('');
    return (SMOOTHABLE.has(cfg.type)
        ? toggleRow("smooth", cfg.smooth, "Smooth lines")
        : "")
      + '<span class="ds-lbl">Chart theme</span>'
      + '<div class="ds-theme-opts">' + themeRows + '</div>';
  }

  // ── shared HTML helpers ──────────────────────────────────────────
  function section(name, icon, label, open, body) {
    return '<div class="ds-sec' + (open ? " open" : "") + '" data-sec="' + esc(name) + '">'
      + '<button class="ds-sec-head" type="button">'
      +   '<i class="bi bi-chevron-down ds-sec-caret"></i>'
      +   '<i class="bi ' + esc(icon) + ' ds-sec-icon"></i>'
      +   '<span class="ds-sec-label">' + esc(label) + '</span>'
      + '</button>'
      + '<div class="ds-sec-body">' + body + '</div>'
      + '</div>';
  }
  function toggleRow(key, on, label) {
    return '<label class="ds-toggle-row">'
      + '<input type="checkbox" data-key="' + esc(key) + '"' + (on ? " checked" : "") + ' /> '
      + esc(label) + '</label>';
  }

  // ── render ──────────────────────────────────────────────────────
  function render() {
    const cfg = ctx.getCfg?.();
    if (!cfg) { accBody.innerHTML = ""; return; }
    const source = ctx.getSource?.();
    accBody.innerHTML = ''
      + section("type",    "bi-bar-chart",        "Chart type", true,  renderTypeSection(cfg))
      + section("data",    "bi-database",         "Data",       false, renderDataSection(cfg, source))
      + section("axes",    "bi-rulers",           "Axes",       false, renderAxesSection(cfg))
      + section("legend",  "bi-list-ul",          "Legend",     false, renderLegendSection(cfg))
      + section("tooltip", "bi-chat-square-text", "Tooltip",    false, renderTooltipSection(cfg))
      + section("style",   "bi-palette",          "Style",      false, renderStyleSection(cfg));
  }

  function setDirty(on) {
    if (saveBtn) saveBtn.disabled = !on;
  }

  // ── events ──────────────────────────────────────────────────────
  function onClick(e) {
    const cfg = ctx.getCfg?.();
    if (!cfg) return;
    const head = e.target.closest(".ds-sec-head");
    if (head) { head.parentElement.classList.toggle("open"); return; }
    const tBtn = e.target.closest(".ds-type-btn");
    if (tBtn) {
      cfg.type = tBtn.dataset.type;
      cfg.kind = TYPE_TO_KIND[cfg.type] || cfg.kind;
      render();
      ctx.onCfgChange?.();
      return;
    }
    const themeBtn = e.target.closest(".ds-theme-opt");
    if (themeBtn) {
      cfg.theme = themeBtn.dataset.theme;
      render();
      ctx.onCfgChange?.();
      return;
    }
    const winChip = e.target.closest("[data-source-window]");
    if (winChip) {
      cfg.source = { ...(cfg.source || {}), window: winChip.dataset.sourceWindow };
      render();
      ctx.onCfgChange?.();
      return;
    }
  }

  function onInput(e) {
    const cfg = ctx.getCfg?.();
    if (!cfg) return;
    const fld = e.target.closest("[data-key]");
    if (!fld) return;
    const key = fld.dataset.key;
    if (key === "title") {
      cfg.title = e.target.value;
      ctx.onCfgChange?.();
    } else if (key === "source.pointer") {
      cfg.source = { ...(cfg.source || {}), pointer: e.target.value };
      ctx.onCfgChange?.();
    }
  }

  function onChange(e) {
    const cfg = ctx.getCfg?.();
    if (!cfg) return;
    const fld = e.target.closest("[data-key]");
    if (!fld) return;
    const key = fld.dataset.key;
    if (["legend", "tooltip", "splitLines", "axisLine", "smooth"].includes(key)) {
      cfg[key] = e.target.checked;
    } else if (key === "legendPos") {
      cfg.legendPos = e.target.value;
    } else if (key === "source.pointer") {
      // <select> emits change instead of input — same path as input.
      cfg.source = { ...(cfg.source || {}), pointer: e.target.value };
    }
    ctx.onCfgChange?.();
  }

  function onSaveClick() {
    void ctx.onSave?.();
  }

  accBody.addEventListener("click", onClick);
  accBody.addEventListener("input", onInput);
  accBody.addEventListener("change", onChange);
  saveBtn.addEventListener("click", onSaveClick);

  function destroy() {
    accBody.removeEventListener("click", onClick);
    accBody.removeEventListener("input", onInput);
    accBody.removeEventListener("change", onChange);
    saveBtn.removeEventListener("click", onSaveClick);
    el.innerHTML = "";
  }

  return { render, setDirty, destroy };
}
