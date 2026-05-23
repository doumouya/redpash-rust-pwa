// Docs page — two views in one module:
//   • index   — GET /api/docs grouped by section
//   • viewer  — GET /api/docs/<slug> rendered to HTML
// State is in the hash: bare #/docs → index, #/docs?slug=foo → viewer.
// The router re-mounts on hashchange (main.js), so clicking a doc row
// triggers a fresh module call that reads the new slug.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

export default function docs(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "docs", session });

  const list = app.querySelector("#rp-docs-list");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const slug = params.get("slug");

  if (slug) loadDoc(slug);
  else loadIndex();

  async function loadIndex() {
    try {
      const data = await api.get("/docs");
      renderIndex(data?.items || []);
    } catch (err) {
      list.setAttribute("aria-busy", "false");
      list.innerHTML = '<p class="rp-page__placeholder">Couldn’t load docs'
        + (err.status ? " (" + err.status + ")" : "") + ".</p>";
    }
  }

  function renderIndex(items) {
    list.setAttribute("aria-busy", "false");
    if (!items.length) {
      list.innerHTML = '<p class="rp-page__placeholder">No docs yet.</p>';
      return;
    }
    // Group by section, preserving the server's order (which already
    // sorts "Start here" first then section name, then per-section order).
    const sections = new Map();
    for (const it of items) {
      const key = it.section || "Misc";
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(it);
    }
    const html = [];
    for (const [name, entries] of sections) {
      const rows = entries.map((d) =>
        '<a class="rp-page__row rp-doc-row" href="#/docs?slug=' + encodeURIComponent(d.slug) + '">'
        + '<span class="rp-page__row-label">' + esc(d.title) + "</span>"
        + '<span class="rp-page__row-value">' + esc(d.last_modified || "—") + "</span>"
        + "</a>"
      ).join("");
      html.push(
        '<section class="rp-page__section">'
        + '<h2 class="rp-page__section-h">' + esc(name) + "</h2>"
        + rows
        + "</section>"
      );
    }
    list.innerHTML = html.join("");
  }

  async function loadDoc(slug) {
    list.innerHTML = '<p class="rp-page__placeholder">Loading…</p>';
    try {
      // The /docs/:slug endpoint returns rendered HTML, not JSON;
      // api.js's safeJson() falls back to returning the raw text on
      // parse failure, so api.get() yields the HTML string here.
      const html = await api.get("/docs/" + encodeURIComponent(slug));
      list.setAttribute("aria-busy", "false");
      list.innerHTML = ''
        + '<div class="rp-doc-head">'
        +   '<a class="rt-btn" href="#/docs"><i class="bi bi-arrow-left"></i> All docs</a>'
        + '</div>'
        + '<article class="rp-doc">' + (typeof html === "string" ? html : "") + '</article>';
    } catch (err) {
      list.setAttribute("aria-busy", "false");
      list.innerHTML = '<p class="rp-page__placeholder">Couldn’t load this doc'
        + (err.status ? " (" + err.status + ")" : "") + '. '
        + '<a href="#/docs">Back to index</a>.</p>';
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
}
