// Docs page — first fill: the index from GET /api/docs, grouped by
// section. Each row is read-only for now; click-through to the
// rendered doc body lands when the viewer does.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

export default function docs(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "docs", session });

  const list = app.querySelector("#rp-docs-list");

  loadDocs();

  async function loadDocs() {
    try {
      const data = await api.get("/docs");
      render(data?.items || []);
    } catch (err) {
      list.setAttribute("aria-busy", "false");
      list.innerHTML = '<p class="rp-page__placeholder">Couldn’t load docs'
        + (err.status ? " (" + err.status + ")" : "") + ".</p>";
    }
  }

  function render(items) {
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
        '<div class="rp-page__row">'
        + '<span class="rp-page__row-label">' + esc(d.title) + "</span>"
        + '<span class="rp-page__row-value">' + esc(d.last_modified || "—") + "</span>"
        + "</div>"
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

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
}
