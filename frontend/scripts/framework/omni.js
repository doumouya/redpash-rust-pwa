/* Purpose: Omnisearch framework component — the site-wide search box + results dropdown (rp-omni).
 * Doc: docs/internal/code/frontend/scripts/framework/omni.md */
// ── Omnisearch (framework component, CAS_37B2E1BF) ──────────────────────────
// The centred site-wide search: GET /api/search, debounced 200ms, keyboard nav,
// Ctrl/Cmd+K focus. Lifted out of the topbar so it's a reusable widget in its own
// right (a command palette could mount it elsewhere) — the topbar just composes it.
// Backend ships a pre-built #/… hash per result; the click handler is one line.
//   wire: GET /api/search?q=&limit= → { q, ms, results:[{ kind, rid, label, sub, hash }] }
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { api } from "/scripts/api.js";
import { esc } from "/scripts/dom.js";

let _ctrlKBound = false;   // the Ctrl/Cmd+K handler binds once for the app's life

/** Build + wire the omnibox into `host` (host becomes the `.rp-omni`). */
export function mountOmni(host, { placeholder = "Search RedPash — projects, files, settings…" } = {}) {
  if (!host) return;
  host.className = "rp-omni";
  host.innerHTML =
      '<i class="bi bi-search"></i>'
    + '<input type="search" id="rp-omni" placeholder="' + esc(placeholder) + '" />'
    + '<kbd class="rp-omni-kbd">Ctrl K</kbd>';

  const input = host.querySelector("input");
  const drop = document.createElement("div");
  drop.className = "rp-omni-dropdown";
  drop.hidden = true;
  host.appendChild(drop);

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

  document.addEventListener("mousedown", (e) => { if (!host.contains(e.target)) close(); });

  // Ctrl/Cmd+K focuses the omnibox — binds once for the app's life.
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

register("omni", mountOmni);
