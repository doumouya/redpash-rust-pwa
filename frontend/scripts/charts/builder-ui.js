/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/charts/builder-ui.md */
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
//   { kind: "file", rid, label, columns, files }
//     → three live dropdowns: the source file (picked from `files`,
//       shown by name), the group-by column (from `columns`), and the
//       measure (an agg fn + the column it runs on). Editing the source
//       calls ctx.onSourceChange(rid); editing group-by / fn / col calls
//       ctx.onDataChange() so the caller can re-aggregate the chart.
//       `columns` / `files` may arrive async — until they do, each
//       control degrades to a static line showing the current value.
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
//     getCfg:        () => Object,         // current cfg being edited
//     getSource:     () => SourceDesc,     // polymorphic per above
//     onCfgChange:   () => void,           // after a style/type/theme edit
//     onDataChange:  () => Promise|void,   // after a group-by / fn / col
//                                          //   edit (file source) — caller
//                                          //   re-aggregates. Falls back to
//                                          //   onCfgChange when omitted.
//     onSourceChange:(rid) => Promise|void,// source-file dropdown changed
//                                          //   (file source) — caller swaps
//                                          //   the data file + re-fetches.
//     onSave:        () => Promise|void,   // save button handler
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

// Aggregation functions offered by the file-source Measure dropdown.
// Values are the snake_case `shared::report::AggFn` variants the
// /api/group/preview engine accepts; labels are the human wording.
// `count` is the only fn that operates on "all rows" (agg_col "*");
// every other fn needs a real column (the renderer + onChange enforce
// that — switching to a column fn auto-picks the first column).
const AGG_FNS = [
  ["count",          "Count"],
  ["count_distinct", "Count distinct"],
  ["sum",            "Sum"],
  ["mean",           "Mean"],
  ["min",            "Min"],
  ["max",            "Max"],
  ["median",         "Median"],
];

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
    // Title is edited inline in the tile header (the pencil → editable
    // header title), so the panel no longer carries an always-on Title
    // input. cfg.title stays the source of truth; the header edit writes
    // it directly. (The title input-handler branch below is now dead but
    // harmless — left in case a title field is reintroduced.)
    return '<div class="ds-type-grid">' + typeBtns + '</div>';
  }

  // Polymorphic per source.kind. Anything not matched falls back to a
  // muted "no source bound" line so the section still renders without
  // throwing — better than a blank panel.
  function renderDataSection(cfg, source) {
    if (!source) {
      return '<p class="ds-muted">No data source bound.</p>';
    }
    if (source.kind === "file") {
      // Three live controls (Em 2026-05-28): the source file (pick any
      // data file in the project, shown by name), the group-by column,
      // and the measure (agg fn + the column it runs on). Editing any of
      // them re-aggregates the tile via /api/group/preview — they are
      // functional, not display chips. Columns/files arrive async from
      // the designer; until they do, each control degrades to a static
      // line showing the current value so the panel never renders blank.
      const cols   = Array.isArray(source.columns) ? source.columns : [];
      const files  = Array.isArray(source.files)   ? source.files   : [];
      const curRid = source.rid || "";
      const aggFn  = cfg.agg_fn || "count";
      const aggCol = cfg.agg_col || "*";
      const isCount = aggFn === "count";

      const sourceCtl = files.length
        ? '<select class="ds-input" data-key="source_file_id">'
          + files.map((f) =>
              '<option value="' + esc(f.rid) + '"' + (f.rid === curRid ? " selected" : "") + '>'
              + esc(f.name) + '</option>').join('')
          + '</select>'
        : '<div class="ds-source"><i class="bi bi-filetype-csv"></i> '
          + esc(source.label || curRid || "(no source bound)") + '</div>';

      const groupCtl = cols.length
        ? '<select class="ds-input" data-key="group_by">'
          + cols.map((c) =>
              '<option value="' + esc(c.name) + '"' + (c.name === cfg.group_by ? " selected" : "") + '>'
              + esc(c.name) + '</option>').join('')
          + '</select>'
        : '<div class="ds-source"><i class="bi bi-hash"></i> '
          + (cfg.group_by ? esc(cfg.group_by) : '<span class="ds-muted">loading columns…</span>')
          + '</div>';

      const fnCtl = '<select class="ds-input ds-agg-fn" data-key="agg_fn">'
        + AGG_FNS.map(([v, l]) =>
            '<option value="' + esc(v) + '"' + (v === aggFn ? " selected" : "") + '>'
            + esc(l) + '</option>').join('')
        + '</select>';
      // Column the measure runs on. `count` can run over all rows ("*");
      // every other fn needs a real column, so the "All rows" option is
      // offered only for count.
      const colCtl = '<select class="ds-input ds-agg-col" data-key="agg_col"'
          + (cols.length ? "" : " disabled") + '>'
        + (isCount
            ? '<option value="*"' + (aggCol === "*" ? " selected" : "") + '>All rows</option>'
            : '')
        + cols.map((c) =>
            '<option value="' + esc(c.name) + '"' + (c.name === aggCol ? " selected" : "") + '>'
            + esc(c.name) + '</option>').join('')
        + '</select>';

      return ''
        + '<span class="ds-lbl">Source view</span>' + sourceCtl
        + '<span class="ds-lbl">Group by</span>' + groupCtl
        + '<span class="ds-lbl">Measure</span>'
        + '<div class="ds-measure-row">' + fnCtl + colCtl + '</div>';
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
  // Preserve which sections are open across re-renders so an edit that
  // re-renders (type / theme / agg-fn switch) doesn't collapse the
  // section the user is working in. First render uses the defaults.
  let rendered = false;
  function render() {
    const cfg = ctx.getCfg?.();
    if (!cfg) { accBody.innerHTML = ""; rendered = false; return; }
    const openSecs = rendered
      ? new Set([...accBody.querySelectorAll(".ds-sec.open")].map((s) => s.dataset.sec))
      : null;
    const isOpen = (name, dflt) => openSecs ? openSecs.has(name) : dflt;
    const source = ctx.getSource?.();
    accBody.innerHTML = ''
      + section("type",    "bi-bar-chart",        "Chart type", isOpen("type", true),     renderTypeSection(cfg))
      + section("data",    "bi-database",         "Data",       isOpen("data", false),    renderDataSection(cfg, source))
      + section("axes",    "bi-rulers",           "Axes",       isOpen("axes", false),    renderAxesSection(cfg))
      + section("legend",  "bi-list-ul",          "Legend",     isOpen("legend", false),  renderLegendSection(cfg))
      + section("tooltip", "bi-chat-square-text", "Tooltip",    isOpen("tooltip", false), renderTooltipSection(cfg))
      + section("style",   "bi-palette",          "Style",      isOpen("style", false),   renderStyleSection(cfg));
    rendered = true;
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

    // ── file-source data keys ──────────────────────────────────────
    // These change WHAT data the chart plots (not just its style), so
    // they route through onDataChange (live re-aggregation) rather than
    // onCfgChange (style-only rerender). Each returns early.
    if (key === "source_file_id") {
      // Switching the source file is a heavier op (new columns, maybe a
      // reset group-by) — the designer owns it.
      ctx.onSourceChange?.(e.target.value);
      return;
    }
    if (key === "group_by") {
      cfg.group_by = e.target.value;
      (ctx.onDataChange || ctx.onCfgChange)?.();
      return;
    }
    if (key === "agg_fn") {
      cfg.agg_fn = e.target.value;
      // count is the only fn that runs over all rows; every other fn
      // needs a real column. Auto-pick the first when leaving count so
      // the re-aggregation doesn't 400 on agg_col "*".
      if (cfg.agg_fn !== "count" && (!cfg.agg_col || cfg.agg_col === "*")) {
        const cols = ctx.getSource?.()?.columns || [];
        cfg.agg_col = cols[0]?.name || cfg.agg_col || "*";
      }
      // Re-render so the column dropdown shows/hides "All rows" and
      // reflects the (possibly auto-picked) agg_col.
      render();
      (ctx.onDataChange || ctx.onCfgChange)?.();
      return;
    }
    if (key === "agg_col") {
      cfg.agg_col = e.target.value;
      (ctx.onDataChange || ctx.onCfgChange)?.();
      return;
    }

    // ── style keys ──────────────────────────────────────────────────
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
