/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/prefs/controls/chart-layouts.md */
// Settings v2 control renderer — "chart-layouts".
//
// Per-tab chart layouts for Monitoring + Home (the Slice D / D2
// pickers). Step 4 of CAS_55984AC7 moves the picker code OUT of
// pages/settings.js (where it lived inline) and INTO this control
// module. settings.js's CONTROLS dispatcher now treats it like any
// other registered control:
//
//   render(spec)           — returns the mount-slot HTML string,
//                            stamped into the section like prefRow /
//                            mountRow do.
//   postMount(app, spec)   — paints the picker into the slot after
//                            the DOM lands. Mirrors the pre-step-4
//                            mountChartPickerPanel call.
//
// Per-surface configs (rootId, schema, defaults, newTemplate,
// labels) live here, keyed by `spec.surface` ("home" |
// "monitoring"). Adding a third surface = registering a third spec
// + adding a SURFACE_CFG entry; settings.js never changes.
//
// The picker behavior is unchanged from the inline version: tab row
// + chart list (defaults vs customised) + Add / Reset buttons + the
// add-chart modal (preview + builder, save/cancel/Esc).

import { esc } from "/scripts/dom.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { mountRow } from "/scripts/page-row.js";
import { mountBuilder } from "/scripts/charts/builder-ui.js";
import { renderChart } from "/scripts/charts/render.js";
import {
  MON_STATS_SCHEMA, MON_DEFAULT_CHARTS,
  newChartTemplate as newMonitoringChart,
} from "/scripts/charts/monitoring-bank.js";
import {
  HOME_STATS_SCHEMA, HOME_DEFAULT_CHARTS,
  newChartTemplate as newHomeChart,
} from "/scripts/charts/home-bank.js";

// ── per-surface configs ─────────────────────────────────────────────
// Each entry names where its slot lives (rootId — the mountRow id +
// querySelector hook), which tabs participate (schema), what the
// defaults look like, what a fresh starter spec looks like, and
// what human labels to show. The pref-key it persists into is
// taken from the registered spec (spec.key), not duplicated here.
const SURFACE_CFG = {
  monitoring: {
    rootId:      "rp-settings-mon-charts",
    schema:      MON_STATS_SCHEMA,
    defaults:    MON_DEFAULT_CHARTS,
    newTemplate: newMonitoringChart,
    labels:      { requests: "Requests", events: "Events", runs: "Runs",
                   findings: "Findings", steps:  "Steps" },
    surfaceLabel: "Monitoring",
  },
  home: {
    rootId:      "rp-settings-home-charts",
    schema:      HOME_STATS_SCHEMA,
    defaults:    HOME_DEFAULT_CHARTS,
    newTemplate: newHomeChart,
    // Only tabs with directly-addressable stats fields participate
    // in Slice D2; companies/cases/projects/charts use gauge ratios
    // or client-derived aggregates, deferred to a `transform` source.
    labels:      { users: "Users", memberships: "Memberships", files: "Files" },
    surfaceLabel: "Home",
  },
};

function cfgFor(spec) { return SURFACE_CFG[spec.surface]; }

/** Render the row slot. Receives the registered spec; returns HTML
 *  shaped like a mountRow so it sits cleanly among the other
 *  Settings rows. The picker paints into the slot in postMount. */
export function render(spec) {
  const cfg = cfgFor(spec);
  if (!cfg) return "";
  return mountRow({
    label: spec.label || "Per-tab chart layouts",
    hint:  spec.hint  || ("your saved charts replace the curated defaults on each "
                          + (cfg.surfaceLabel || "") + " tab. Build via the chart designer."),
    id:    cfg.rootId,
    containerClass: "rp-settings__mon-charts",
  });
}

/** Paint the picker into its slot. Called by settings.js after the
 *  registry-driven renderFromRegistry lays down the rows. The
 *  picker reads + writes the pref via spec.key, so the same code
 *  drives monitoringCharts + homeCharts (+ any future surface
 *  whose spec carries `control: "chart-layouts"`). */
export function postMount(app, spec) {
  const cfg = cfgFor(spec);
  if (!cfg) return;
  const root = app.querySelector("#" + cfg.rootId);
  if (!root) return;
  const tabKeys = Object.keys(cfg.schema);
  if (!tabKeys.length) return;

  let activeTab = tabKeys[0];

  function readPref() {
    const v = getPref(spec.key);
    return (v && typeof v === "object") ? v : {};
  }
  function writePref(next) { setPref(spec.key, next); }
  function chartsForActive() {
    const pref = readPref();
    const saved = pref[activeTab];
    return Array.isArray(saved) ? saved : (cfg.defaults[activeTab] || []);
  }
  function isCustomised() { return Array.isArray(readPref()[activeTab]); }

  function rerender() {
    const tabs = tabKeys.map((k) =>
      '<button type="button" class="rp-settings__mon-tab' + (k === activeTab ? " is-active" : "") + '"'
      + ' data-tab="' + esc(k) + '">' + esc(cfg.labels[k] || k) + '</button>').join("");
    const list = chartsForActive();
    const customised = isCustomised();
    const items = list.length
      ? list.map((c, i) =>
          '<li class="rp-settings__mon-chart" data-idx="' + i + '">'
          + '<span class="rp-settings__mon-chart-title">' + esc(c.title || "Untitled chart") + '</span>'
          + '<span class="rp-settings__mon-chart-meta">'
          +   esc(c.cfg?.type || c.cfg?.kind || "?") + " · "
          +   esc(c.source?.pointer || "(no field)")
          + '</span>'
          + (customised
              ? '<button class="rt-btn rp-settings__mon-chart-x" type="button" data-idx="' + i + '" title="Remove">×</button>'
              : '<span class="rp-settings__mon-chart-default" title="Default chart — customise to remove">default</span>')
          + '</li>').join("")
      : '<li class="rp-settings__mon-empty">No charts. Add one or reset to defaults.</li>';
    root.innerHTML = ''
      + '<div class="rp-settings__mon-tabs">' + tabs + '</div>'
      + '<ul class="rp-settings__mon-charts-list">' + items + '</ul>'
      + '<div class="rp-settings__mon-actions">'
      +   '<button class="rt-btn rp-settings__mon-add" type="button"><i class="bi bi-plus-circle"></i> Add chart</button>'
      +   (customised
            ? '<button class="rt-btn rp-settings__mon-reset" type="button"><i class="bi bi-arrow-counterclockwise"></i> Reset to defaults</button>'
            : '')
      + '</div>';
  }

  root.addEventListener("click", (e) => {
    const tab = e.target.closest(".rp-settings__mon-tab");
    if (tab) { activeTab = tab.dataset.tab; rerender(); return; }
    const rm = e.target.closest(".rp-settings__mon-chart-x");
    if (rm) {
      const idx = parseInt(rm.dataset.idx, 10);
      const pref = readPref();
      const list = (pref[activeTab] || []).slice();
      list.splice(idx, 1);
      pref[activeTab] = list;
      writePref(pref);
      rerender();
      return;
    }
    if (e.target.closest(".rp-settings__mon-reset")) {
      const pref = readPref();
      delete pref[activeTab];
      writePref(pref);
      rerender();
      return;
    }
    if (e.target.closest(".rp-settings__mon-add")) {
      openAddChartModal(activeTab, cfg, (newSpec) => {
        const pref = readPref();
        // First "Add" on a tab promotes the defaults to a user list
        // so the user starts from "the defaults plus mine," not
        // "blank + mine" — surfacing the +1 instead of replacing.
        const base = Array.isArray(pref[activeTab])
          ? pref[activeTab]
          : (cfg.defaults[activeTab] || []).map(cloneSpec);
        pref[activeTab] = [...base, newSpec];
        writePref(pref);
        rerender();
      });
      return;
    }
  });

  rerender();
}

// Deep clone a chart spec (defaults → user list seed). JSON
// round-trip is fine — specs are pure JSON-encodable data.
function cloneSpec(s) { return JSON.parse(JSON.stringify(s)); }

// ── Add-chart modal ───────────────────────────────────────────────
// Inline overlay with two columns: live preview (left) + mountBuilder
// accordion (right). The builder owns the cfg; every onCfgChange
// reruns the preview's renderChart. "Add" persists via the caller's
// onAdd(spec) callback; cancel dismisses. Same shape as the
// pre-step-4 openAddChartModal in settings.js — moved verbatim.
function openAddChartModal(tabKey, cfg, onAdd) {
  const schema = cfg.schema[tabKey];
  if (!schema) return;

  // The starter spec drives both the preview and the builder. We
  // pass the SAME object — builder mutates in place, preview reads
  // the same reference.
  const spec = cfg.newTemplate(tabKey);
  if (!spec) return;
  const tabLabel = cfg.labels[tabKey] || tabKey;
  spec.title = spec.cfg.title = "New " + tabLabel + " chart";
  const surfaceLabel = cfg.surfaceLabel || "Monitoring";

  // Modal shell — reuse the rp-mon-modal pattern (overlay backdrop +
  // centered card) but namespaced rp-settings-chart-modal so the
  // cross-page audit doesn't see a leak from monitoring.
  let modal = document.getElementById("rp-settings-chart-modal");
  if (modal) modal.remove();
  modal = document.createElement("div");
  modal.id = "rp-settings-chart-modal";
  modal.className = "rp-settings-chart-modal";
  modal.innerHTML = ''
    + '<div class="rp-settings-chart-modal-backdrop"></div>'
    + '<div class="rp-settings-chart-modal-body">'
    +   '<header class="rp-settings-chart-modal-head">'
    +     '<h3>Add chart to <em>' + esc(tabLabel) + '</em></h3>'
    +     '<button type="button" class="rt-btn rp-settings-chart-modal-close" aria-label="Close">×</button>'
    +   '</header>'
    +   '<div class="rp-settings-chart-modal-grid">'
    +     '<div class="rp-settings-chart-modal-preview" id="rp-settings-chart-preview"></div>'
    +     '<aside class="ds-config rp-settings-chart-modal-builder" id="rp-settings-chart-builder"></aside>'
    +   '</div>'
    +   '<footer class="rp-settings-chart-modal-foot">'
    +     '<button type="button" class="rt-btn rp-settings-chart-modal-cancel">Cancel</button>'
    +     '<button type="button" class="rt-btn rt-btn--accent rp-settings-chart-modal-add">Add to ' + esc(surfaceLabel) + '</button>'
    +   '</footer>'
    + '</div>';
  document.body.appendChild(modal);
  const previewEl = modal.querySelector("#rp-settings-chart-preview");
  const builderEl = modal.querySelector("#rp-settings-chart-builder");

  // Live preview — re-render on every cfg change. renderChart disposes
  // any instance already on the slot before init. repaintPreview is async
  // (monitoring-stats sources fetch), so rapid cfg changes can overlap; a
  // generation token discards a stale render whose await resolved after a
  // newer one started, so it can't linger as the live previewInst.
  let previewInst = null;
  let repaintGen = 0;
  async function repaintPreview() {
    const gen = ++repaintGen;
    try { previewInst?.dispose(); } catch { /* gone */ }
    previewInst = null;
    try {
      const inst = await renderChart(previewEl, spec, spec.cfg.theme);
      if (gen !== repaintGen) { try { inst?.dispose(); } catch { /* gone */ } return; }
      previewInst = inst;
    } catch (err) {
      console.warn("[settings] chart preview failed:", err);
    }
  }

  // Mount the shared chart-spec builder against this tab's
  // monitoring-stats source (schema fields drive the field-picker
  // select; supportsWindow toggles the window chip row).
  const schemaPaths = (schema.fields || []).map((f) => f.path);
  const builder = mountBuilder(builderEl, {
    getCfg: () => spec.cfg,
    getSource: () => ({
      kind:     "monitoring-stats",
      endpoint: schema.endpoint,
      pointer:  spec.source.pointer,
      window:   spec.source.window,
      schema:   schemaPaths,
    }),
    onCfgChange: () => {
      // The builder's window-chip handler writes onto cfg.source —
      // mirror it back into our spec.source so the preview + saved
      // spec share one shape.
      if (spec.cfg.source) {
        spec.source = { ...spec.source, ...spec.cfg.source };
        delete spec.cfg.source;
      }
      spec.title = spec.cfg.title;
      void repaintPreview();
    },
    onSave: () => { /* the modal's Add button handles save */ },
  });
  builder.render();
  builder.setDirty(true);
  void repaintPreview();

  function close() {
    try { previewInst?.dispose(); } catch { /* gone */ }
    builder.destroy();
    modal.remove();
  }
  modal.querySelector(".rp-settings-chart-modal-backdrop").addEventListener("click", close);
  modal.querySelector(".rp-settings-chart-modal-close").addEventListener("click", close);
  modal.querySelector(".rp-settings-chart-modal-cancel").addEventListener("click", close);
  modal.querySelector(".rp-settings-chart-modal-add").addEventListener("click", () => {
    onAdd(cloneSpec(spec));
    close();
  });

  // ESC dismisses too — same affordance as the monitoring request-replay modal.
  function onKey(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  }
  document.addEventListener("keydown", onKey);
}
