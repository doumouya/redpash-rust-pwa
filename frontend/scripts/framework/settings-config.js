/* Purpose: Settings configure-by-example — each preference beside a LIVE instance of the component it controls.
   Doc: docs/internal/code/frontend/scripts/framework/settings-config.md */
// ── Settings configure-by-example (framework page-component, CAS_37B2E1BF) ────
// Em's Settings reframe: Settings is preferences on elements already in the UI,
// so pair each pref's control with a LIVE preview of the exact component it
// controls — change the control, watch the real thing change. The control is a
// form-control (seg/select); the preview is a reused framework component
// (themed surface / chart / simple-table / redtable). One config-row layout
// (settings-config.css) pairs them; the control's onChange drives the preview.
//
// Render-first proof of the PATTERN with representative prefs; the live cutover
// folds the full pref registry (prefs.js) + persistence into this shape (the
// onChange writes the pref). account-identity prefs move to the Profile record.
// SECURITY: labels/hints esc()'d; chart `option` is passed to setOption (never HTML).
"use strict";

import { register, get } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";

const SAMPLE_ROWS = [
  { name: "Aïcha Diallo", role: "owner" }, { name: "Sam Okoro", role: "admin" },
  { name: "Lena Park", role: "member" },   { name: "Tom Vega", role: "member" },
  { name: "Mara Linde", role: "member" },   { name: "Joon Kim", role: "viewer" },
  { name: "Ivy Chen", role: "member" },     { name: "Otis Bray", role: "viewer" },
];

// ECharts option per chart kind (the chart preview morphs on the seg).
function chartOption(kind) {
  const cats = ["Jan", "Feb", "Mar", "Apr", "May"];
  const vals = [120, 200, 150, 80, 170];
  if (kind === "pie") return { series: [{ type: "pie", radius: "70%", data: cats.map((c, i) => ({ name: c, value: vals[i] })) }] };
  return { grid: { left: 32, right: 12, top: 12, bottom: 24 }, xAxis: { type: "category", data: cats }, yAxis: { type: "value" }, series: [{ type: kind, data: vals }] };
}

// One configure-by-example row: [label + hint + control] | [preview].
function configRow(host, label, hint, previewLabel) {
  const row = document.createElement("div");
  row.className = "rp-settings-config-row";
  row.innerHTML =
      '<div class="rp-settings-config-control">'
    +   '<span class="rp-settings-config-label">' + esc(label) + '</span>'
    +   (hint ? '<span class="rp-settings-config-hint">' + esc(hint) + '</span>' : '')
    +   '<div data-slot="control"></div>'
    + '</div>'
    + '<div class="rp-settings-config-preview">'
    +   '<div class="rp-settings-config-preview-label">' + esc(previewLabel || "Live preview") + '</div>'
    +   '<div data-slot="preview"></div>'
    + '</div>';
  host.appendChild(row);
  return { row, control: row.querySelector('[data-slot="control"]'), preview: row.querySelector('[data-slot="preview"]') };
}

export function mountSettingsConfig(host, opts = {}) {
  if (!host) return null;
  host.className = "rp-settings-config";
  host.innerHTML = "";
  const seg = get("seg"), select = get("select"), chart = get("chart"), table = get("table"), redtable = get("redtable");

  // 1 · Theme → a sample card re-themes live
  {
    const r = configRow(host, "Theme", "Token theme applied app-wide.", "This card re-themes");
    r.preview.innerHTML = '<div class="rp-surface" data-theme="dark" style="padding:.75rem;display:flex;gap:.5rem;align-items:center">'
      + '<button class="rp-btn">Save</button><span class="rp-chip is-active">Active</span><span class="rp-badge rp-badge--accent">Pro</span></div>';
    const card = r.preview.querySelector(".rp-surface");
    if (seg) seg(r.control, { options: [{ value: "dark", label: "Dark", icon: "bi-moon-stars" }, { value: "light", label: "Light", icon: "bi-sun" }], value: "dark",
      onChange: (v) => card.setAttribute("data-theme", v) });
  }

  // 2 · Default chart kind → a real chart morphs
  {
    const r = configRow(host, "Default chart kind", "New charts open as this type.", "A real chart");
    const slot = document.createElement("div"); slot.style.height = "9rem"; r.preview.appendChild(slot);
    const ch = chart ? chart(slot, { option: chartOption("bar") }) : null;
    if (seg) seg(r.control, { options: [{ value: "bar", label: "Bar" }, { value: "line", label: "Line" }, { value: "pie", label: "Pie" }], value: "bar",
      onChange: (v) => { if (ch && ch.setOption) ch.setOption(chartOption(v)); } });
  }

  // 3 · Rows per page → a mini table grows/shrinks
  {
    const r = configRow(host, "Rows per page", "RedTable pager size.", "Table preview");
    const render = (n) => { if (table) table(r.preview, { columns: [{ key: "name", label: "Name" }, { key: "role", label: "Role", kind: "status" }], rows: SAMPLE_ROWS.slice(0, n), empty: "—" }); };
    render(5);
    if (select) select(r.control, { options: [{ value: "3", label: "3" }, { value: "5", label: "5" }, { value: "8", label: "8" }], value: "5",
      onChange: (v) => render(Number(v)) });
  }

  // 4 · Row numbers → the redtable toggles its rownum column
  {
    const r = configRow(host, "Show row numbers", "Adds a leading # column to data tables.", "RedTable preview");
    const render = (on) => { if (redtable) redtable(r.preview, { columns: [{ key: "name", label: "Name" }, { key: "role", label: "Role", kind: "status" }], rows: SAMPLE_ROWS.slice(0, 4), rowKey: (x) => x.name, rownum: on }); };
    render(true);
    if (seg) seg(r.control, { options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }], value: "on",
      onChange: (v) => render(v === "on") });
  }

  return { el: host };
}

register("settings-config", mountSettingsConfig);
