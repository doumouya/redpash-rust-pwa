// Designer — the chart/dashboard authoring surface.
//
// Ported from the prototype at red-front/designer.html (commit
// 6729f80 in that repo). Same shape:
//   - canvas (12-col grid of tiles)
//   - right-side accordion (Chart type / Data / Axes / Legend /
//     Tooltip / Style)
//   - three chart themes (Vintage / Latte / Mocha) authored
//     separately from the app's chrome theme
// Rewired for redpash-app: tiles render REAL CHT_ files via
// /api/charts; spec edits write back through PUT /api/charts/:rid.
//
// Slice scope (today): one tile = the open CHT_ file (single-chart
// canvas). Dashboard files (multi-tile, project_files.file_type=
// 'dashboard') need a new file_type + spec shape; that's Phase 2.
//
// ctx: { designerEl, getSource() → { rid, columns }, onSaved(chart) }
//   - designerEl: container DOM element (.rt-designer) where the
//                 canvas + accordion render
//   - getSource:  () => { rid, columns } for the chart's source
//                 data file (so the Data section + future live
//                 preview have something to render against)
//   - onSaved:    callback after a successful PUT /charts/:rid

import { api } from "/scripts/api.js";
import { ensureRegisteredThemes } from "/scripts/echarts-theme.js";
import { esc } from "/scripts/dom.js";
// THEMES + TYPE_TO_KIND + buildOption lifted into
// /scripts/charts/build.js (Slice A — Em 2026-05-27). Designer
// still needs THEMES (theme lookup) + TYPE_TO_KIND (mountChartTile
// kind inference) + buildOption (tile setOption). TYPE_LIST +
// SMOOTHABLE moved with the accordion to /scripts/charts/builder-ui.js
// (Slice C) — no longer referenced here.
import { THEMES, TYPE_TO_KIND, buildOption } from "/scripts/charts/build.js";
// Slice C of the chart-pipeline unification (Em 2026-05-27): the
// right-side accordion (Chart type / Data / Axes / Legend / Tooltip /
// Style) is now `mountBuilder` over in /scripts/charts/builder-ui.js.
// Designer mounts it against a "file" source descriptor; the future
// Monitoring chart picker (Slice D) mounts the same UI against a
// "monitoring-stats" source descriptor.
import { mountBuilder } from "/scripts/charts/builder-ui.js";

// Defaults applied to a new chart cfg. Mirrors the prototype's D
// plus the modifiers added in C3.1 (smooth for line/area).
const DEFAULTS = {
  legend: false, legendPos: "bottom",
  tooltip: true, splitLines: true, axisLine: true,
  theme: "vintage",
  smooth: false,
};

export function mountDesigner(designerEl, ctx) {
  // Kick off theme registration once per page so the first chart
  // init that uses redpash-mocha / redpash-latte already has them
  // loaded. Fire-and-forget — failed loads fall through to the
  // inline themes silently.
  ensureRegisteredThemes();

  // state — tiles[] holds one entry per chart in the canvas. For
  // C2 / single-chart there's at most one entry (the open CHT_
  // file). The shape generalises to multi-tile when dashboards land.
  let tiles = [];        // [{ rid, chart, cfg, inst, tileEl, themeName }]
  let sel   = null;      // currently-selected tile entry
  let dirty = false;     // any unsaved spec changes
  let busy  = false;     // PUT in flight

  // Build the static shell once. Tiles render into the grid; the
  // aside is the slot mountBuilder fills with its head + accordion
  // body (it owns its own innerHTML — designer just hands it the
  // container so the existing .ds-config CSS hooks stay in place).
  designerEl.innerHTML = ''
    + '<div class="ds-canvas">'
    +   '<div class="ds-grid" id="dsGrid"></div>'
    + '</div>'
    + '<aside class="ds-config" id="dsConfig"></aside>';
  const gridEl  = designerEl.querySelector("#dsGrid");
  const asideEl = designerEl.querySelector("#dsConfig");

  // Mount the chart-spec builder against this designer's "file"
  // source. getCfg / getSource read live designer state; onCfgChange
  // pipes accordion edits back through rerender + setDirty.
  const builder = mountBuilder(asideEl, {
    getCfg:      () => sel?.cfg || null,
    getSource:   () => sel ? {
      kind:    "file",
      rid:     ctx.getSource?.()?.rid || null,
      label:   ctx.getSource?.()?.rid || null,
      columns: ctx.getSource?.()?.columns || [],
    } : null,
    onCfgChange: () => { if (sel) { rerender(sel); setDirty(true); } },
    onSave:      () => save(),
  });

  // ── load ──────────────────────────────────────────────────────────
  // Called from workspace.js when a chart or dashboard file opens.
  //   payload = { type: "chart", chart }
  //     → single-tile canvas, the open CHT_ takes the full row.
  //   payload = { type: "dashboard", dashboard }
  //     → multi-tile canvas, one tile per chart-kind widget.
  //       Widgets are { slot, kind, spec: { chart_id, ... } }; we
  //       fetch each chart in parallel via /api/charts/:id, then
  //       render. Other widget kinds (kpi/table/text/report) defer.
  //   payload = null → teardown to empty state.
  let dashboard = null;
  async function load(payload) {
    teardown();
    if (!payload) { renderCanvasEmpty(); return; }
    if (payload.type === "chart") {
      mountChartTile(payload.chart, /* span */ "span-12", /* selected */ true);
      return;
    }
    if (payload.type === "dashboard") {
      dashboard = payload.dashboard;
      const widgets = (dashboard?.spec?.widgets || []).filter((w) => w.kind === "chart");
      if (!widgets.length) {
        renderCanvasEmpty();
        if (gridEl) gridEl.innerHTML = '<p class="ds-empty">Empty dashboard. Use <i>Add chart</i> to add a widget.</p>';
        return;
      }
      // Fetch every chart in parallel — multi-tile dashboards open
      // faster when the fetches go simultaneous rather than serial.
      // Failed fetches render an error placeholder tile; one bad
      // chart doesn't blank the whole canvas.
      gridEl.innerHTML = '<p class="ds-empty">Loading widgets…</p>';
      const fetches = widgets.map((w) =>
        api.get("/charts/" + encodeURIComponent(w.spec?.chart_id || "")).catch((err) => ({ __err: err, widget: w })));
      const results = await Promise.all(fetches);
      gridEl.innerHTML = "";
      results.forEach((res, i) => {
        const w = widgets[i];
        if (res?.__err) {
          gridEl.appendChild(makeErrorTile(w, res.__err));
          return;
        }
        // Default span — alternate 6/6 for now. Slot/template-aware
        // sizing comes when the template registry lands.
        const span = "span-6";
        mountChartTile(res, span, /* selected */ false, w);
      });
      // Select the first successfully-loaded tile so the accordion
      // has content.
      if (tiles.length) selectTile(tiles[0]);
      return;
    }
  }

  // Mount a chart-kind tile into the canvas + push to the tiles[]
  // registry. Returns the entry. Used by both single-chart and
  // dashboard load paths.
  function mountChartTile(chart, spanClass, selected, widget) {
    if (!chart) return null;
    const cfg = mergeCfg(chart);
    const tileEl = makeTile(chart, cfg, !!selected, spanClass || "span-12");
    gridEl.appendChild(tileEl);
    const t = THEMES[cfg.theme] || THEMES.vintage;
    const themeName = t.registered ? cfg.theme : undefined;
    const inst = window.echarts?.init(tileEl.querySelector(".ds-chart"), themeName);
    if (inst) inst.setOption(buildOption(cfg, t));
    const entry = { rid: chart.redpash_id, chart, cfg, inst, tileEl,
                    widget: widget || null, themeName };
    tiles.push(entry);
    return entry;
  }

  function makeErrorTile(widget, err) {
    const el = document.createElement("div");
    el.className = "ds-tile ds-tile--error span-6";
    el.innerHTML = ''
      + '<div class="ds-tile-head"><span class="ds-tile-title">Chart unavailable</span></div>'
      + '<div class="ds-tile-body"><div class="ds-tile-err">'
      +   '<i class="bi bi-exclamation-triangle"></i> '
      +   esc(err?.body?.message || err?.message || "couldn\'t fetch widget")
      + '</div></div>';
    return el;
  }

  function teardown() {
    tiles.forEach((t) => t.inst?.dispose?.());
    tiles = [];
    sel = null;
    dashboard = null;
    dirty = false;
    busy = false;
    if (gridEl) gridEl.innerHTML = "";
    builder.render();
    builder.setDirty(false);
  }

  function renderCanvasEmpty() {
    if (gridEl) gridEl.innerHTML = '<p class="ds-empty">No chart loaded.</p>';
    builder.render();
    builder.setDirty(false);
  }

  // Merge the saved chart.spec with display defaults so the
  // accordion always has values to render against. Storage shape:
  //   chart.spec = { kind, type, title, legend, legendPos, tooltip,
  //                  splitLines, axisLine, theme, option }
  // Older charts (saved by the inline strip from C1) carry only
  // { kind, group_by, agg_col, agg_fn, title, option }. We project
  // those into the richer shape so they still render.
  function mergeCfg(chart) {
    const s = chart?.spec || {};
    const type = s.type || s.kind || "bar";
    const kind = TYPE_TO_KIND[type] || "cartesian";
    return {
      kind,
      type,
      title: s.title || chart?.title || "Untitled chart",
      legend:     s.legend     ?? DEFAULTS.legend,
      legendPos:  s.legendPos  || DEFAULTS.legendPos,
      tooltip:    s.tooltip    ?? DEFAULTS.tooltip,
      splitLines: s.splitLines ?? DEFAULTS.splitLines,
      axisLine:   s.axisLine   ?? DEFAULTS.axisLine,
      smooth:     s.smooth     ?? DEFAULTS.smooth,
      theme:      s.theme      || DEFAULTS.theme,
      // Keep around so the prior baked option can render until the
      // user re-saves (live re-build replaces it on any edit).
      option:     s.option     || null,
      // Carry the data-shape fields too — the Data section reads
      // them; future preview-from-source uses them to /group/preview.
      group_by: s.group_by || "",
      agg_col:  s.agg_col  || "*",
      agg_fn:   s.agg_fn   || "count",
    };
  }

  // ── canvas / tiles ────────────────────────────────────────────────
  function makeTile(chart, cfg, selected, spanClass) {
    const el = document.createElement("div");
    el.className = "ds-tile" + (selected ? " selected" : "") + " " + (spanClass || "span-12");
    el.dataset.rid = chart.redpash_id;
    el.innerHTML = ''
      + '<div class="ds-tile-head">'
      +   '<span class="ds-tile-title">' + esc(cfg.title) + '</span>'
      +   '<span class="ds-tile-menu"><i class="bi bi-three-dots"></i></span>'
      + '</div>'
      + '<div class="ds-tile-body"><div class="ds-chart"></div></div>';
    return el;
  }

  // ── selection ─────────────────────────────────────────────────────
  function selectTile(entry) {
    sel = entry;
    tiles.forEach((t) => t.tileEl.classList.toggle("selected", t === entry));
    builder.render();
  }

  // ── rerender / dirty / save ───────────────────────────────────────
  // Theme swap requires dispose+reinit when EITHER the old or new
  // theme is registered (ECharts can't swap themes after init).
  // Same-theme rerenders just setOption.
  function rerender(entry) {
    if (!entry?.tileEl) return;
    const t = THEMES[entry.cfg.theme] || THEMES.vintage;
    const nextThemeName = t.registered ? entry.cfg.theme : undefined;
    if (entry.themeName !== nextThemeName) {
      entry.inst?.dispose?.();
      const el = entry.tileEl.querySelector(".ds-chart");
      if (el) el.innerHTML = "";
      entry.inst = window.echarts?.init(el, nextThemeName);
      entry.themeName = nextThemeName;
    }
    entry.inst?.setOption?.(buildOption(entry.cfg, t), true);
  }
  function setDirty(on) {
    dirty = on;
    builder.setDirty(on && !busy);
  }

  async function save() {
    if (!sel || busy) return;
    busy = true; builder.setDirty(false);
    try {
      const baked = sel.inst?.getOption?.() || null;
      const body = {
        source_file_id: sel.chart.source_file_id,
        title:          sel.cfg.title,
        spec: {
          kind:       sel.cfg.kind,
          type:       sel.cfg.type,
          title:      sel.cfg.title,
          legend:     sel.cfg.legend,
          legendPos:  sel.cfg.legendPos,
          tooltip:    sel.cfg.tooltip,
          splitLines: sel.cfg.splitLines,
          axisLine:   sel.cfg.axisLine,
          smooth:     sel.cfg.smooth,
          theme:      sel.cfg.theme,
          group_by:   sel.cfg.group_by,
          agg_col:    sel.cfg.agg_col,
          agg_fn:     sel.cfg.agg_fn,
          option:     baked,
        },
      };
      const saved = await api.put("/charts/" + encodeURIComponent(sel.rid), body);
      sel.chart = saved;
      ctx.onSaved?.(saved);
      setDirty(false);
    } catch (err) {
      console.warn("[designer] save failed:", err);
    } finally {
      busy = false;
      builder.setDirty(dirty);
    }
  }

  // ── handlers ──────────────────────────────────────────────────────
  // Canvas: click a tile to select.
  gridEl.addEventListener("click", (e) => {
    const t = e.target.closest(".ds-tile");
    if (!t) return;
    const entry = tiles.find((x) => x.tileEl === t);
    if (entry) selectTile(entry);
  });

  // Accordion event handlers + the save button wiring now live
  // inside mountBuilder. The `onCfgChange` hook in the mountBuilder
  // call pipes every accordion edit through rerender(sel) +
  // setDirty(true); `onSave` calls save(). The one side effect that
  // stays here is the tile-header text — it sits outside the chart
  // canvas so ECharts setOption doesn't reach it.
  asideEl.addEventListener("input", (e) => {
    if (!sel) return;
    const fld = e.target.closest('[data-key="title"]');
    if (!fld) return;
    const t = sel.tileEl.querySelector(".ds-tile-title");
    if (t) t.textContent = e.target.value || "Untitled chart";
  });

  // ── dashboard mutations ───────────────────────────────────────────
  // Append a chart widget to the open dashboard's spec + persist via
  // PUT /api/dashboards/:rid + mount the new tile. No-op when not in
  // dashboard mode (the workspace falls back to creating a standalone
  // chart in that case).
  async function addChartWidget(chart) {
    if (!dashboard || !chart) return false;
    const widgets = [...(dashboard.spec?.widgets || []), {
      slot: "w" + ((dashboard.spec?.widgets?.length || 0) + 1),
      kind: "chart",
      spec: { chart_id: chart.redpash_id },
    }];
    const nextSpec = { ...(dashboard.spec || { template_id: "" }), widgets };
    try {
      const saved = await api.put("/dashboards/" + encodeURIComponent(dashboard.redpash_id), {
        project_redpash_id: dashboard.project_redpash_id,
        title:              dashboard.title,
        spec:               nextSpec,
        description:        dashboard.description || null,
        folder:             dashboard.folder || null,
      });
      dashboard = saved;
      // Clear the "Empty dashboard" placeholder on first add.
      if (tiles.length === 0 && gridEl) gridEl.innerHTML = "";
      const entry = mountChartTile(chart, "span-6", true);
      if (entry) selectTile(entry);
      return true;
    } catch (err) {
      console.warn("[designer] addChartWidget failed:", err);
      return false;
    }
  }

  // Reveal the dashboard id (useful for the workspace's create-chart
  // helper — it needs to know whether to add the new chart as a
  // widget or just open it standalone).
  function getOpenDashboardRid() { return dashboard?.redpash_id || null; }
  // Full dashboard object — workspace reads project_redpash_id from
  // it when resolving a source data file for + Add chart.
  function getOpenDashboard() { return dashboard; }

  // ── lifecycle hooks ───────────────────────────────────────────────
  function resize() { tiles.forEach((t) => t.inst?.resize?.()); }
  function unmount() {
    teardown();
    designerEl.innerHTML = "";
  }

  // Initial empty state until load(...) fires.
  renderCanvasEmpty();

  return { load, resize, unmount, addChartWidget, getOpenDashboardRid, getOpenDashboard };
}

