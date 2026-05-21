// Dashboards page — full canvas + floating tools.
//
// This file:
//   • Pulls in the partial subtree via rpInclude (router doesn't
//     recurse into data-include).
//   • Wires the floating tools window: drag, collapse / restore, and
//     persists position + collapsed state via prefs.dashboards_tools_pos.
//   • Saved-chart widgets — initWidgets(): charts authored on the
//     Reports page are persisted to localStorage (rp_saved_charts_v1)
//     as self-contained artifacts (a baked-in ECharts `option` plus an
//     SVG snapshot). The dashboard binds those charts to canvas slots
//     via the +Widget picker and renders them straight from the option.
//
// Still TODO: template selector, dashboard save/export to /api/dashboards.
//
// The old multi-file delegator (/scripts/dashboards/index.js) is no
// longer called — its DOM hooks (#dashboards-list, #dashboards-builder)
// don't exist in the new shell. Kept on disk for revertability.

import { loadECharts } from "/scripts/dashboards/echarts.js";

export default async function mount(root, ctx) {
  // Sandbox subtree — router only loaded the thin shell.
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[dashboards] rpInclude failed", err); }
  }

  // Open the tools window by default. spToggle from controls.js
  // toggles .open on the element; the matching CSS rule shows it.
  const win = root.querySelector("#dashboards-tools-window");
  if (win) win.classList.add("open");

  // Restore saved tools-window position + collapsed state.
  const savedPos = ctx?.session?.prefs?.dashboards_tools_pos;
  if (savedPos && typeof savedPos === "object" && win) {
    if (typeof savedPos.top === "number")  win.style.top    = savedPos.top + "px";
    if (typeof savedPos.left === "number") win.style.left   = savedPos.left + "px";
    if (typeof savedPos.top === "number")  win.style.bottom = "auto";
    if (typeof savedPos.left === "number") win.style.right  = "auto";
    if (savedPos.collapsed) win.classList.add("is-collapsed");
  }

  // Drag wiring — pointer events on the header. Header has CSS
  // cursor: grab; while dragging we add .is-dragging on the window
  // for the deeper shadow.
  const drag = root.querySelector("[data-dashboards-tools-drag]");
  if (drag && win && !drag.__rpBound) {
    drag.__rpBound = true;
    let dragging = false;
    let originLeft = 0, originTop = 0;
    let startX = 0,     startY = 0;
    let bodyEl  = null;

    const startDrag = (ev) => {
      // Ignore clicks on the buttons inside the header (collapse/close).
      if (ev.target.closest("button")) return;
      bodyEl = root.querySelector(".rp-rt-body");
      if (!bodyEl) return;
      const rect = win.getBoundingClientRect();
      const bodyRect = bodyEl.getBoundingClientRect();
      originLeft = rect.left - bodyRect.left;
      originTop  = rect.top  - bodyRect.top;
      startX = ev.clientX;
      startY = ev.clientY;
      dragging = true;
      win.classList.add("is-dragging");
      drag.setPointerCapture?.(ev.pointerId);
      // Switch from bottom/right anchoring to top/left so the inline
      // style updates land at predictable positions.
      win.style.bottom = "auto";
      win.style.right  = "auto";
      win.style.top    = originTop  + "px";
      win.style.left   = originLeft + "px";
      ev.preventDefault();
    };
    const moveDrag = (ev) => {
      if (!dragging || !bodyEl) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Clamp to body bounds so the window can't escape off-screen.
      const winRect  = win.getBoundingClientRect();
      const bodyRect = bodyEl.getBoundingClientRect();
      const maxLeft = bodyRect.width  - winRect.width;
      const maxTop  = bodyRect.height - winRect.height;
      let nextLeft = originLeft + dx;
      let nextTop  = originTop  + dy;
      nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
      nextTop  = Math.max(0, Math.min(nextTop,  maxTop));
      win.style.left = nextLeft + "px";
      win.style.top  = nextTop  + "px";
    };
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      win.classList.remove("is-dragging");
      drag.releasePointerCapture?.(ev.pointerId);
      // Persist position + collapsed state. dashboards_tools_pos shape:
      // { top: <number>, left: <number>, collapsed: <bool> }.
      const top  = parseFloat(win.style.top  || "");
      const left = parseFloat(win.style.left || "");
      if (Number.isFinite(top) && Number.isFinite(left)) {
        window.rpSavePref?.("dashboards_tools_pos", {
          top, left,
          collapsed: win.classList.contains("is-collapsed"),
        });
      }
    };
    drag.addEventListener("pointerdown",   startDrag);
    drag.addEventListener("pointermove",   moveDrag);
    drag.addEventListener("pointerup",     endDrag);
    drag.addEventListener("pointercancel", endDrag);
  }

  // Collapse toggle — minimize the body, keep the header bar. Persist
  // the collapsed state alongside the position via rpSavePref.
  const collapseBtn = root.querySelector("[data-dashboards-tools-collapse]");
  if (collapseBtn && win && !collapseBtn.__rpBound) {
    collapseBtn.__rpBound = true;
    collapseBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      win.classList.toggle("is-collapsed");
      const top  = parseFloat(win.style.top  || "");
      const left = parseFloat(win.style.left || "");
      window.rpSavePref?.("dashboards_tools_pos", {
        top:  Number.isFinite(top)  ? top  : undefined,
        left: Number.isFinite(left) ? left : undefined,
        collapsed: win.classList.contains("is-collapsed"),
      });
    });
  }

  // Saved-chart widgets — bind charts from localStorage onto the canvas.
  initWidgets(root);
}

const SAVED_CHARTS_KEY = "rp_saved_charts_v1";

// Canvas slots for the (currently fixed) hero-pair template. `span`
// makes the hero tile fill both rows of its column.
const SLOTS = [
  { id: "hero",  span: 2 },
  { id: "kpi-1"          },
  { id: "kpi-2"          },
];

// Saved charts live in localStorage, written by the Reports page on
// Save. Read fresh on every call — the store is the source of truth.
function loadSavedCharts() {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_CHARTS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Wire the saved-chart flow: populate the two chart galleries (tools
// window + pick-chart modal), bind a picked chart to a canvas slot,
// and render bound charts from their self-contained ECharts option.
function initWidgets(root) {
  const grid        = root.querySelector("[data-dashboards-grid]");
  if (!grid) return;
  const libGallery  = root.querySelector("[data-dashboards-chart-gallery]");
  const libSearch   = root.querySelector("[data-dashboards-chart-search]");
  const slotsList   = root.querySelector("[data-dashboards-slots-list]");
  const titleInput  = root.querySelector("#dw-title");
  const pickModal   = root.querySelector("#rp-modal-pick-chart");
  const pickGallery = root.querySelector("[data-dashboards-pick-gallery]");
  const pickSearch  = pickModal?.querySelector('input[type="search"]');

  // slotId → { chart_id, title_override }. Lives for this page mount;
  // dashboard-level persistence to /api/dashboards is a later pass.
  const widgets    = {};
  let selectedSlot = SLOTS[0].id;
  let pickFilter   = "all";   // pick-chart modal kind pill

  const chartById = (id) => loadSavedCharts().find((c) => c.id === id);

  // ── Render: canvas ──────────────────────────────────────────────
  async function mountChart(host, chart, titleOverride) {
    // Primary path: the chart's self-contained ECharts option. chartById
    // re-parses localStorage every call, so `option` is a fresh object
    // — safe to set the title in place.
    if (chart.option) {
      let echarts;
      try { echarts = await loadECharts(); }
      catch (err) {
        host.innerHTML = `<p class="rp-dashboards__tile-msg">${esc(err.message ?? String(err))}</p>`;
        return;
      }
      const opt = chart.option;
      const t = titleOverride?.trim() || chart.title?.trim() || "";
      if (t) {
        if (Array.isArray(opt.title)) { if (opt.title[0]) opt.title[0].text = t; }
        else { opt.title = { ...(opt.title || {}), text: t }; }
      }
      const inst = echarts.init(host, "redpash", { renderer: "svg" });
      inst.setOption(opt);
      const ro = new ResizeObserver(() => inst.resize());
      ro.observe(host);
      host._rpDispose = () => { ro.disconnect(); inst.dispose(); };
      return;
    }
    // Fallback: an older saved chart with only an SVG snapshot.
    if (chart.svg) { host.innerHTML = chart.svg; return; }
    host.innerHTML = `<p class="rp-dashboards__tile-msg">No snapshot — re-save this chart on the Reports page.</p>`;
  }

  function renderCanvas() {
    grid.querySelectorAll("[data-chart-host]").forEach((h) => h._rpDispose?.());
    grid.innerHTML = SLOTS.map((slot) => {
      const span = slot.span ? ` style="grid-row: span ${slot.span}"` : "";
      const w = widgets[slot.id];
      if (!w) {
        return `<article class="rp-dashboards__tile rp-dashboards__tile--empty" data-slot="${esc(slot.id)}"${span}>
          <button type="button" class="rp-dashboards__tile-add" data-add-slot="${esc(slot.id)}">
            <i class="bi bi-plus-lg"></i>
            <span>Add a chart</span>
          </button>
        </article>`;
      }
      const chart = chartById(w.chart_id);
      const title = w.title_override?.trim() || chart?.title?.trim() || w.chart_id;
      return `<article class="rp-dashboards__tile" data-slot="${esc(slot.id)}"${span}>
        <header class="rp-dashboards__tile-hdr">
          <i class="bi bi-bar-chart-fill"></i>
          <span class="rp-dashboards__tile-ttl">${esc(title)}</span>
          <span class="rp-dashboards__tile-meta">${chart ? esc(chart.kind || "chart") : "missing chart"}</span>
          <button class="rp-btn rp-btn-xs" title="Configure slot" style="margin-left:auto" data-config-slot="${esc(slot.id)}">
            <i class="bi bi-sliders"></i>
          </button>
          <button class="rp-btn rp-btn-xs" title="Remove from dashboard" data-remove-slot="${esc(slot.id)}">
            <i class="bi bi-x"></i>
          </button>
        </header>
        <div class="rp-dashboards__tile-body">
          <div class="rp-dashboards__tile-canvas" data-chart-host></div>
        </div>
      </article>`;
    }).join("");

    SLOTS.forEach((slot) => {
      const w = widgets[slot.id];
      if (!w) return;
      const host  = grid.querySelector(`[data-slot="${slot.id}"] [data-chart-host]`);
      const chart = chartById(w.chart_id);
      if (!host) return;
      if (chart) mountChart(host, chart, w.title_override);
      else host.innerHTML = `<p class="rp-dashboards__tile-msg">Saved chart not found — it may have been deleted on the Reports page.</p>`;
    });
  }

  // ── Render: galleries ───────────────────────────────────────────
  function cardHtml(chart) {
    const bound = Object.values(widgets).some((w) => w.chart_id === chart.id);
    // chart.svg is ECharts' own SVG output — trusted, same as the
    // Reports-page download path.
    const thumb = chart.svg
      || `<svg viewBox="0 0 60 36" aria-hidden="true"><rect x="6" y="17" width="48" height="2" fill="currentColor" opacity="0.4"/></svg>`;
    return `<button type="button" class="rp-dashboards__chart-card${bound ? " is-bound" : ""}"
              data-chart-id="${esc(chart.id)}">
      <span class="rp-dashboards__chart-thumb">${thumb}</span>
      <span class="rp-dashboards__chart-card-ttl">${esc(chart.title || chart.id)}</span>
      <span class="rp-dashboards__chart-card-src">${esc(chart.kind || "chart")}</span>
    </button>`;
  }

  function renderGalleries() {
    const charts = loadSavedCharts();
    if (libGallery) {
      const q = (libSearch?.value || "").trim().toLowerCase();
      const list = charts.filter((c) => !q || (c.title || "").toLowerCase().includes(q));
      libGallery.innerHTML = list.length
        ? list.map(cardHtml).join("")
        : `<p class="rp-muted" style="grid-column:1/-1">${charts.length ? "No charts match." : "No saved charts yet."}</p>`;
    }
    if (pickGallery) {
      const q = (pickSearch?.value || "").trim().toLowerCase();
      const list = charts.filter((c) =>
        (pickFilter === "all" || (c.kind || "") === pickFilter)
        && (!q || (c.title || "").toLowerCase().includes(q)));
      pickGallery.innerHTML = list.length
        ? list.map(cardHtml).join("")
        : `<p class="rp-muted" style="grid-column:1/-1">${charts.length ? "No charts match this filter." : "No saved charts yet — create one on the Reports page."}</p>`;
    }
  }

  function renderSlotsList() {
    if (!slotsList) return;
    slotsList.innerHTML = SLOTS.map((slot) => {
      const w = widgets[slot.id];
      const chart = w ? chartById(w.chart_id) : null;
      const name = w ? (w.title_override?.trim() || chart?.title?.trim() || "Chart") : "Empty";
      const icon = w ? "bi-bar-chart-fill" : "bi-plus-square-dotted";
      return `<button class="rp-dashboards__slot${slot.id === selectedSlot ? " is-selected" : ""}" type="button" data-slot="${esc(slot.id)}">
        <span class="rp-dashboards__slot-key">${esc(slot.id)}</span>
        <span class="rp-dashboards__slot-name">${esc(name)}</span>
        <i class="bi ${icon}"></i>
      </button>`;
    }).join("");
  }

  function renderAll() {
    renderCanvas();
    renderGalleries();
    renderSlotsList();
  }

  // ── Mutations ───────────────────────────────────────────────────
  function bindChart(slotId, chartId) {
    widgets[slotId] = { ...(widgets[slotId] || {}), chart_id: chartId };
    renderAll();
  }
  function removeWidget(slotId) {
    delete widgets[slotId];
    renderAll();
  }
  function selectSlot(slotId) {
    selectedSlot = slotId;
    renderSlotsList();
    if (titleInput) titleInput.value = widgets[slotId]?.title_override || "";
  }
  // Where a pick-chart-modal selection lands: the selected slot if it's
  // free, else the first empty slot, else the selected slot (replace).
  function pickTarget() {
    if (!widgets[selectedSlot]) return selectedSlot;
    const free = SLOTS.find((s) => !widgets[s.id]);
    return free ? free.id : selectedSlot;
  }

  // ── Events ──────────────────────────────────────────────────────
  grid.addEventListener("click", (ev) => {
    const add = ev.target.closest("[data-add-slot]");
    if (add) {
      selectSlot(add.dataset.addSlot);
      window.openModal?.("pick-chart");
      return;
    }
    const rm = ev.target.closest("[data-remove-slot]");
    if (rm) { removeWidget(rm.dataset.removeSlot); return; }
    const cfg = ev.target.closest("[data-config-slot]");
    if (cfg) {
      selectSlot(cfg.dataset.configSlot);
      const w = document.getElementById("dashboards-tools-window");
      if (w && !w.classList.contains("open")) window.spToggle?.("dashboards-tools-window");
    }
  });

  libGallery?.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-chart-id]");
    if (card) bindChart(selectedSlot, card.dataset.chartId);
  });

  pickGallery?.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-chart-id]");
    if (!card) return;
    bindChart(pickTarget(), card.dataset.chartId);
    window.closeModal?.("pick-chart");
  });

  slotsList?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-slot]");
    if (btn) selectSlot(btn.dataset.slot);
  });

  libSearch?.addEventListener("input", renderGalleries);
  pickSearch?.addEventListener("input", renderGalleries);

  pickModal?.querySelectorAll("[data-filter]").forEach((pill) => {
    pill.addEventListener("click", () => {
      pickFilter = pill.dataset.filter;
      pickModal.querySelectorAll("[data-filter]").forEach((p) => p.classList.toggle("active", p === pill));
      renderGalleries();
    });
  });

  // Title override applies on commit (blur / Enter) — re-mounting the
  // ECharts instance on every keystroke would be janky.
  titleInput?.addEventListener("change", () => {
    const w = widgets[selectedSlot];
    if (!w) return;
    w.title_override = titleInput.value.trim();
    renderCanvas();
  });

  selectSlot(SLOTS[0].id);
  renderAll();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
