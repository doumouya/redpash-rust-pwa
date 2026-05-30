// Settings page — app preferences.
//
// Page is declarative: SETTINGS_ROWS defines what each section
// contains; render() materialises them via page-row.js helpers
// (prefRow / valueRow / actionsRow / mountRow). The shape audit
// (html-audit 2026-05-25) flagged `rp-page__row` as the heaviest
// duplication signal on the page; centralising the structure
// here keeps the page__row contract in one place.
//
// One delegated click handler drives every option group: each
// wrapper carries data-pref, each button carries data-value. Click
// → resolve pref → call the right setter (theme.js for theme,
// prefs.js setPref for everything else) → repaint is-active.
// Most pref values are strings, validated against PREFS[name].values.
// `share_sentinels` is a boolean and gets coerced from its
// "true"/"false" data-value before write.
//
// Sentinels list is read from /api/me's prefs.learned_sentinels —
// each entry renders as a chip with an × that splices the array
// and writes back via setPref. Additions land via the Cleaner's
// Fix-invalid modal, not from here.

import { mountTopbar } from "/scripts/topbar.js";
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse } from "/scripts/rail-controls.js";
import { api } from "/scripts/api.js";
import { applyTheme, currentTheme } from "/scripts/theme.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { esc } from "/scripts/dom.js";
import { prefRow, valueRow, actionsRow, mountRow } from "/scripts/page-row.js";
// Slice D — Monitoring chart picker. Mounts the shared mountBuilder
// (from Slice C) against a `monitoring-stats` source so the user can
// build per-tab chart layouts on the Settings page. Persisted to
// `user_preferences.prefs.monitoringCharts.<tab>`; consumed by
// pages/monitoring.js via the same pref name.
import { mountBuilder } from "/scripts/charts/builder-ui.js";
import { renderChart } from "/scripts/charts/render.js";
import {
  MON_STATS_SCHEMA, MON_DEFAULT_CHARTS,
  newChartTemplate as newMonitoringChart,
} from "/scripts/charts/monitoring-bank.js";
// Slice D2 — Home tabs join the picker. Same registry shape +
// monitoring-stats source kind (the resolver is endpoint-agnostic).
import {
  HOME_STATS_SCHEMA, HOME_DEFAULT_CHARTS,
  newChartTemplate as newHomeChart,
} from "/scripts/charts/home-bank.js";

// Server-side pref keys read on mount. Distinct from PREFS in prefs.js:
// these come from /me, not the local registered enum.
const SERVER_PREF_KEYS = ["share_sentinels", "learned_sentinels"];

// Reusable option-button sets.
const ROWS_PER_PAGE = [
  { value: "10",   label: "10"  },
  { value: "25",   label: "25"  },
  { value: "50",   label: "50"  },
  { value: "100",  label: "100" },
  { value: "250",  label: "250" },
  { value: "500",  label: "500" },
  { value: "1000", label: "1k"  },
];
const ON_OFF = [
  { value: "1", label: "On"  },
  { value: "0", label: "Off" },
];

// Section → row specs. Order matches the rendered page.
const SETTINGS_ROWS = {
  appearance: [
    prefRow({ label: "Theme", pref: "theme", options: [
      { value: "dark",  label: "Dark",  icon: "moon-stars" },
      { value: "light", label: "Light", icon: "sun" },
    ]}),
    prefRow({ label: "Density", pref: "density", options: [
      { value: "compact",     label: "Compact" },
      { value: "cozy",        label: "Cozy" },
      { value: "comfortable", label: "Comfortable" },
    ]}),
    prefRow({ label: "Font size", pref: "fontSize", options: [
      { value: "sm", label: "Small" },
      { value: "md", label: "Medium" },
      { value: "lg", label: "Large" },
    ]}),
  ],
  // Rows-per-page is split per surface so the Workspace's tight
  // editing size doesn't pollute the wider Home/Monitoring browse
  // sizes (or vice versa).
  tables: [
    prefRow({ label: "Rows per page · Workspace",  pref: "rowsPerPageWorkspace",  options: ROWS_PER_PAGE }),
    prefRow({ label: "Rows per page · Home",       pref: "rowsPerPageHome",       options: ROWS_PER_PAGE }),
    prefRow({ label: "Rows per page · Monitoring", pref: "rowsPerPageMonitoring", options: ROWS_PER_PAGE }),
  ],
  workspace: [
    prefRow({ label: "Show row numbers",   pref: "showRowNumbers", options: ON_OFF }),
    prefRow({ label: "Stage dots in rail", pref: "showStageDots",  options: ON_OFF }),
  ],
  data: [
    prefRow({ label: "CSV delimiter", hint: "applied when opening files", pref: "csvDelimiter", options: [
      { value: "auto", label: "Auto" },
      { value: "comma", label: ",", title: "Comma" },
      { value: "semi",  label: ";", title: "Semicolon" },
      { value: "tab",   label: "↹", title: "Tab" },
    ]}),
    prefRow({ label: "Default encoding", hint: "fallback when RedPash can't detect", pref: "csvEncoding", options: [
      { value: "auto",         label: "Auto",       title: "Auto-detect (chardetng)" },
      { value: "utf-8",        label: "UTF-8" },
      { value: "utf-16le",     label: "UTF-16 LE" },
      { value: "utf-16be",     label: "UTF-16 BE" },
      { value: "windows-1252", label: "Win-1252" },
      { value: "iso-8859-1",   label: "Latin-1" },
      { value: "iso-8859-15",  label: "Latin-9" },
      { value: "windows-1250", label: "Win-1250" },
      { value: "macintosh",    label: "MacRoman" },
    ]}),
    prefRow({ label: "Export format", hint: "default for downloading cleaned data", pref: "exportFormat", options: [
      { value: "csv",  label: "CSV",   icon: "filetype-csv"  },
      { value: "xlsx", label: "Excel", icon: "filetype-xlsx" },
      { value: "json", label: "JSON",  icon: "filetype-json" },
    ]}),
  ],
  cleaner: [
    mountRow({
      label: "Personal sentinel values",
      hint: "junk placeholders you've flagged in Fix invalid values. Add via the Cleaner; remove here.",
      id: "rp-settings-sentinels",
      containerClass: "rp-settings__sentinels",
      emptyClass: "rp-settings__sentinels-empty",
    }),
    prefRow({
      label: "Share with all users",
      hint: "your sentinels join the global vocabulary after 2+ users flag the same value. Only the placeholder string is shared.",
      pref: "share_sentinels",
      options: [
        { value: "true",  label: "On"  },
        { value: "false", label: "Off" },
      ],
    }),
  ],
  // Slice D — Monitoring chart picker. The panel body is rendered
  // by JS (mountChartPickerPanel below); mountRow just stamps the
  // slot the panel paints into.
  monitoringCharts: [
    mountRow({
      label: "Per-tab chart layouts",
      hint:  "your saved charts replace the curated defaults on each Monitoring tab. Build via the chart designer.",
      id:    "rp-settings-mon-charts",
      containerClass: "rp-settings__mon-charts",
    }),
  ],
  // Slice D2 — Home chart picker. Same panel implementation; only the
  // tabs / schema / defaults registry differs (the picker is
  // surface-parameterised in mountChartPickerPanel below).
  homeCharts: [
    mountRow({
      label: "Per-tab chart layouts",
      hint:  "your saved charts replace the curated defaults on each Home tab. Build via the chart designer.",
      id:    "rp-settings-home-charts",
      containerClass: "rp-settings__mon-charts",
    }),
  ],
  account: [
    valueRow({ label: "Display name", id: "rp-settings-display" }),
    valueRow({ label: "Username",     id: "rp-settings-username" }),
    actionsRow({ label: "Sign out", actions: [
      { kind: "button", id: "rp-settings-signout", label: "Sign out", icon: "box-arrow-right" },
    ]}),
  ],
  // About row is structurally unique (branded label + version mount);
  // inlined here rather than parameterised — no second site exists.
  about: [
    '<div class="rp-page__row">'
      + '<span class="rp-page__row-label">'
        + '<span class="rp-settings__about-brand">RedPash</span> '
        + '<small class="rp-settings__hint" id="rp-settings-version">prerelease build</small>'
      + '</span>'
      + '<div class="rp-page__row-control">'
        + '<a class="rt-btn" href="#/docs">Docs</a>'
        + '<a class="rt-btn" href="#/docs?slug=vision">Vision</a>'
        + '<a class="rt-btn" href="#/docs?slug=getting-started">Getting started</a>'
      + '</div>'
    + '</div>',
  ],
};

function render(app) {
  for (const [section, rows] of Object.entries(SETTINGS_ROWS)) {
    const mount = app.querySelector('[data-rp-rows="' + section + '"]');
    if (mount) mount.innerHTML = rows.join("");
  }
}

// Rail data — section index, grouped to match the canonical
// home / monitoring rail (rt-group with two-letter color marks +
// rt-tab children). Tab-switch UX (Em 2026-05-28): each rt-tab
// click shows ONE section + hides the others — same affordance
// as Home / Monitoring / Workspace, so a tab opens at its head
// with the full surface available for that section's content.
// URL hash `#/settings?tab=<key>` drives the initial active tab
// so a refresh / deep-link lands the user back where they were.
const SET_GROUPS = [
  { name: "UI",      mark: "UI", color: "blue"  },
  { name: "DATA",    mark: "DA", color: "teal"  },
  { name: "CHARTS",  mark: "CH", color: "peach" },
  { name: "ACCOUNT", mark: "AC", color: "mauve" },
];
const SET_TABS = [
  { group: "UI",      key: "set-appearance",        label: "Appearance",        icon: "bi-palette"         },
  { group: "UI",      key: "set-tables",            label: "Tables",            icon: "bi-table"           },
  { group: "UI",      key: "set-workspace",         label: "Workspace",         icon: "bi-grid-3x3"        },
  { group: "DATA",    key: "set-data",              label: "Data & Export",     icon: "bi-database"        },
  { group: "DATA",    key: "set-cleaner",           label: "Cleaner",           icon: "bi-tools"           },
  { group: "CHARTS",  key: "set-monitoring-charts", label: "Monitoring charts", icon: "bi-bar-chart-line"  },
  { group: "CHARTS",  key: "set-home-charts",       label: "Home charts",       icon: "bi-bar-chart-fill"  },
  { group: "ACCOUNT", key: "set-account",           label: "Account",           icon: "bi-person-circle"   },
  { group: "ACCOUNT", key: "set-about",             label: "About",             icon: "bi-info-circle"     },
];

// Standard rail population — mirrors monitoring.js / home.js
// renderGroup + renderTab. Tab-switch UX (Em 2026-05-28: "switching
// the tabs just switch the content, and we have full screen
// availability for each tabs"): each rt-tab click shows ONE section
// + hides the others, URL hash sticks the choice. No scroll-spy /
// IntersectionObserver — only the active section is visible at a
// time, scrolling-stack is gone.
function mountSettingsRail(app) {
  const nav     = app.querySelector("#rpSetNav");
  const body    = app.querySelector("#rpSetNavBody");
  const surface = app.querySelector("#rpSetView");
  if (!nav || !body || !surface) return;

  // ── render grouped rail ────────────────────────────────────
  body.innerHTML = SET_GROUPS.map((g) => {
    const tabs = SET_TABS.filter((t) => t.group === g.name);
    if (!tabs.length) return "";
    const items = tabs.map((t) =>
      '<button type="button" class="rt-tab" data-key="' + esc(t.key) + '">'
      +   '<i class="' + esc(t.icon) + ' rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(t.label) + '</span>'
      + '</button>').join("");
    return ''
      + '<div class="rt-group expanded">'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + esc(g.color) + '">' + esc(g.mark) + '</span>'
      +     '<span class="rt-group-name">' + esc(g.name) + '</span>'
      +     '<span class="rt-group-count">' + tabs.length + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body">' + items + '</div>'
      + '</div>';
  }).join("");

  const items     = Array.from(body.querySelectorAll(".rt-tab"));
  const sections  = Array.from(surface.querySelectorAll(".rp-page__section"));
  const validKeys = new Set(SET_TABS.map((t) => t.key));

  // ── collapse button + group-head toggle ───────────────────
  mountRailCollapse(nav, app.querySelector("#rpSetNavCollapse"));
  body.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) { head.parentElement.classList.toggle("expanded"); return; }
    const tab = e.target.closest(".rt-tab");
    if (!tab) return;
    const key = tab.dataset.key;
    activate(key);
    // Persist the choice in the URL hash so refresh / share lands
    // back on the same tab. Same `#/settings?tab=<key>` shape that
    // Monitoring + Home use for their per-tab deep links.
    const url = new URL(location.href);
    url.hash = "/settings?tab=" + encodeURIComponent(key);
    history.replaceState(null, "", url);
  });

  // ── activate: rail + section visibility + scroll reset ────
  function activate(key) {
    items.forEach((el) => el.classList.toggle("active", el.dataset.key === key));
    // [hidden] toggles per-section; the chosen one fills the surface.
    // The scroll position resets to the top — same affordance as
    // Home/Monitoring (a fresh tab opens at its head, not wherever
    // the prior tab was scrolled to).
    sections.forEach((sec) => { sec.hidden = sec.id !== key; });
    surface.scrollTop = 0;
  }

  // Initial active = ?tab=<key> from the hash, falling back to the
  // first registered tab if the param is missing / unknown.
  const params  = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantTab = params.get("tab");
  const initial = (wantTab && validKeys.has(wantTab)) ? wantTab : SET_TABS[0].key;
  activate(initial);
}

export default async function settings(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "settings", session });
  mountRailFooterNav(app.querySelector(".rt-nav-foot"), { active: "settings", session });
  render(app);
  mountSettingsRail(app);

  // ─── account section — read-only from session ────────────────
  const name = (session?.display_name || "—").trim();
  const user = (session?.username     || "—").trim();
  const displayEl  = app.querySelector("#rp-settings-display");
  const usernameEl = app.querySelector("#rp-settings-username");
  if (displayEl)  displayEl.textContent  = name;
  if (usernameEl) usernameEl.textContent = user.startsWith("@") || user === "—" ? user : "@" + user;

  app.querySelector("#rp-settings-signout")?.addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });

  // ─── fetch /me for server-side prefs (sentinels + share toggle) ─
  let me = null;
  try { me = await api.get("/me"); } catch { /* fall through — empty prefs */ }
  const serverPrefs = me?.prefs || {};

  // ─── prefs: read current value, paint is-active per group ────
  function readCurrent(prefName) {
    if (prefName === "theme") return currentTheme();
    if (SERVER_PREF_KEYS.includes(prefName)) {
      const v = serverPrefs[prefName];
      if (typeof v === "boolean") return v ? "true" : "false";
      return v == null ? null : String(v);
    }
    return getPref(prefName);
  }
  function paint(group) {
    const prefName = group.dataset.pref;
    const cur = readCurrent(prefName);
    group.querySelectorAll("[data-value]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === cur);
    });
  }
  app.querySelectorAll("[data-pref]").forEach(paint);

  // ─── click delegation: setPref → paint ───────────────────────
  app.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    const group = btn.closest("[data-pref]");
    if (!group) return;
    const prefName = group.dataset.pref;
    const value    = btn.dataset.value;
    if (prefName === "theme") {
      applyTheme(value);
    } else if (prefName === "share_sentinels") {
      // The PATCH /me/prefs gate keys off as_bool(), so write an
      // actual boolean, not the "true"/"false" data-value string.
      const bool = value === "true";
      setPref("share_sentinels", bool);
      serverPrefs.share_sentinels = bool;
    } else {
      setPref(prefName, value);
    }
    paint(group);
  });

  // ─── sentinels list: render + remove handler ─────────────────
  renderSentinels(app, serverPrefs);
  app.querySelector("#rp-settings-sentinels")?.addEventListener("click", (e) => {
    const x = e.target.closest(".rp-settings__sentinel-x");
    if (!x) return;
    const value = x.dataset.value;
    const next  = (serverPrefs.learned_sentinels || []).filter((v) => v !== value);
    serverPrefs.learned_sentinels = next;
    setPref("learned_sentinels", next);
    renderSentinels(app, serverPrefs);
  });

  // ─── Slice D / D2 — chart pickers ──────────────────────────
  // Same picker implementation drives Monitoring + Home; only the
  // schema / defaults / pref name / labels differ. Adding a third
  // surface = registering another config entry.
  CHART_PICKERS.forEach((cfg) => mountChartPickerPanel(app, cfg));
}

// ── chart-picker panel (Slice D / D2) ──────────────────────────────
// Surface-parameterised: same implementation paints Monitoring and
// Home picker sections. Each config entry names where its slot lives
// (rootId), what pref key persists its layouts (prefName), which
// tabs participate (schema), what the defaults look like (defaults),
// what an empty starter spec looks like (newTemplate), and what
// human labels to show (labels — fallback is the tab key).
const CHART_PICKERS = [
  {
    surface:    "monitoring",
    rootId:     "rp-settings-mon-charts",
    prefName:   "monitoringCharts",
    schema:     MON_STATS_SCHEMA,
    defaults:   MON_DEFAULT_CHARTS,
    newTemplate: newMonitoringChart,
    labels:     { requests: "Requests", events: "Events", runs: "Runs",
                  findings: "Findings", steps:  "Steps" },
  },
  {
    surface:    "home",
    rootId:     "rp-settings-home-charts",
    prefName:   "homeCharts",
    schema:     HOME_STATS_SCHEMA,
    defaults:   HOME_DEFAULT_CHARTS,
    newTemplate: newHomeChart,
    // Only tabs with directly-addressable stats fields participate in
    // Slice D2; companies/cases/projects/charts use gauge ratios or
    // client-derived aggregates, deferred to a `transform` source kind.
    labels:     { users: "Users", memberships: "Memberships", files: "Files" },
  },
];

function mountChartPickerPanel(app, cfg) {
  const root = app.querySelector("#" + cfg.rootId);
  if (!root) return;
  const tabKeys = Object.keys(cfg.schema);
  if (!tabKeys.length) return;
  let activeTab = tabKeys[0];

  function readPref() {
    const v = getPref(cfg.prefName);
    return (v && typeof v === "object") ? v : {};
  }
  function writePref(next) { setPref(cfg.prefName, next); }
  function chartsForActive() {
    const pref = readPref();
    const saved = pref[activeTab];
    return Array.isArray(saved) ? saved : (cfg.defaults[activeTab] || []);
  }
  function isCustomised() {
    return Array.isArray(readPref()[activeTab]);
  }

  function render() {
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
    if (tab) { activeTab = tab.dataset.tab; render(); return; }
    const rm = e.target.closest(".rp-settings__mon-chart-x");
    if (rm) {
      const idx = parseInt(rm.dataset.idx, 10);
      const pref = readPref();
      const list = (pref[activeTab] || []).slice();
      list.splice(idx, 1);
      pref[activeTab] = list;
      writePref(pref);
      render();
      return;
    }
    if (e.target.closest(".rp-settings__mon-reset")) {
      const pref = readPref();
      delete pref[activeTab];
      writePref(pref);
      render();
      return;
    }
    if (e.target.closest(".rp-settings__mon-add")) {
      openAddChartModal(activeTab, cfg, (spec) => {
        const pref = readPref();
        // First "Add" on a tab promotes the defaults to a user list so
        // the user starts from "the defaults plus mine," not "blank +
        // mine" — surfacing the +1 instead of replacing.
        const base = Array.isArray(pref[activeTab])
          ? pref[activeTab]
          : (cfg.defaults[activeTab] || []).map(cloneSpec);
        pref[activeTab] = [...base, spec];
        writePref(pref);
        render();
      });
      return;
    }
  });

  render();
}

// Deep clone a chart spec (defaults → user list seed). JSON
// round-trip is fine — specs are pure JSON-encodable data.
function cloneSpec(s) { return JSON.parse(JSON.stringify(s)); }

// ── Add-chart modal ───────────────────────────────────────────────
// Inline overlay with two columns: live preview (left) + mountBuilder
// accordion (right). The builder owns the cfg; every onCfgChange
// reruns the preview's renderChart. "Add" persists via the caller's
// onAdd(spec) callback; cancel dismisses.
//
// `pickerCfg` carries the surface-specific knobs: schema (drives
// the field-picker), newTemplate (creates the starter spec), labels
// (for the modal title), surface name (drives the Add button label
// + the modal title preposition).
function openAddChartModal(tabKey, pickerCfg, onAdd) {
  const schema = pickerCfg.schema[tabKey];
  if (!schema) return;

  // The starter spec drives both the preview and the builder. We
  // pass the SAME object — builder mutates in place, preview reads
  // the same reference.
  const spec = pickerCfg.newTemplate(tabKey);
  if (!spec) return;
  const tabLabel = pickerCfg.labels[tabKey] || tabKey;
  spec.title = spec.cfg.title = "New " + tabLabel + " chart";
  const surfaceLabel = pickerCfg.surface === "home" ? "Home" : "Monitoring";

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
        delete spec.cfg.source;  // cfg shouldn't carry source — only spec does
      }
      spec.title = spec.cfg.title;  // mirror title for the saved spec
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

function renderSentinels(app, prefs) {
  const root = app.querySelector("#rp-settings-sentinels");
  if (!root) return;
  const list = Array.isArray(prefs.learned_sentinels) ? prefs.learned_sentinels : [];
  if (!list.length) {
    root.innerHTML =
      '<span class="rp-settings__sentinels-empty">'
      + 'No personal sentinels yet — add them via the Cleaner’s Fix-invalid modal.'
      + '</span>';
    return;
  }
  root.innerHTML = list.map((v) =>
    '<span class="rp-settings__sentinel">'
    + '<span class="rp-settings__sentinel-name">' + esc(v) + '</span>'
    + '<button type="button" class="rp-settings__sentinel-x" data-value="' + esc(v) + '"'
    +   ' aria-label="Remove ' + esc(v) + '" title="Remove">×</button>'
    + '</span>'
  ).join("");
}
