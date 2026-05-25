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
import { api } from "/scripts/api.js";
import { applyTheme, currentTheme } from "/scripts/theme.js";
import { getPref, setPref } from "/scripts/prefs.js";
import { esc } from "/scripts/dom.js";
import { prefRow, valueRow, actionsRow, mountRow } from "/scripts/page-row.js";

// Server-side pref keys read on mount. Distinct from PREFS in prefs.js:
// these come from /me, not the local registered enum.
const SERVER_PREF_KEYS = ["share_sentinels", "learned_sentinels"];

// Reusable option-button sets.
const ROWS_PER_PAGE = [
  { value: "10",  label: "10"  },
  { value: "25",  label: "25"  },
  { value: "50",  label: "50"  },
  { value: "100", label: "100" },
  { value: "all", label: "All" },
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

export default async function settings(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "settings", session });
  render(app);

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
