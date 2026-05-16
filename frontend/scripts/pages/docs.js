// Docs page. Public — works without a session.
//
// Two GETs:
//   /api/docs           → { items: [{ slug, title, section }, ...] }
//   /api/docs/:slug     → rendered HTML (server-rendered via
//                         pulldown-cmark + syntect)
//
// The selected slug lives in the hash query (#/docs?p=getting-started)
// so links are deep-shareable.

import { api } from "/scripts/api.js";

export default async function mount(root) {
  const nav     = root.querySelector("#docs-nav");
  const content = root.querySelector("#docs-content");

  let index;
  try { index = await api.get("/docs"); }
  catch (err) {
    nav.innerHTML = `<p class="rp-muted">Docs API not yet implemented.</p>`;
    return;
  }

  nav.innerHTML = renderNav(index.items ?? []);
  nav.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-slug]");
    if (!a) return;
    e.preventDefault();
    const slug = a.dataset.slug;
    location.hash = `#/docs?p=${encodeURIComponent(slug)}`;
    loadSlug(slug, content);
  });

  const slug = currentSlug() ?? (index.items?.[0]?.slug);
  if (slug) await loadSlug(slug, content);
}

function currentSlug() {
  const m = location.hash.match(/[?&]p=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function loadSlug(slug, content) {
  content.innerHTML = `<p class="rp-muted">Loading…</p>`;
  try {
    const html = await fetch(`/api/docs/${encodeURIComponent(slug)}`).then((r) => r.text());
    content.innerHTML = html;
  } catch (err) {
    content.innerHTML = `<p class="rp-muted">Failed to load: ${slug}</p>`;
  }
}

function renderNav(items) {
  const bySection = items.reduce((acc, it) => {
    (acc[it.section ?? "Misc"] ??= []).push(it);
    return acc;
  }, {});
  return Object.entries(bySection).map(([section, list]) => `
    <h3>${section}</h3>
    <ul>${list.map((it) => `<li><a href="#" data-slug="${it.slug}">${it.title}</a></li>`).join("")}</ul>
  `).join("");
}
