/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/topbar.md */
// Topbar — the shared chrome for the authed pages.
//
// Multi-app model: the topbar is APP-SCOPED. A page calls
// mountTopbar(el, { active, session }); `active` names the current page, and the
// topbar DERIVES which app owns that page (apps.js `appForPage`) and renders only
// that app's nav + the launcher (app-switcher). Pages don't pass an `app` — the
// topbar self-determines it, so adding/moving a page is a one-line edit in apps.js
// and never touches a page's mountTopbar call.
//
// brand · omnibox · [launcher | app pages] + theme + sign-out. Utility pages
// (profile / settings — rail-footer destinations) belong to no app → appForPage
// falls back to the Home app, so their topbar is just the launcher.

import { api } from "/scripts/api.js";
import { esc } from "/scripts/dom.js";
import { appForPage } from "/scripts/framework/apps.js";
import { appSwitcherHTML } from "/scripts/framework/app-switcher.js";

// The Ctrl/Cmd+K handler is global and must bind once for the app's
// life, not once per topbar mount.
let _ctrlKBound = false;

// Time-of-day salutation + first_name (display_name fallback). Sits in
// the brand-name slot of the topbar so every page carries a personal
// "Good morning, …" instead of a static "RedPash" wordmark. Falls back
// to "RedPash" when the session isn't resolved yet (boot path before
// /api/me lands) so the brand mark never renders empty.
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
  // The app that owns this page → render only its nav (apps.js). Utility pages
  // (profile / settings) fall back to the Home app, so their topbar is just the
  // launcher. Theme toggle + sign-out moved to the rail footer (2026-06-07, Em) —
  // they're app-independent utilities; the topbar carries only nav + the launcher.
  const app = appForPage(active);
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
    +   appSwitcherHTML({ session, activeAppId: app.id })
    +   app.pages.map((p) =>
          '<a class="rp-btn-icon' + (p.id === active ? ' is-active' : '') + '"'
          + ' href="' + esc(p.hash) + '" title="' + esc(p.label) + '"><i class="bi ' + esc(p.icon) + '"></i></a>'
        ).join('')
    + '</nav>';

  // omnisearch — wires the input to GET /api/search (Gus's 778d2dd).
  // Topbar is remounted per page, so dropdown state resets between
  // navigations naturally — no cross-mount lifecycle to manage.
  mountOmnisearch(host.querySelector(".rp-omni"));

  // Ctrl/Cmd+K focuses the omnibox
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

// ─── omnisearch dropdown ───────────────────────────────────────
// Lives inside .rp-omni; appears below the input on each keystroke
// (debounced 200ms). Backend ships pre-built #/… hashes per result —
// the click handler is one line.
//
// Wire shape (GET /api/search?q=&limit=):
//   { q, ms, results: [{ kind, rid, label, sub, hash }] }
function mountOmnisearch(omniEl) {
  if (!omniEl) return;
  const input = omniEl.querySelector("input");
  const drop = document.createElement("div");
  drop.className = "rp-omni-dropdown";
  drop.hidden = true;
  omniEl.appendChild(drop);

  let results = [];
  let cursor  = -1;       // index of currently-highlighted result
  let lastQ   = "";
  let timer   = null;
  let inflight = null;    // AbortController for the latest fetch

  function close() {
    drop.hidden = true;
    cursor = -1;
  }
  function open() { drop.hidden = false; }

  async function search(q) {
    // Abort any inflight to avoid out-of-order replies overwriting
    // a more-recent search.
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
    // Group by kind. Backend already orders results by kind, so a
    // single pass with a section-header on kind transitions does it.
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

  // Wrap the substring matching q in a span — case-insensitive,
  // first occurrence only. Plenty for an op-bar search highlight.
  function highlight(s, q) {
    if (!q) return esc(s);
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(s);
    return esc(s.slice(0, i))
      + '<span class="rp-omni-hl">' + esc(s.slice(i, i + q.length)) + '</span>'
      + esc(s.slice(i + q.length));
  }

  function kindLabel(k) {
    // Explicit labels — the fallback (capitalize + "s") would mangle
    // "company" → "Companys", so admin entities need real plurals here.
    return ({ project: "Projects", file: "Files", chart: "Charts", dashboard: "Dashboards",
              user: "Users", company: "Companies", membership: "Memberships" })[k]
      || (k.charAt(0).toUpperCase() + k.slice(1) + "s");
  }
  function kindIcon(k) {
    return ({
      project:    "bi bi-folder",
      file:       "bi bi-file-earmark",
      chart:      "bi bi-bar-chart",
      dashboard:  "bi bi-grid",
      user:       "bi bi-person",
      company:    "bi bi-building",
      membership: "bi bi-person-badge",
    })[k] || "bi bi-dot";
  }

  // ─── input wiring ─────────────────────────────────────────────
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
      render(lastQ);
      scrollCursorIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = (cursor - 1 + results.length) % results.length;
      render(lastQ);
      scrollCursorIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0 && cursor < results.length) navigateTo(results[cursor]);
    }
  });

  function scrollCursorIntoView() {
    const active = drop.querySelector(".rp-omni-result.is-active");
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  // Mousedown (not click) — fires before blur, so the navigation
  // works without the dropdown closing first via the document
  // blur-on-outside-click handler below.
  drop.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".rp-omni-result");
    if (!btn) return;
    e.preventDefault();
    const idx = parseInt(btn.dataset.idx, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < results.length) {
      navigateTo(results[idx]);
    }
  });

  function navigateTo(r) {
    close();
    input.value = "";
    lastQ = "";
    results = [];
    location.hash = r.hash;
  }

  // Outside click closes the dropdown.
  document.addEventListener("mousedown", (e) => {
    if (!omniEl.contains(e.target)) close();
  });
}

