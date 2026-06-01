/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/designer.md */
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
import { getPref } from "/scripts/prefs.js";
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
//
// `theme` reads the workspace-defaultChartTheme pref (Settings v2
// step 6c follow-up) so users can pick their preferred ECharts
// theme palette for every new chart. Lazy-read via the getter
// below — module-load order means prefs.js may not have populated
// the registry yet when this module imports, so we resolve at
// access time, not at module init.
const DEFAULTS = {
  legend: false, legendPos: "bottom",
  tooltip: true, splitLines: true, axisLine: true,
  get theme() { return getPref("workspace-defaultChartTheme") || "vintage"; },
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
    // The Data section reads the SELECTED tile's own source (rid +
    // columns), not the workspace's last-opened file — a multi-tile
    // dashboard can mix sources. `files` is the project's data-file
    // list (for the source dropdown); the workspace supplies it.
    getSource:   () => sel ? {
      kind:    "file",
      rid:     sel.sourceRid || sel.chart?.source_file_id || null,
      label:   sourceLabel(sel.sourceRid || sel.chart?.source_file_id),
      columns: sel.sourceColumns || [],
      files:   ctx.getSourceFiles?.() || [],
    } : null,
    // Style / type / theme edit → live-rerender the selected tile +
    // mark IT dirty (enabling its own save button). The chart config
    // persists via the per-tile save, NOT the dashboard save (the
    // dashboard spec only carries chart_id refs).
    onCfgChange: () => { if (sel) { rerender(sel); markTileDirty(sel, true); } },
    // Group-by / agg-fn / agg-col edit → re-aggregate from source
    // (/api/group/preview) then rerender. Marks the tile dirty so the
    // new shape persists on the next per-tile save.
    onDataChange: () => { if (sel) { markTileDirty(sel, true); void reaggregate(sel); } },
    // Source-file dropdown changed → swap the tile's data file, refetch
    // its columns, reset stale column picks, re-aggregate.
    onSourceChange: (rid) => { if (sel) void changeSource(sel, rid); },
    // ds-config-save (builder header) = save the whole dashboard.
    onSave:      () => saveDashboard(),
  });

  // Resolve a source-file rid to its display name via the project file
  // list the workspace supplies. Falls back to the rid when unknown
  // (e.g. the list hasn't loaded yet).
  function sourceLabel(rid) {
    if (!rid) return null;
    const files = ctx.getSourceFiles?.() || [];
    return files.find((f) => f.rid === rid)?.name || rid;
  }

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
        // A real (saved) dashboard can always be re-saved — enable the
        // ds-config-save button. Synthetic chart-only wrappers (null
        // rid) leave it disabled (saveDashboard hints instead).
        if (dashboard?.redpash_id) builder.setDirty(true);
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
      // 404 on a widget's chart = the chart was deleted out from under
      // the dashboard. Prune the dead reference instead of leaving a
      // permanent "chart unavailable" tile (Em 2026-05-28). Other errors
      // (500 / network) are transient — keep the widget and show a
      // recoverable error tile.
      let prunedAny = false;
      results.forEach((res, i) => {
        const w = widgets[i];
        if (res?.__err) {
          if (res.__err.status === 404) {
            dashboard.spec = pruneWidget(dashboard.spec, w.spec?.chart_id);
            prunedAny = true;
          } else {
            gridEl.appendChild(makeErrorTile(w, res.__err));
          }
          return;
        }
        // Default span — alternate 6/6 for now. Slot/template-aware
        // sizing comes when the template registry lands.
        const span = "span-6";
        mountChartTile(res, span, /* selected */ false, w);
      });
      // Persist the cleaned spec so the dead refs don't resurface on the
      // next load. Real dashboards only — synthetic wrappers have no rid.
      if (prunedAny && dashboard?.redpash_id) {
        try {
          const saved = await putDashboard();
          if (saved) dashboard = saved;
        } catch (e) {
          console.warn("[designer] dashboard self-heal persist failed:", e);
        }
      }
      // Select the first successfully-loaded tile so the accordion has
      // content; if pruning emptied the canvas, show the empty state.
      if (tiles.length) {
        selectTile(tiles[0]);
      } else if (gridEl) {
        gridEl.innerHTML = '<p class="ds-empty">Empty dashboard. Use <i>Add chart</i> to add a widget.</p>';
      }
      // Enable the dashboard-save button for a real dashboard (see
      // the empty-case note above). Called after selectTile since
      // builder.render() inside it resets the button baseline.
      if (dashboard?.redpash_id) builder.setDirty(true);
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
                    widget: widget || null, themeName,
                    // Per-tile data source. sourceColumns is lazily
                    // fetched (ensureTileSource) the first time the tile
                    // is selected — a multi-tile dashboard can have
                    // tiles drawing from different files.
                    sourceRid: chart.source_file_id || null,
                    sourceColumns: null };
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
    // Tile-head actions (Em 2026-05-28): edit (focus the builder on
    // this chart) · save (PUT this chart to the project) · delete
    // (DELETE the chart from the project) · close (drop the tile from
    // the canvas without touching the DB). The save button starts
    // disabled; an accordion edit on the selected tile enables it.
    el.innerHTML = ''
      + '<div class="ds-tile-head">'
      +   '<span class="ds-tile-title">' + esc(cfg.title) + '</span>'
      +   '<div class="ds-tile-actions">'
      +     '<button class="ds-tile-act ds-tile-edit"  type="button" title="Edit chart"><i class="bi bi-pencil"></i></button>'
      +     '<button class="ds-tile-act ds-tile-save"  type="button" title="Save chart" disabled><i class="bi bi-save"></i></button>'
      +     '<button class="ds-tile-act ds-tile-del"   type="button" title="Delete chart"><i class="bi bi-trash3"></i></button>'
      +     '<button class="ds-tile-act ds-tile-close" type="button" title="Remove from canvas"><i class="bi bi-x-lg"></i></button>'
      +   '</div>'
      + '</div>'
      + '<div class="ds-tile-body"><div class="ds-chart"></div></div>';
    return el;
  }

  // ── selection ─────────────────────────────────────────────────────
  function selectTile(entry) {
    sel = entry;
    tiles.forEach((t) => t.tileEl.classList.toggle("selected", t === entry));
    builder.render();
    // Fetch the tile's source columns lazily; re-render the accordion
    // once they arrive so the group-by / measure dropdowns populate.
    // Guarded on `sel === entry` so a fast tile-to-tile switch doesn't
    // paint stale columns into the now-current tile's panel.
    ensureTileSource(entry).then(() => { if (sel === entry) builder.render(); });
  }

  // Inline title rename — edit the title RIGHT in the tile header where
  // the pencil is, instead of bouncing the user to the config panel's
  // Title field. Enter / blur commits, Esc cancels. The value writes
  // straight to entry.cfg.title (saveChart's source) and marks the tile
  // dirty; re-rendering the panel keeps its Title field in step. The
  // reverse sync (panel → header) already lives in the asideEl input
  // listener, so both directions now agree.
  function startTitleEdit(entry) {
    const span = entry?.tileEl?.querySelector(".ds-tile-title");
    if (!span || span.isContentEditable) return;
    const original = entry.cfg.title || "Untitled chart";
    span.contentEditable = "true";
    span.spellcheck = false;
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const selc = window.getSelection();
    selc.removeAllRanges();
    selc.addRange(range);
    let done = false;
    const commit = (cancel) => {
      if (done) return;
      done = true;
      span.removeEventListener("blur", onBlur);
      span.removeEventListener("keydown", onKey);
      span.contentEditable = "false";
      const val = cancel ? original : ((span.textContent || "").trim() || "Untitled chart");
      span.textContent = val;
      if (!cancel && val !== original) {
        entry.cfg.title = val;
        markTileDirty(entry, true);
        if (sel === entry) builder.render();  // keep the panel's Title field in sync
      }
    };
    const onBlur = () => commit(false);
    const onKey  = (ev) => {
      if (ev.key === "Enter")       { ev.preventDefault(); span.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); commit(true); }
    };
    span.addEventListener("blur", onBlur);
    span.addEventListener("keydown", onKey);
  }

  // Fetch + cache a tile's source-file columns (one /files/:rid hit per
  // tile, memoised on the entry). Best-effort — a failed fetch leaves
  // the dropdowns degraded to static lines rather than blocking.
  async function ensureTileSource(entry) {
    const rid = entry?.sourceRid || entry?.chart?.source_file_id;
    if (!rid) return;
    if (entry.sourceRid === rid && Array.isArray(entry.sourceColumns)) return;
    try {
      const env = await api.get("/files/" + encodeURIComponent(rid));
      entry.sourceRid = rid;
      entry.sourceColumns = env?.columns || [];
    } catch {
      entry.sourceRid = rid;
      entry.sourceColumns = entry.sourceColumns || [];
    }
  }

  // Re-aggregate a tile from its source file via the stateless grouping
  // engine (/api/group/preview), then rebuild the tile's baked option so
  // buildOption renders the new shape. The spec is the chart's own
  // group-by + measure — one row group, one aggregation, subtotals only
  // (details/total are noise for a chart). count(*) maps to a count over
  // the group-by column (the engine rejects literal aggregations).
  async function reaggregate(entry) {
    if (!entry) return;
    const srcRid = entry.sourceRid || entry.chart?.source_file_id;
    const groupBy = entry.cfg.group_by;
    if (!srcRid || !groupBy) { rerender(entry); return; }
    const aggFn  = entry.cfg.agg_fn  || "count";
    const aggCol = entry.cfg.agg_col || "*";
    const col = (aggFn === "count" && aggCol === "*") ? groupBy : aggCol;
    const spec = {
      group_by:       [groupBy],
      aggregations:   [{ col, fn: aggFn }],
      show_details:   false,
      show_subtotals: true,
      show_total:     false,
    };
    try {
      const page = await api.post("/group/preview", { source_file_id: srcRid, spec });
      const sub  = page?.subtotals;
      if (sub && Array.isArray(sub.rows) && sub.rows.length) {
        // subtotals columns = [group_by, …, aggAlias]; label is the
        // first cell, the measure is the last.
        const valIdx  = Math.max(0, (sub.columns?.length || 1) - 1);
        const labels  = sub.rows.map((r) => r[0]);
        const values  = sub.rows.map((r) => Number(r[valIdx]) || 0);
        const aggLabel = (aggFn === "count" && aggCol === "*")
          ? "count" : aggFn + "(" + aggCol + ")";
        entry.cfg.option = {
          xAxis:  { data: labels },
          series: [{ name: aggLabel, data: values }],
        };
      }
    } catch (err) {
      console.warn("[designer] reaggregate failed:", err);
    }
    rerender(entry);
  }

  // Swap a tile's source data file. Refetches columns, drops column
  // picks the new file doesn't have (group-by → first column; a column
  // measure → count(*)), marks the tile dirty so the new source_file_id
  // persists on save, then re-aggregates.
  async function changeSource(entry, newRid) {
    if (!entry || !newRid) return;
    if (newRid === (entry.sourceRid || entry.chart?.source_file_id)) return;
    entry.chart = { ...(entry.chart || {}), source_file_id: newRid };
    entry.sourceRid = newRid;
    entry.sourceColumns = null;
    await ensureTileSource(entry);
    const colNames = (entry.sourceColumns || []).map((c) => c.name);
    if (!colNames.includes(entry.cfg.group_by)) {
      entry.cfg.group_by = colNames[0] || "";
    }
    if (entry.cfg.agg_col !== "*" && !colNames.includes(entry.cfg.agg_col)) {
      entry.cfg.agg_col = "*";
      entry.cfg.agg_fn  = "count";
    }
    markTileDirty(entry, true);
    builder.render();
    await reaggregate(entry);
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

  // Per-tile chart save — PUT /api/charts/:rid for one tile's chart.
  // Persists the chart's current config (the live accordion edits +
  // the baked ECharts option) to the project. Independent of the
  // dashboard save below — a chart is a project_files row in its own
  // right; saving the chart doesn't touch the dashboard spec.
  async function saveChart(entry) {
    if (!entry || busy) return;
    busy = true;
    setTileBusy(entry, true);
    try {
      const baked = entry.inst?.getOption?.() || null;
      const body = {
        source_file_id: entry.chart.source_file_id,
        title:          entry.cfg.title,
        spec: {
          kind:       entry.cfg.kind,
          type:       entry.cfg.type,
          title:      entry.cfg.title,
          legend:     entry.cfg.legend,
          legendPos:  entry.cfg.legendPos,
          tooltip:    entry.cfg.tooltip,
          splitLines: entry.cfg.splitLines,
          axisLine:   entry.cfg.axisLine,
          smooth:     entry.cfg.smooth,
          theme:      entry.cfg.theme,
          group_by:   entry.cfg.group_by,
          agg_col:    entry.cfg.agg_col,
          agg_fn:     entry.cfg.agg_fn,
          option:     baked,
        },
      };
      const saved = await api.put("/charts/" + encodeURIComponent(entry.rid), body);
      entry.chart = saved;
      ctx.onSaved?.(saved);
      markTileDirty(entry, false);
    } catch (err) {
      console.warn("[designer] chart save failed:", err);
    } finally {
      busy = false;
      setTileBusy(entry, false);
    }
  }

  // Delete a chart from the project — DELETE /api/charts/:rid, then
  // drop the tile + (when a real dashboard is open) prune the widget
  // from its spec + persist. Destructive: the chart row is gone.
  async function deleteChart(entry) {
    if (!entry || busy) return;
    busy = true;
    setTileBusy(entry, true);
    try {
      await api.delete("/charts/" + encodeURIComponent(entry.rid));
      // Drop the matching widget from the open dashboard's spec AND
      // persist it immediately — otherwise the dead chart_id lingers in
      // the DB and resurfaces as a "chart unavailable" tile on the next
      // dashboard load (Em 2026-05-28). Synthetic chart-only wrappers
      // (null rid) have nothing to persist.
      if (dashboard?.redpash_id) {
        dashboard.spec = pruneWidget(dashboard.spec, entry.rid);
        try {
          const saved = await putDashboard();
          if (saved) dashboard = saved;
        } catch (e) {
          console.warn("[designer] dashboard prune-persist failed:", e);
        }
      }
      ctx.onSaved?.(null);   // signal the rail to refresh (chart gone)
      dropTile(entry);
    } catch (err) {
      console.warn("[designer] chart delete failed:", err);
      setTileBusy(entry, false);
    } finally {
      busy = false;
    }
  }

  // Remove a tile from the canvas WITHOUT deleting the chart. The chart
  // row stays in the project; only this dashboard's widget reference is
  // dropped (persisted on the next dashboard save). For a synthetic
  // (chart-only) canvas, close just clears the canvas back to empty.
  function closeTile(entry) {
    if (!entry) return;
    if (dashboard?.redpash_id) {
      dashboard.spec = pruneWidget(dashboard.spec, entry.rid);
    }
    dropTile(entry);
  }

  // Shared tile teardown — dispose the ECharts instance, remove the
  // DOM node, drop from the tiles[] registry, clear selection if it
  // was selected. Used by both delete + close.
  function dropTile(entry) {
    entry.inst?.dispose?.();
    entry.tileEl?.remove();
    tiles = tiles.filter((t) => t !== entry);
    if (sel === entry) { sel = null; builder.render(); }
    if (!tiles.length && gridEl) {
      gridEl.innerHTML = '<p class="ds-empty">Empty dashboard. Use <i>Add chart</i> to add a widget.</p>';
    }
  }

  // Per-tile dirty flag — accordion edits on the selected tile flip it
  // on (enabling that tile's save button); a successful chart save
  // clears it. Distinct from the dashboard-level `dirty` (structural).
  function markTileDirty(entry, on) {
    if (!entry) return;
    entry.dirty = on;
    const btn = entry.tileEl?.querySelector(".ds-tile-save");
    if (btn) btn.disabled = !on || busy;
    entry.tileEl?.classList.toggle("ds-tile--dirty", on);
  }
  function setTileBusy(entry, on) {
    const btn = entry?.tileEl?.querySelector(".ds-tile-save");
    if (btn) btn.disabled = on || !entry.dirty;
  }

  // Drop the widget referencing `chartId` from a dashboard spec,
  // preserving the rest. Shared by per-tile delete, close, and the
  // load-time self-heal that prunes refs to deleted charts.
  function pruneWidget(spec, chartId) {
    return {
      ...(spec || { template_id: "" }),
      widgets: (spec?.widgets || []).filter((w) => w.spec?.chart_id !== chartId),
    };
  }

  // Persist the open dashboard's current spec. Pure — no UI side
  // effects, returns the saved row (or null when there's no real DSH_
  // to write to). Callers decide what to do with the result.
  async function putDashboard() {
    if (!dashboard?.redpash_id) return null;
    return api.put("/dashboards/" + encodeURIComponent(dashboard.redpash_id), {
      project_redpash_id: dashboard.project_redpash_id,
      title:              dashboard.title,
      spec:               dashboard.spec || { template_id: "", widgets: [] },
      description:        dashboard.description || null,
      folder:             dashboard.folder || null,
    });
  }

  // Whole-dashboard save — persists the current spec (template + widget
  // refs). Persists structural changes (tiles added / removed /
  // reordered) — NOT the per-chart config (that's the per-tile save's
  // job; the dashboard spec only carries chart_id references). No-op +
  // hint when the canvas is a synthetic chart-only wrapper (no real
  // DSH_ rid to write to).
  async function saveDashboard() {
    if (busy) return;
    if (!dashboard?.redpash_id) {
      ctx.onDashboardSaveUnavailable?.();
      return;
    }
    busy = true; builder.setDirty(false);
    try {
      const saved = await putDashboard();
      if (saved) dashboard = saved;
      ctx.onSaved?.(saved);
      setDirty(false);
    } catch (err) {
      console.warn("[designer] dashboard save failed:", err);
    } finally {
      busy = false;
    }
  }

  // ── handlers ──────────────────────────────────────────────────────
  // Canvas: tile-head action buttons short-circuit before the
  // select-on-click fallback (each ends in `return`). Plain tile
  // click selects.
  gridEl.addEventListener("click", (e) => {
    const t = e.target.closest(".ds-tile");
    if (!t) return;
    const entry = tiles.find((x) => x.tileEl === t);
    if (!entry) return;

    if (e.target.closest(".ds-tile-edit"))  { selectTile(entry); startTitleEdit(entry); return; }
    if (e.target.closest(".ds-tile-save"))  { void saveChart(entry); return; }
    if (e.target.closest(".ds-tile-del"))   { void deleteChart(entry); return; }
    if (e.target.closest(".ds-tile-close")) { closeTile(entry); return; }

    selectTile(entry);
  });

  // Accordion event handlers + the builder header's save button live
  // inside mountBuilder. The `onCfgChange` hook pipes every accordion
  // edit through rerender(sel) + markTileDirty(sel, true) (the per-
  // tile save commits chart config); `onSave` (the ds-config-save
  // button) calls saveDashboard(). The one side effect that stays
  // here is the tile-header text — it sits outside the chart canvas
  // so ECharts setOption doesn't reach it.
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

