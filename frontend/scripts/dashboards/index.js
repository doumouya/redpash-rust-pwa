// Dashboards controller — list + builder.
//
// Phase 2: dashboards arrange *saved charts from reports* (plus text
// blocks). The slot editor doesn't pick columns or aggregations — it
// picks `{ report, chart_index }`. The chart definition lives on the
// report, where the user authored it next to its data shape.
//
// Widgets:
//   chart → spec: { report_id, chart_index, title_override? }
//   text  → spec: { markdown }

import { api }                   from "/scripts/api.js";
import { toast }                 from "/scripts/ui/toast.js";
import { TEMPLATES }             from "/scripts/dashboards/templates.js";
import { renderWidget, clearReportCache } from "/scripts/dashboards/widgets.js";
import { createHistory }         from "/scripts/ui/history.js";

const PREVIEW_DEBOUNCE_MS = 250;
const KINDS = [
  ["chart", "Chart from report"],
  ["text",  "Text"],
];

export function mount(root) {
  const listView    = root.querySelector("#dashboards-list");
  const builderView = root.querySelector("#dashboards-builder");
  const listBody    = root.querySelector("#dashboards-list-body");

  // Builder refs.
  const titleInput  = builderView.querySelector("#dashboard-title");
  const folderInput = builderView.querySelector("#dashboard-folder");
  const folderList  = builderView.querySelector("#dashboard-folders-list");
  const templateSel = builderView.querySelector("#dashboard-template");
  const slotsHost   = builderView.querySelector("#dashboard-slots");
  const previewHost = builderView.querySelector("#dashboard-preview");
  const favBtn      = builderView.querySelector("#dashboard-fav");
  const saveBtn     = builderView.querySelector("[data-save]");
  const saveAsBtn   = builderView.querySelector("[data-save-as]");
  const delBtn      = builderView.querySelector("[data-del]");
  const newBtn      = listView.querySelector("[data-new]");

  // Builder state.
  let rid           = null;
  let project       = null;
  let isFavorite    = false;
  let projectReports = [];   // [{redpash_id, title, spec:{charts:[…]}, …}]
  let knownFolders  = [];
  const dashSpec    = { template_id: "2x2", widgets: [] };
  let previewTimer  = null;
  // Client-side undo/redo over `dashSpec`. Snapshot in `previewSoon`
  // — every spec-mutating handler already calls it.
  const history       = createHistory(dashSpec);
  let   lastSnapshot  = JSON.stringify(dashSpec);
  const undoBtn       = builderView.querySelector("[data-undo]");
  const redoBtn       = builderView.querySelector("[data-redo]");

  // Mode dispatch.
  const id   = queryArg("id");
  const neww = queryArg("new");
  if (id)        openExisting(id);
  else if (neww) openNew();
  else            showList();

  newBtn.addEventListener("click", () => { location.hash = "#/dashboards?new=1"; });

  // Tier 2 E — warm the other pages' list caches in the background so
  // navigating away from the dashboard list paints instantly.
  // showList itself fetches /dashboards via SWR; loadProjectReports
  // (the builder path) warms /projects + /reports on demand. The rest
  // pre-warms here.
  api.prewarm(["/projects", "/files", "/reports", "/users", "/companies"]);

  // ─── List ──────────────────────────────────────────────
  // SWR (Phase 1 A): paint from cached /dashboards first if available,
  // then await fresh for the correction pass. Cold cache shows
  // "Loading…" once; subsequent mounts see the folder groups instantly.
  function _paintDashboardsList(items) {
    if (!items?.length) {
      listBody.innerHTML = `<p class="rp-muted">No dashboards yet. Click <strong>New dashboard</strong> to start.</p>`;
      return;
    }
    const groups = new Map();
    for (const d of items) {
      const key = d.folder?.trim() ? d.folder : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    listBody.innerHTML = Array.from(groups.entries()).map(([folder, items]) => `
        <section class="rp-reports__folder">
          <h2 class="rp-reports__folder-title">${folder ? "📁 " + esc(folder) : "Uncategorised"} <span class="rp-muted">· ${items.length}</span></h2>
          <table class="rp-project-files">
            <thead><tr><th></th><th>Title</th><th>Widgets</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              ${items.map((d) => `
                <tr>
                  <td>
                    <button class="rp-fav ${d.is_favorite ? "is-on" : ""}"
                            data-fav="${esc(d.redpash_id)}"
                            aria-label="${d.is_favorite ? "Unfavorite" : "Favorite"}">★</button>
                  </td>
                  <td><a href="#/dashboards?id=${encodeURIComponent(d.redpash_id)}">${esc(d.title)}</a></td>
                  <td class="rp-muted">${d.spec?.widgets?.length ?? 0}</td>
                  <td>${esc(new Date(d.updated_at).toLocaleString())}</td>
                  <td>
                    <button class="rp-btn rp-btn--sm rp-btn--danger" data-del-row="${esc(d.redpash_id)}">Delete</button>
                  </td>
                </tr>`).join("")}
            </tbody>
          </table>
        </section>
      `).join("");
  }

  // Click delegation — re-attached after every paint since the previous
  // listener (added with { once: true }) self-removes on first fire.
  function _attachDashboardsListHandlers() {
    listBody.addEventListener("click", async (e) => {
      const favBtnEl = e.target.closest("[data-fav]");
      if (favBtnEl) {
        const did = favBtnEl.dataset.fav;
        const on  = favBtnEl.classList.contains("is-on");
        favBtnEl.classList.toggle("is-on");
        try {
          await api.post(`/dashboards/${encodeURIComponent(did)}/favorite`, { value: !on });
          showList();
        } catch (err) {
          favBtnEl.classList.toggle("is-on");
          toast.error(err.message ?? String(err));
        }
        return;
      }
      const delBtnEl = e.target.closest("[data-del-row]");
      if (!delBtnEl) return;
      if (!confirm("Delete this dashboard?")) return;
      try {
        await api.delete(`/dashboards/${encodeURIComponent(delBtnEl.dataset.delRow)}`);
        showList();
      } catch (err) { toast.error(err.message ?? String(err)); }
    }, { once: true });
  }

  async function showList() {
    listView.hidden = false;
    builderView.hidden = true;

    const { cached, fresh } = api.getCached("/dashboards");
    if (cached?.items) {
      _paintDashboardsList(cached.items);
      _attachDashboardsListHandlers();
    } else {
      listBody.innerHTML = `<p class="rp-muted">Loading…</p>`;
    }

    try {
      const res = await fresh;
      _paintDashboardsList(res.items ?? []);
      _attachDashboardsListHandlers();
    } catch (err) {
      if (!cached) {
        listBody.innerHTML = `<p class="rp-muted">Couldn't load dashboards: ${esc(err.message ?? String(err))}</p>`;
      }
      // else: keep the cached paint + listener; retry on next showList.
    }
  }

  // ─── Builder lifecycle ─────────────────────────────────
  async function openNew() {
    listView.hidden = true;
    builderView.hidden = false;
    rid = null;
    isFavorite = false;
    favBtn.hidden = true;
    saveAsBtn.hidden = true;
    delBtn.hidden = true;
    titleInput.value  = "Untitled dashboard";
    folderInput.value = "";
    dashSpec.template_id = "2x2";
    dashSpec.widgets = [];
    // Pre-seed the project from the URL when present (the Objects-page
    // "New dashboard for this project" affordance carries `?project=PRJ_xxx`).
    // loadProjectReports() defaults `project` to the first project only
    // when it's still null, so setting it here wins.
    const seedProject = queryArg("project");
    if (seedProject) project = seedProject;
    await refreshFolderList();
    await loadProjectReports();
    populateTemplateSelect();
    renderSlots();
    history.reset(dashSpec);
    lastSnapshot = JSON.stringify(dashSpec);
    syncUndoButtons();
    renderPreview();
  }

  async function openExisting(id) {
    listView.hidden = true;
    builderView.hidden = false;
    previewHost.innerHTML = `<p class="rp-muted">Loading…</p>`;
    try {
      const d = await api.get(`/dashboards/${encodeURIComponent(id)}`);
      rid        = d.redpash_id;
      project    = d.project_redpash_id;
      isFavorite = !!d.is_favorite;
      favBtn.hidden = false;
      favBtn.classList.toggle("is-on", isFavorite);
      saveAsBtn.hidden = false;
      delBtn.hidden    = false;
      titleInput.value  = d.title;
      folderInput.value = d.folder ?? "";
      dashSpec.template_id = d.spec?.template_id || "2x2";
      dashSpec.widgets     = Array.isArray(d.spec?.widgets) ? d.spec.widgets : [];
      // Filter out legacy widget kinds (kpi/table or old `chart` shape
      // with group_by/agg). The chart-ref shape carries `report_id`;
      // anything missing it can't render, so blank the spec and force
      // a reconfigure.
      dashSpec.widgets = dashSpec.widgets.map((w) => {
        if (w?.kind === "chart" && !w.spec?.report_id) return { ...w, spec: {} };
        if (w?.kind === "kpi" || w?.kind === "table")  return { ...w, kind: "chart", spec: {} };
        return w;
      });
      await refreshFolderList();
      await loadProjectReports();
      populateTemplateSelect();
      renderSlots();
      history.reset(dashSpec);
      lastSnapshot = JSON.stringify(dashSpec);
      syncUndoButtons();
      renderPreview();
    } catch (err) {
      previewHost.innerHTML = `<p class="rp-muted">Couldn't load dashboard: ${esc(err.message ?? String(err))}</p>`;
    }
  }

  async function loadProjectReports() {
    // Write-through SWR — getCached.fresh writes the localStorage cache
    // on success so subsequent showList / Profile mounts pick up the
    // newly-warm values via api.getCached read.
    try {
      const projects = await api.getCached("/projects").fresh;
      const def = projects.items?.[0];
      if (!def) { projectReports = []; return; }
      project = project ?? def.redpash_id;
      const reports = await api.getCached("/reports").fresh;
      projectReports = (reports.items ?? []).filter((r) => r.project_redpash_id === project);
    } catch (err) {
      console.error("[dashboards] reports fetch failed", err);
      projectReports = [];
    }
  }

  async function refreshFolderList() {
    // Write-through SWR — write the /dashboards cache so showList's
    // SWR paint stays current after a fold rename / delete.
    try {
      const res = await api.getCached("/dashboards").fresh;
      const set = new Set();
      (res.items ?? []).forEach((d) => { if (d.folder) set.add(d.folder); });
      knownFolders = Array.from(set).sort();
      folderList.innerHTML = knownFolders.map((f) => `<option value="${esc(f)}"></option>`).join("");
    } catch { /* leave empty */ }
  }

  function populateTemplateSelect() {
    templateSel.innerHTML = Object.entries(TEMPLATES)
      .map(([id, t]) => `<option value="${esc(id)}"${id === dashSpec.template_id ? " selected" : ""}>${esc(t.label)}</option>`)
      .join("");
  }

  templateSel.addEventListener("change", () => {
    dashSpec.template_id = templateSel.value;
    const allowed = new Set((TEMPLATES[dashSpec.template_id]?.slots ?? []).map((s) => s.id));
    dashSpec.widgets = dashSpec.widgets.filter((w) => allowed.has(w.slot));
    renderSlots();
    renderPreview();
  });

  // ─── Slot editor ───────────────────────────────────────
  function renderSlots() {
    // Preserve which slots are expanded — without this every dropdown
    // change collapses the panel because the parent re-renders.
    const openSlots = new Set(
      [...slotsHost.querySelectorAll(".rp-dash-slot[open]")].map((el) => el.dataset.slot)
    );
    const tpl = TEMPLATES[dashSpec.template_id] ?? TEMPLATES["1x1"];
    slotsHost.innerHTML = tpl.slots.map((slot) => {
      const w = widgetForSlot(slot.id);
      const kind = w?.kind ?? "";
      const safeId = `slot-${slot.id}`.replace(/[^a-z0-9_-]/gi, "_");
      const openAttr = openSlots.has(slot.id) ? " open" : "";
      return `
        <details class="rp-dash-slot" id="${safeId}" data-slot="${esc(slot.id)}"${openAttr}>
          <summary>
            <span class="rp-dash-slot__name">${esc(slot.label)}</span>
            <span class="rp-muted rp-dash-slot__kind">${kind ? esc(kindLabel(kind)) : "—"}</span>
          </summary>
          <div class="rp-dash-slot__body">
            <label class="rp-dash-slot__row">
              <span>Type</span>
              <select data-field="kind">
                <option value=""${kind === "" ? " selected" : ""}>(empty)</option>
                ${KINDS.map(([v, l]) => `<option value="${v}"${v === kind ? " selected" : ""}>${l}</option>`).join("")}
              </select>
            </label>
            ${renderKindEditor(kind, w?.spec ?? {})}
          </div>
        </details>`;
    }).join("");

    slotsHost.querySelectorAll(".rp-dash-slot").forEach((slotEl) => {
      slotEl.addEventListener("input",  onSlotEdit);
      slotEl.addEventListener("change", onSlotEdit);
    });
  }

  function onSlotEdit(e) {
    const slotEl = e.currentTarget;
    const slot = slotEl.dataset.slot;
    const kind = slotEl.querySelector('[data-field="kind"]').value;
    if (!kind) {
      dashSpec.widgets = dashSpec.widgets.filter((w) => w.slot !== slot);
      renderSlots();
      previewSoon();
      return;
    }
    let w = widgetForSlot(slot);
    if (!w || w.kind !== kind) {
      w = { slot, kind, spec: defaultsForKind(kind) };
      const i = dashSpec.widgets.findIndex((x) => x.slot === slot);
      if (i >= 0) dashSpec.widgets[i] = w; else dashSpec.widgets.push(w);
      renderSlots();
    } else {
      collectKindSpec(slotEl, w);
      // Changing report → reset chart_index and re-render the slot
      // editor so the chart dropdown reflects the new report's charts.
      if (e.target?.dataset?.field === "report_id") {
        w.spec.chart_index = 0;
        renderSlots();
      }
    }
    previewSoon();
  }

  function defaultsForKind(kind) {
    if (kind === "chart") {
      const first = projectReports.find((r) => (r.spec?.charts ?? []).length);
      return first
        ? { report_id: first.redpash_id, chart_index: 0, title_override: "" }
        : { report_id: "", chart_index: 0, title_override: "" };
    }
    if (kind === "text") return { markdown: "## Heading\n\nWrite anything." };
    return {};
  }

  function renderKindEditor(kind, spec) {
    if (kind === "chart") {
      const reportOpts = projectReports
        .map((r) => {
          const n = (r.spec?.charts ?? []).length;
          return `<option value="${esc(r.redpash_id)}"${r.redpash_id === spec.report_id ? " selected" : ""}>${esc(r.title)}${n ? ` (${n})` : " (no charts)"}</option>`;
        }).join("");
      const report = projectReports.find((r) => r.redpash_id === spec.report_id);
      const charts = report?.spec?.charts ?? [];
      const chartOpts = charts.length
        ? charts.map((c, i) =>
            `<option value="${i}"${i === (spec.chart_index ?? 0) ? " selected" : ""}>${esc(chartLabel(c, i))}</option>`).join("")
        : `<option value="0">— no charts in this report —</option>`;
      const reportHasNoCharts = report && !charts.length;
      return `
        <label class="rp-dash-slot__row"><span>Report</span>
          <select data-field="report_id">
            <option value=""${!spec.report_id ? " selected" : ""}>— pick a report —</option>
            ${reportOpts}
          </select>
        </label>
        <label class="rp-dash-slot__row"><span>Chart</span>
          <select data-field="chart_index"${reportHasNoCharts || !report ? " disabled" : ""}>${chartOpts}</select>
        </label>
        <label class="rp-dash-slot__row"><span>Title</span>
          <input data-field="title_override" value="${esc(spec.title_override ?? "")}" placeholder="(use report's chart title)" />
        </label>
        ${reportHasNoCharts ? `<p class="rp-muted">Open this report and add a chart first.</p>` : ""}`;
    }
    if (kind === "text") {
      return `
        <label class="rp-dash-slot__row rp-dash-slot__row--column">
          <span>Markdown</span>
          <textarea data-field="markdown" rows="4">${esc(spec.markdown ?? "")}</textarea>
        </label>`;
    }
    return "";
  }

  function chartLabel(cfg, i) {
    const title = cfg?.title?.trim();
    if (title) return title;
    const yLabel = cfg?.agg === "count" ? "count" : cfg?.y;
    return `#${i + 1}: ${yLabel ?? "?"} by ${cfg?.x ?? "?"} (${cfg?.kind ?? "bar"})`;
  }
  function kindLabel(k) {
    return KINDS.find(([v]) => v === k)?.[1] ?? k;
  }

  function collectKindSpec(slotEl, widget) {
    const get = (k) => slotEl.querySelector(`[data-field="${k}"]`)?.value;
    if (widget.kind === "chart") {
      widget.spec = {
        report_id:      get("report_id") ?? "",
        chart_index:    Number(get("chart_index") ?? 0) || 0,
        title_override: get("title_override") ?? "",
      };
    } else if (widget.kind === "text") {
      widget.spec = { markdown: get("markdown") ?? "" };
    }
  }

  function widgetForSlot(slotId) {
    return dashSpec.widgets.find((w) => w.slot === slotId);
  }

  // ─── Preview ───────────────────────────────────────────
  function previewSoon() {
    captureSnapshot();
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
  }

  // Push the *previous* state to history so undo rolls back the
  // mutation that just happened. Equality check is string-based —
  // cheap and avoids dedupe drift.
  function captureSnapshot() {
    const current = JSON.stringify(dashSpec);
    if (current === lastSnapshot) return;
    history.push(JSON.parse(lastSnapshot));
    lastSnapshot = current;
    syncUndoButtons();
  }

  function applyState(s) {
    Object.keys(dashSpec).forEach((k) => delete dashSpec[k]);
    Object.assign(dashSpec, s);
    lastSnapshot = JSON.stringify(dashSpec);
    populateTemplateSelect();
    renderSlots();
    renderPreview();
    syncUndoButtons();
  }

  function syncUndoButtons() {
    if (undoBtn) undoBtn.disabled = !history.canUndo();
    if (redoBtn) redoBtn.disabled = !history.canRedo();
  }

  function doUndo() { const s = history.undo(); if (s) applyState(s); }
  function doRedo() { const s = history.redo(); if (s) applyState(s); }

  undoBtn?.addEventListener("click", doUndo);
  redoBtn?.addEventListener("click", doRedo);

  document.addEventListener("keydown", (e) => {
    if (builderView.hidden) return;
    const tag = e.target.tagName;
    const inText = tag === "INPUT" && /text|search|number|^$|^undefined$/.test(e.target.type)
                || tag === "TEXTAREA";
    if (inText) return;
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    if (e.key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); doRedo(); }
  });

  function renderPreview() {
    const tpl = TEMPLATES[dashSpec.template_id] ?? TEMPLATES["1x1"];
    // NB: outer style attribute uses single quotes so the inner double
    // quotes in `grid-template-areas: "a b" "c d"` survive HTML parsing.
    // Without this the areas attribute terminates early and every cell
    // falls back to auto-placement (stacked → only the last is visible).
    previewHost.innerHTML = `
      <div class="rp-dash-grid" style='
        grid-template-columns: ${tpl.grid.columns};
        grid-template-rows:    ${tpl.grid.rows};
        grid-template-areas:   ${tpl.grid.areas};
      '>
        ${tpl.slots.map((slot) => `
          <div class="rp-dash-cell" style="grid-area: ${slot.id}" data-slot="${esc(slot.id)}">
          </div>`).join("")}
      </div>`;
    requestAnimationFrame(() => {
      tpl.slots.forEach((slot) => {
        const cell = previewHost.querySelector(`[data-slot="${cssEsc(slot.id)}"]`);
        const w    = widgetForSlot(slot.id);
        if (!w || !w.kind) {
          cell.innerHTML = `<div class="rp-dash-cell__empty rp-muted">${esc(slot.label)} — empty</div>`;
          return;
        }
        renderWidget(cell, w);
      });
    });
  }

  // ─── Header buttons ────────────────────────────────────
  saveBtn.addEventListener("click", async () => {
    if (!project) project = await firstProjectId();
    const body = currentBody();
    saveBtn.disabled = true;
    try {
      const d = rid
        ? await api.put(`/dashboards/${encodeURIComponent(rid)}`, body)
        : await api.post("/dashboards", body);
      rid = d.redpash_id;
      isFavorite    = !!d.is_favorite;
      favBtn.hidden = false;
      favBtn.classList.toggle("is-on", isFavorite);
      saveAsBtn.hidden = false;
      delBtn.hidden    = false;
      await refreshFolderList();
      history.replaceState(null, "", `#/dashboards?id=${encodeURIComponent(rid)}`);
      toast.success(`Saved "${d.title}"`);
    } catch (err) { toast.error(err.message ?? String(err)); }
    finally { saveBtn.disabled = false; }
  });

  saveAsBtn.addEventListener("click", async () => {
    const suggested = `${titleInput.value.trim() || "Untitled"} (copy)`;
    const t = (prompt("Save dashboard as:", suggested) ?? "").trim();
    if (!t) return;
    saveAsBtn.disabled = true;
    try {
      const body = { ...currentBody(), title: t };
      const d = await api.post("/dashboards", body);
      location.hash = `#/dashboards?id=${encodeURIComponent(d.redpash_id)}`;
      location.reload();
    } catch (err) { toast.error(err.message ?? String(err)); }
    finally { saveAsBtn.disabled = false; }
  });

  delBtn.addEventListener("click", async () => {
    if (!rid) return;
    if (!confirm("Delete this dashboard?")) return;
    try {
      await api.delete(`/dashboards/${encodeURIComponent(rid)}`);
      location.hash = "#/dashboards";
    } catch (err) { toast.error(err.message ?? String(err)); }
  });

  favBtn.addEventListener("click", async () => {
    if (!rid) return;
    const next = !isFavorite;
    favBtn.classList.toggle("is-on", next);
    try {
      const d = await api.post(`/dashboards/${encodeURIComponent(rid)}/favorite`, { value: next });
      isFavorite = !!d.is_favorite;
      favBtn.classList.toggle("is-on", isFavorite);
    } catch (err) {
      favBtn.classList.toggle("is-on", isFavorite);
      toast.error(err.message ?? String(err));
    }
  });

  function currentBody() {
    return {
      project_redpash_id: project,
      title:  titleInput.value.trim() || "Untitled dashboard",
      folder: folderInput.value.trim() || null,
      spec:   { template_id: dashSpec.template_id, widgets: dashSpec.widgets },
    };
  }

  async function firstProjectId() {
    // Write-through SWR — keeps the /projects cache warm for cross-page
    // first-paint via api.getCached read elsewhere.
    const projects = await api.getCached("/projects").fresh;
    return projects.items?.[0]?.redpash_id ?? null;
  }

  // Clear the widget renderer's report cache on unmount so re-entering
  // the page after editing a report fetches fresh data. Router calls
  // mount() again so this runs at page transition.
  clearReportCache();
}

function queryArg(name) {
  const m = location.hash.match(new RegExp(`[?&]${name}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function cssEsc(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`); }
