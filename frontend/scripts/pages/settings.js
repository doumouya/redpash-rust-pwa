/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/settings.md */
// Settings page — app preferences.
//
// **Settings v2 (CAS_55984AC7, steps 2-4):** the page renders by
// iterating the OPEN PREF REGISTRY in prefs.js. Each registered pref
// carries its `section` / `control` / `label` / `hint` / `options`,
// and `renderFromRegistry()` dispatches via the CONTROLS map to the
// matching page-row.js helper. Section EXTRAS below handles the few
// non-pref rows that remain inline (sentinels mount + share toggle,
// account fields + signout, about brand, Cases stub). Step 4 moved
// the chart picker into a separate control module
// (prefs/controls/chart-layouts.js) — dispatched the same way; step
// 5 lands Hidden Items as a new section under GENERAL.
//
// One delegated click handler drives every option group: each wrapper
// carries data-pref, each button carries data-value. Click → resolve
// pref → call the right setter (theme.js for theme, prefs.js setPref
// for everything else) → repaint is-active. Most pref values are
// strings, validated against the spec's `values` enum. `share_sentinels`
// is a boolean and gets coerced from its "true"/"false" data-value
// before write.
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
import { getPref, setPref, eachPref } from "/scripts/prefs.js";
import { esc } from "/scripts/dom.js";
import { prefRow, valueRow, actionsRow, mountRow } from "/scripts/page-row.js";
// Settings v2 step 3 — behavior-first search + tag chips. Sits in
// the surface header above the section view; live-filters the
// rendered pref rows by label / hint / key / tags and re-paints
// rail group badges with hit counts.
import { mountSearch } from "/scripts/pages/settings-search.js";
// Settings v2 step 5 — Hidden Items recovery surface. Scans
// localStorage for every `rp-pref-*_hidden_*` key (Workspace,
// Home, Cases) and renders per-page grouped lists with per-item
// + per-page restore. The source pages don't know this exists;
// they keep writing the same unregistered keys.
import { mountHidden } from "/scripts/pages/settings-hidden.js";
// Settings v2 step 4 — chart-layouts control renderer. Owns the
// Slice D / D2 picker for monitoringCharts + homeCharts (moved out
// of this file). Module shape: { render(spec), postMount(app, spec) }
// — same shape every future deferred-mount control follows.
import * as chartLayouts from "/scripts/prefs/controls/chart-layouts.js";
// Settings v2 — theme-swatch control. The general-theme picker: a grid
// of live per-theme preview cards (replaces the dark↔light onoff). Same
// { render, postMount } module shape as chart-layouts.
import * as themeSwatch from "/scripts/prefs/controls/theme-swatch.js";

// Server-side pref keys read on mount. Distinct from the registered
// pref keys in prefs.js — these come from /me, not the local registry.
const SERVER_PREF_KEYS = ["share_sentinels", "learned_sentinels"];

// ── controls dispatcher ─────────────────────────────────────────────
// Each entry is a small module with a `render(spec) => htmlString` +
// an optional `postMount(app, spec)` hook for deferred painters
// (chart-layouts, future mount-style controls). settings.js iterates
// the registry once to gather HTML, mounts it, then iterates again
// to fire each present postMount.
//
// Adding a new control type = importing the renderer module +
// adding it here.
const CONTROLS = {
  onoff:     { render: (spec) => prefRow(prefRowSpecFromPref(spec)) },
  segmented: { render: (spec) => prefRow(prefRowSpecFromPref(spec)) },
  stepper:   { render: fontStepperRow, postMount: wireFontStepper },
  "chart-layouts": chartLayouts,
  "theme-swatch":  themeSwatch,
};

function prefRowSpecFromPref(spec) {
  // Synthesise an `options` array from the spec's `values` when the
  // spec didn't supply one (e.g. simple enums whose labels match values).
  const options = Array.isArray(spec.options) ? spec.options
                : Array.isArray(spec.values)  ? spec.values.map((v) => ({ value: v, label: v }))
                : [];
  return {
    label:   spec.label,
    hint:    spec.hint,
    pref:    spec.key,
    options: options,
  };
}

// ── stepper control — A− / A+ over a pref's `values` ────────────────
// Renders the universal "decrease / increase text size" affordance for
// the fontSize pref instead of an sm/md/lg toggle (Em 2026-06-01: "just
// put A− / A+, everyone can pick a size, HiDPI or not"). setPref reflects
// the value to <html data-fontSize> (prefs.js), and the type scale is rem
// (tokens.css), so the whole app resizes live; the choice persists.
// `data-step` (not `data-value`) keeps these off the absolute-value click
// delegation below — the stepper drives itself via postMount.
function fontStepperRow(spec) {
  const hint = spec.hint ? '<small class="rp-settings__hint">' + spec.hint + "</small>" : "";
  return '<div class="rp-page__row" data-pref="' + spec.key + '">'
    + '<span class="rp-page__row-label">' + spec.label + hint + "</span>"
    + '<div class="rp-page__row-control rp-fontstep">'
      + '<button type="button" class="rp-btn-icon rp-fontstep__btn rp-fontstep__btn--dn" data-step="-1" title="Smaller text" aria-label="Decrease text size">A&minus;</button>'
      + '<span class="rp-fontstep__preview" aria-hidden="true">Aa</span>'
      + '<button type="button" class="rp-btn-icon rp-fontstep__btn rp-fontstep__btn--up" data-step="1" title="Larger text" aria-label="Increase text size">A+</button>'
    + "</div>"
  + "</div>";
}

function wireFontStepper(app, spec) {
  const row = app.querySelector('[data-pref="' + spec.key + '"]');
  if (!row) return;
  const values = Array.isArray(spec.values) ? spec.values : [];
  const btns = [...row.querySelectorAll("[data-step]")];
  const idx = () => Math.max(0, values.indexOf(getPref(spec.key)));
  const sync = () => {
    const i = idx();
    btns.forEach((b) => {
      b.disabled = Number(b.dataset.step) < 0 ? i <= 0 : i >= values.length - 1;
    });
  };
  btns.forEach((b) => b.addEventListener("click", () => {
    const i = idx();
    const next = Math.min(values.length - 1, Math.max(0, i + Number(b.dataset.step)));
    if (next !== i) setPref(spec.key, values[next]); // reflects to <html> + persists
    sync();
  }));
  sync();
}

// ── section extras ─────────────────────────────────────────────────
// Pre-rendered HTML for rows that aren't backed by a registered pref:
// sentinels mountRow + share_sentinels chip-row (server-passthrough,
// special boolean coercion), Cases stub placeholder, account fields
// (display name / username / signout), about brand. Each section's
// extras render AFTER its registered prefs.
const SECTION_EXTRAS = {
  "set-cleaner": [
    mountRow({
      label: "Personal sentinel values",
      hint:  "junk placeholders you've flagged in Fix invalid values. Add via the Cleaner; remove here.",
      id:    "rp-settings-sentinels",
      containerClass: "rp-settings__sentinels",
      emptyClass:     "rp-settings__sentinels-empty",
    }),
    prefRow({
      label:   "Share with all users",
      hint:    "your sentinels join the global vocabulary after 2+ users flag the same value. Only the placeholder string is shared.",
      pref:    "share_sentinels",
      options: [
        { value: "true",  label: "On"  },
        { value: "false", label: "Off" },
      ],
    }),
  ],
  // Note: set-monitoring-charts + set-home-charts moved to the
  // chart-layouts control renderer in step 4 (their specs in
  // prefs.js carry control: "chart-layouts" + the surface name).
  "set-account": [
    valueRow({ label: "Display name", id: "rp-settings-display" }),
    valueRow({ label: "Username",     id: "rp-settings-username" }),
    actionsRow({ label: "Sign out", actions: [
      { kind: "button", id: "rp-settings-signout", label: "Sign out", icon: "box-arrow-right" },
    ]}),
  ],
  // Cases section is now populated by registered prefs (step 6b
  // landed cases-doneWindow / cases-railGroupBy / cases-detailPanel
  // / cases-activeSource / cases-filterStatus + the dynamic-value
  // cases-filterAssignee). No extras row needed; the registry-
  // driven render fills the section.
  // About row is structurally unique (branded label + version mount);
  // inlined here rather than parameterised — no second site exists.
  "set-about": [
    '<div class="rp-page__row">'
      + '<span class="rp-page__row-label">'
        + '<span class="rp-settings__about-brand">RedPash</span> '
        + '<small class="rp-settings__hint" id="rp-settings-version">prerelease build</small>'
      + '</span>'
      + '<div class="rp-page__row-control">'
        + '<a class="rp-btn-icon" href="#/docs">Docs</a>'
        + '<a class="rp-btn-icon" href="#/docs?slug=vision">Vision</a>'
        + '<a class="rp-btn-icon" href="#/docs?slug=getting-started">Getting started</a>'
      + '</div>'
    + '</div>',
  ],
};

// ── section ↔ mount-key map ────────────────────────────────────────
// The partial uses short `[data-rp-rows="<key>"]` selectors while the
// rail tabs + spec.section use the full `set-<key>` form. One small
// map bridges the two; lookup is O(1).
const SECTION_MOUNT_KEY = {
  "set-appearance":        "appearance",
  "set-tables":            "tables",
  "set-workspace":         "workspace",
  "set-data":              "data",
  "set-cleaner":           "cleaner",
  "set-monitoring-charts": "monitoringCharts",
  "set-home-charts":       "homeCharts",
  "set-cases":             "cases",
  "set-hidden":            "hidden",
  "set-account":           "account",
  "set-about":             "about",
};

// ── render: iterate registry → group by section → dispatch + extras ──
function renderFromRegistry(app) {
  // Bucket every registered pref by section.
  const rowsBySection = {};
  eachPref((spec) => {
    if (!spec.section) return;     // pref doesn't surface in Settings
    const ctrl = CONTROLS[spec.control];
    if (!ctrl || typeof ctrl.render !== "function") return;
    if (!rowsBySection[spec.section]) rowsBySection[spec.section] = [];
    rowsBySection[spec.section].push(ctrl.render(spec));
  });
  // Append extras AFTER registered prefs for each section.
  for (const [section, extras] of Object.entries(SECTION_EXTRAS)) {
    if (!rowsBySection[section]) rowsBySection[section] = [];
    rowsBySection[section].push(...extras);
  }
  // Mount each section's combined HTML into its `[data-rp-rows]` slot.
  for (const [section, rows] of Object.entries(rowsBySection)) {
    const mountKey = SECTION_MOUNT_KEY[section] || section;
    const mount = app.querySelector('[data-rp-rows="' + mountKey + '"]');
    if (mount) mount.innerHTML = rows.join("");
  }
}

// ── post-mount hooks ────────────────────────────────────────────────
// Some controls (chart-layouts today, future mount-style ones) paint
// imperatively into their slot AFTER the row HTML lands. After
// renderFromRegistry mounts the rows, iterate the registry once more
// and call each spec's control.postMount hook if present.
function callPostMountHooks(app) {
  eachPref((spec) => {
    if (!spec.section) return;
    const ctrl = CONTROLS[spec.control];
    if (ctrl && typeof ctrl.postMount === "function") ctrl.postMount(app, spec);
  });
}

// Rail data — section index, grouped to match the canonical
// home / monitoring rail (rp-rail-group with two-letter color marks +
// rp-rail-tab children). Tab-switch UX (Em 2026-05-28): each rp-rail-tab
// click shows ONE section + hides the others — same affordance
// as Home / Monitoring / Workspace, so a tab opens at its head
// with the full surface available for that section's content.
// URL hash `#/settings?tab=<key>` drives the initial active tab
// so a refresh / deep-link lands the user back where they were.
// CAS_3FC70F56 — Settings rail regrouped from ability-bucketed
// (UI/DATA/CHARTS/ACCOUNT) to page-bucketed (GENERAL/HOME/WORKSPACE/
// CASES/MONITORING). The tab-switch UX is unchanged — each click
// shows one section, hides the others. Section IDs (set-*) are
// preserved so prefs / deep-links stay intact; only the rail layout
// changes. Cases group is new (set-cases stub section in settings.html);
// case-page prefs land there as they're identified.
const SET_GROUPS = [
  { name: "GENERAL",    mark: "GN", color: "mauve" },
  { name: "HOME",       mark: "HM", color: "blue"  },
  { name: "WORKSPACE",  mark: "WS", color: "teal"  },
  { name: "CASES",      mark: "CA", color: "peach" },
  { name: "MONITORING", mark: "MN", color: "green" },
];
const SET_TABS = [
  // GENERAL — global UI + identity + diagnostics
  { group: "GENERAL",    key: "set-appearance",        label: "Appearance",        icon: "bi-palette"         },
  { group: "GENERAL",    key: "set-hidden",            label: "Hidden items",      icon: "bi-eye-slash"       },
  { group: "GENERAL",    key: "set-account",           label: "Account",           icon: "bi-person-circle"   },
  { group: "GENERAL",    key: "set-about",             label: "About",             icon: "bi-info-circle"     },
  // HOME — Home page-specific prefs (today: just chart toggles).
  { group: "HOME",       key: "set-home-charts",       label: "Home charts",       icon: "bi-bar-chart-fill"  },
  // WORKSPACE — Workspace + the data-handling prefs that drive it
  { group: "WORKSPACE",  key: "set-workspace",         label: "Workspace",         icon: "bi-grid-3x3"        },
  { group: "WORKSPACE",  key: "set-tables",            label: "Tables",            icon: "bi-table"           },
  { group: "WORKSPACE",  key: "set-cleaner",           label: "Cleaner",           icon: "bi-tools"           },
  { group: "WORKSPACE",  key: "set-data",              label: "Data & Export",     icon: "bi-database"        },
  // CASES — Cases page settings (Em 2026-05-31 ask). Stub section
  // ships empty; pref rows land here as the Cases page surfaces
  // need them (kanban behavior, attachment rail default state, etc.)
  { group: "CASES",      key: "set-cases",             label: "Cases page",        icon: "bi-card-list"       },
  // MONITORING — monitoring chart toggles
  { group: "MONITORING", key: "set-monitoring-charts", label: "Monitoring charts", icon: "bi-bar-chart-line"  },
];

// Standard rail population — mirrors monitoring.js / home.js
// renderGroup + renderTab. Tab-switch UX (Em 2026-05-28: "switching
// the tabs just switch the content, and we have full screen
// availability for each tabs"): each rp-rail-tab click shows ONE section
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
      '<button type="button" class="rp-rail-tab" data-key="' + esc(t.key) + '">'
      +   '<i class="' + esc(t.icon) + ' rp-rail-tab-icon"></i>'
      +   '<span class="rp-rail-tab-name">' + esc(t.label) + '</span>'
      + '</button>').join("");
    return ''
      + '<div class="rp-rail-group expanded">'
      +   '<button class="rp-rail-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rp-rail-group-caret"></i>'
      +     '<span class="rp-rail-group-mark" data-c="' + esc(g.color) + '">' + esc(g.mark) + '</span>'
      +     '<span class="rp-rail-group-name">' + esc(g.name) + '</span>'
      +     '<span class="rp-rail-group-count">' + tabs.length + '</span>'
      +   '</button>'
      +   '<div class="rp-rail-group-body">' + items + '</div>'
      + '</div>';
  }).join("");

  const items     = Array.from(body.querySelectorAll(".rp-rail-tab"));
  const sections  = Array.from(surface.querySelectorAll(".rp-page__section"));
  const validKeys = new Set(SET_TABS.map((t) => t.key));

  // ── collapse button + group-head toggle ───────────────────
  mountRailCollapse(nav, app.querySelector("#rpSetNavCollapse"));
  body.addEventListener("click", (e) => {
    const head = e.target.closest(".rp-rail-group-head");
    if (head) { head.parentElement.classList.toggle("expanded"); return; }
    const tab = e.target.closest(".rp-rail-tab");
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
  mountRailFooterNav(app.querySelector(".rp-rail-footer"), { active: "settings", session });
  renderFromRegistry(app);
  mountSettingsRail(app);
  // Search must mount AFTER the rail is built — it indexes
  // `.rp-rail-group-count` badges per section so hit-count updates know
  // where to land.
  mountSearch(app);

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
    if (prefName === "general-theme") return currentTheme();
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
    if (prefName === "general-theme") {
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

  // ─── post-mount hooks (chart-layouts + future deferred painters) ─
  callPostMountHooks(app);

  // ─── Hidden Items recovery surface (step 5) ─────────────────
  mountHidden(app);
}

// mountChartPickerPanel / cloneSpec / openAddChartModal moved to
// frontend/scripts/prefs/controls/chart-layouts.js in step 4. The
// CONTROLS map + callPostMountHooks dispatch the picker per registered
// spec; settings.js doesn't know about chart specifics any more.

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
