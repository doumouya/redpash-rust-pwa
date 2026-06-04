/* Purpose: TopBar framework component — the single shared top chrome (rp- only).
 * Doc: docs/internal/code/frontend/scripts/framework/topbar.md */
// ── TopBar (framework component, CAS_37B2E1BF) ──────────────────────────────
// The shared chrome for every authed page: brand · omnibox · nav + theme +
// sign-out. Already single-source (every page renders the identical thing); the
// framework move makes it a registered component and brings it onto the rp- only
// namespace — the nav/theme/signout buttons use the rp-btn-icon atom (was rt-btn).
//
// A page drops <header id="rp-topbar"></header> + calls mountTopbar(el, {active, session});
// `active` names the current nav entry. NAV is the closed list of authed pages;
// `admin: true` entries render only for is_platform_admin (Monitoring → CAS_274EDF3B).
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { api } from "/scripts/api.js";
import { toggleTheme, currentTheme } from "/scripts/theme.js";
import { esc } from "/scripts/dom.js";

const NAV = [
  { id: "home",       hash: "#/home",       icon: "bi-house-door",  label: "Home" },
  { id: "workspace",  hash: "#/workspace",  icon: "bi-stars",       label: "Workspace" },
  { id: "cases",      hash: "#/cases",      icon: "bi-kanban",      label: "Cases" },
  { id: "monitoring", hash: "#/monitoring", icon: "bi-activity",    label: "Monitoring", admin: true },
];

// Ctrl/Cmd+K binds once for the app's life, not per mount.
let _ctrlKBound = false;

// Time-of-day salutation + first_name (display_name fallback) in the brand slot.
// Falls back to "RedPash" before /api/me lands so the mark never renders empty.
function greetingFor(session) {
  const name = (session?.first_name || session?.display_name || "").trim();
  if (!name) return "RedPash";
  const hour = new Date().getHours();
  const tod  = hour < 5  ? "Good night"
             : hour < 12 ? "Good morning"
             : hour < 18 ? "Good afternoon"
             : hour < 22 ? "Good evening"
             :             "Good night";
  return esc(tod + ", " + name + ".");
}

export function mountTopbar(host, { active = "", session = null } = {}) {
  if (!host) return;
  host.className = "rp-topbar";
  host.innerHTML =
      '<a class="rp-brand" href="#/home" title="Home">'
    +   '<span class="rp-brand-mark"></span>'
    +   '<span class="rp-brand-name">' + greetingFor(session) + '</span>'
    + '</a>'
    + '<div class="rp-omni">'
    +   '<i class="bi bi-search"></i>'
    +   '<input type="search" id="rp-omni" placeholder="Search RedPash — projects, files, settings…" />'
    +   '<kbd class="rp-omni-kbd">Ctrl K</kbd>'
    + '</div>'
    + '<nav class="rp-topbar-actions">'
    +   NAV.filter((n) => !n.admin || session?.is_platform_admin).map((n) => n.parked
          ? '<button class="rp-btn-icon" type="button" disabled title="' + n.label + ' — coming soon">'
            + '<i class="bi ' + n.icon + '"></i></button>'
          : '<a class="rp-btn-icon' + (n.id === active ? ' is-active' : '') + '"'
            + ' href="' + n.hash + '" title="' + n.label + '"><i class="bi ' + n.icon + '"></i></a>'
        ).join('')
    +   '<button class="rp-btn-icon" type="button" data-act="theme" title="Toggle theme">'
    +     '<i class="bi bi-sun"></i></button>'
    +   '<button class="rp-btn-icon" type="button" data-act="signout" title="Sign out">'
    +     '<i class="bi bi-box-arrow-right"></i></button>'
    + '</nav>';

  // theme toggle — the icon shows the CURRENT theme (Dark ↔ moon-stars,
  // Light ↔ sun), aligned with the Settings Appearance row (Em 2026-05-28).
  const themeBtn = host.querySelector('[data-act="theme"]');
  const paintTheme = () => {
    themeBtn.querySelector("i").className =
      currentTheme() === "light" ? "bi bi-sun" : "bi bi-moon-stars";
  };
  paintTheme();
  themeBtn.addEventListener("click", () => { toggleTheme(); paintTheme(); });

  host.querySelector('[data-act="signout"]').addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });

  // omnisearch — GET /api/search; remounted per page so dropdown state resets naturally.
  mountOmnisearch(host.querySelector(".rp-omni"));

  if (!_ctrlKBound) {
    _ctrlKBound = true;
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        const omni = document.getElementById("rp-omni");
        if (omni) { e.preventDefault(); omni.focus(); }
      }
    });
  }
}

// ─── omnisearch dropdown ──────────────────────────────────────────
// Lives inside .rp-omni; appears below the input per keystroke (debounced 200ms).
// Backend ships pre-built #/… hashes per result. Wire: GET /api/search?q=&limit=
//   { q, ms, results: [{ kind, rid, label, sub, hash }] }
function mountOmnisearch(omniEl) {
  if (!omniEl) return;
  const input = omniEl.querySelector("input");
  const drop = document.createElement("div");
  drop.className = "rp-omni-dropdown";
  drop.hidden = true;
  omniEl.appendChild(drop);

  let results = [];
  let cursor  = -1;
  let lastQ   = "";
  let timer   = null;
  let inflight = null;

  function close() { drop.hidden = true; cursor = -1; }
  function open() { drop.hidden = false; }

  async function search(q) {
    if (inflight) inflight.abort();
    inflight = new AbortController();
    try {
      const data = await api.get("/search?q=" + encodeURIComponent(q) + "&limit=20",
        { signal: inflight.signal });
      results = data?.results || [];
      cursor  = results.length ? 0 : -1;
      render(q);
      open();
    } catch (err) {
      if (err.name === "AbortError") return;
      drop.innerHTML = '<div class="rp-omni-state">Search failed'
        + (err?.status ? " (" + err.status + ")" : "") + '.</div>';
      open();
    }
  }

  function render(q) {
    if (!results.length) {
      drop.innerHTML = '<div class="rp-omni-state">No results.</div>';
      return;
    }
    const parts = [];
    let lastKind = null;
    results.forEach((r, idx) => {
      if (r.kind !== lastKind) {
        parts.push('<div class="rp-omni-section">' + esc(kindLabel(r.kind)) + '</div>');
        lastKind = r.kind;
      }
      parts.push(rowHTML(r, idx, q));
    });
    drop.innerHTML = parts.join("");
  }

  function rowHTML(r, idx, q) {
    return '<button type="button" class="rp-omni-result' + (idx === cursor ? ' is-active' : '')
      + '" data-idx="' + idx + '">'
      +   '<i class="' + kindIcon(r.kind) + '"></i>'
      +   '<span class="rp-omni-result-label">' + highlight(r.label, q) + '</span>'
      +   (r.sub ? '<span class="rp-omni-result-sub">' + esc(r.sub) + '</span>' : '')
      + '</button>';
  }

  function highlight(s, q) {
    if (!q) return esc(s);
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(s);
    return esc(s.slice(0, i))
      + '<span class="rp-omni-hl">' + esc(s.slice(i, i + q.length)) + '</span>'
      + esc(s.slice(i + q.length));
  }

  function kindLabel(k) {
    return ({ project: "Projects", file: "Files", chart: "Charts", dashboard: "Dashboards",
              user: "Users", company: "Companies", membership: "Memberships" })[k]
      || (k.charAt(0).toUpperCase() + k.slice(1) + "s");
  }
  function kindIcon(k) {
    return ({
      project: "bi bi-folder", file: "bi bi-file-earmark", chart: "bi bi-bar-chart",
      dashboard: "bi bi-grid", user: "bi bi-person", company: "bi bi-building",
      membership: "bi bi-person-badge",
    })[k] || "bi bi-dot";
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (q === lastQ) return;
    lastQ = q;
    if (timer) clearTimeout(timer);
    if (!q) { close(); return; }
    timer = setTimeout(() => search(q), 200);
  });

  input.addEventListener("focus", () => {
    if (results.length && input.value.trim()) open();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); input.blur(); return; }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = (cursor + 1) % results.length;
      render(lastQ); scrollCursorIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = (cursor - 1 + results.length) % results.length;
      render(lastQ); scrollCursorIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0 && cursor < results.length) navigateTo(results[cursor]);
    }
  });

  function scrollCursorIntoView() {
    const active = drop.querySelector(".rp-omni-result.is-active");
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
  }

  drop.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".rp-omni-result");
    if (!btn) return;
    e.preventDefault();
    const idx = parseInt(btn.dataset.idx, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < results.length) navigateTo(results[idx]);
  });

  function navigateTo(r) {
    close();
    input.value = ""; lastQ = ""; results = [];
    location.hash = r.hash;
  }

  document.addEventListener("mousedown", (e) => { if (!omniEl.contains(e.target)) close(); });
}

register("topbar", mountTopbar);
