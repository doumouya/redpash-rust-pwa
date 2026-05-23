// Settings page — app preferences.
//
// One delegated handler runs the page: each control's wrapping div
// carries a data-pref name, each button carries data-value. Click →
// resolve pref → call the right setter (theme.js for theme, prefs.js
// for everything else) → repaint is-active state. The actual visual
// impact (density, font size) propagates via token overrides in
// prefs.css — no per-page wiring needed beyond setPref.

import { mountTopbar } from "/scripts/topbar.js";
import { api } from "/scripts/api.js";
import { applyTheme, currentTheme } from "/scripts/theme.js";
import { getPref, setPref } from "/scripts/prefs.js";

export default function settings(app, { session }) {
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

  // ─── prefs: read current value, paint is-active per group ────
  function readCurrent(prefName) {
    return prefName === "theme" ? currentTheme() : getPref(prefName);
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
    if (prefName === "theme") applyTheme(value);
    else setPref(prefName, value);
    paint(group);
  });
}
