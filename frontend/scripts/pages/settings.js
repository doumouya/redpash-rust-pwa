// Settings page — app preferences.
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

// Server-side pref keys read on mount. Distinct from PREFS in prefs.js:
// these come from /me, not the local registered enum.
const SERVER_PREF_KEYS = ["share_sentinels", "learned_sentinels"];

export default async function settings(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "settings", session });

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

