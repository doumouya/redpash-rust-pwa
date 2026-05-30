/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/pages/docs.md */
// Docs page — rail-driven viewer.
//
// Rail = section groups, each containing doc tabs. Body = the
// rendered markdown at full width (.rp-shell--wide). Hash routes the
// active doc (#/docs?slug=foo); bare #/docs loads the first doc of
// the first section so the page never lands on an empty body.
//
// Server-side contracts:
//   GET /api/docs         → { items: [{ slug, title, section, order, last_modified }] }
//                           items pre-sorted: "Start here" first, then per-section order.
//   GET /api/docs/<slug>  → rendered HTML body (pulldown_cmark).

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { mountRailCollapse } from "/scripts/rail-controls.js";
import { esc, cssEsc } from "/scripts/dom.js";

const GROUP_COLORS = ["blue", "mauve", "teal", "peach"];

export default function docs(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "docs", session });
  mountRailFooterNav(app.querySelector(".rt-nav-foot"), { active: "docs", session });

  const nav     = app.querySelector("#rpDocsNav");
  const navBody = app.querySelector("#rpDocsNavBody");
  const view    = app.querySelector("#rpDocsView");

  let items = [];          // all docs, server-ordered
  let bySection = [];      // grouped: [{ name, docs: [...] }, ...]
  let activeSlug = null;

  // ─── rail collapse — shared rail-controls helper ────────────
  mountRailCollapse(nav, app.querySelector("#rpDocsNavCollapse"));

  // ─── rail click delegation ───────────────────────────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) {
      head.closest(".rt-group").classList.toggle("expanded");
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      const slug = tab.dataset.slug;
      // Hash routing — the router re-mounts /docs on hashchange and
      // we read the slug from the URL on mount. One URL per doc,
      // shareable + back-button-friendly.
      location.hash = "#/docs?slug=" + encodeURIComponent(slug);
    }
  });

  loadIndex();

  async function loadIndex() {
    try {
      const data = await api.get("/docs");
      items = data?.items || [];
      bySection = groupBySection(items);
      renderRail();

      // Pick the active doc — hash slug, or default to the first
      // doc in the first section.
      const params = new URLSearchParams(location.hash.split("?")[1] || "");
      const want = params.get("slug");
      const firstSlug = items[0]?.slug;
      activeSlug = (want && items.find((d) => d.slug === want)) ? want : firstSlug;
      if (activeSlug) loadDoc(activeSlug);
      else renderEmpty();
    } catch (err) {
      navBody.setAttribute("aria-busy", "false");
      navBody.innerHTML = '<div class="rt-nav-state">Couldn’t load docs'
        + (err.status ? " (" + err.status + ")" : "") + ".</div>";
      view.innerHTML = '<p class="rp-shell-state">Couldn’t load the docs index.</p>';
    }
  }

  function groupBySection(items) {
    // Preserve server ordering — iterate items in order, append to the
    // running group when section changes. Map-of-arrays would re-order
    // on first sight; this keeps the "Start here" first contract.
    const groups = [];
    let cur = null;
    for (const d of items) {
      const name = d.section || "Misc";
      if (!cur || cur.name !== name) {
        cur = { name, docs: [] };
        groups.push(cur);
      }
      cur.docs.push(d);
    }
    return groups;
  }

  function renderRail() {
    navBody.setAttribute("aria-busy", "false");
    if (!bySection.length) {
      navBody.innerHTML = '<div class="rt-nav-state">No docs yet.</div>';
      return;
    }
    navBody.innerHTML = bySection.map(renderGroup).join("");
    // Expand all groups by default — section count is small + the
    // user wants to scan the whole TOC.
    navBody.querySelectorAll(".rt-group").forEach((g) => g.classList.add("expanded"));
  }

  function renderGroup(g, idx) {
    const color = GROUP_COLORS[idx % GROUP_COLORS.length];
    const mark = (g.name.match(/[A-Z]/g)?.join("") || g.name.slice(0, 2)).slice(0, 2).toUpperCase();
    return ''
      + '<div class="rt-group">'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + color + '">' + esc(mark) + '</span>'
      +     '<span class="rt-group-name">' + esc(g.name) + '</span>'
      +     '<span class="rt-group-count">' + g.docs.length + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body">' + g.docs.map(renderTab).join("") + '</div>'
      + '</div>';
  }

  function renderTab(d) {
    return ''
      + '<button class="rt-tab' + (d.slug === activeSlug ? ' active' : '') + '"'
      +     ' type="button" data-slug="' + esc(d.slug) + '">'
      +   '<i class="bi bi-file-text rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(d.title) + '</span>'
      + '</button>';
  }

  async function loadDoc(slug) {
    activeSlug = slug;
    // Repaint active state in the rail. Cheap — same DOM, just flip
    // the class on the matching tab.
    navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
    const tab = navBody.querySelector('.rt-tab[data-slug="' + cssEsc(slug) + '"]');
    if (tab) tab.classList.add("active");

    view.innerHTML = '<p class="rp-shell-state">Loading…</p>';
    try {
      // /docs/<slug> returns rendered HTML — api.js's safeJson
      // fallback yields the raw text when it isn't JSON-parseable.
      const html = await api.get("/docs/" + encodeURIComponent(slug));
      const meta = items.find((d) => d.slug === slug);
      const lastMod = meta?.last_modified || "";
      view.innerHTML = ''
        + '<div class="rp-doc-head">'
        +   '<h1 class="rp-doc-title">' + esc(meta?.title || slug) + '</h1>'
        +   (lastMod ? '<span class="rp-doc-stamp">last modified ' + esc(lastMod) + '</span>' : '')
        + '</div>'
        + '<article class="rp-doc">' + (typeof html === "string" ? html : "") + '</article>';
    } catch (err) {
      view.innerHTML = '<p class="rp-shell-state">Couldn’t load this doc'
        + (err.status ? " (" + err.status + ")" : "") + '.</p>';
    }
  }

  function renderEmpty() {
    view.innerHTML = '<p class="rp-shell-state">No docs yet — '
      + 'drop a markdown file into <code>docs/</code> and it’ll appear.</p>';
  }
}

