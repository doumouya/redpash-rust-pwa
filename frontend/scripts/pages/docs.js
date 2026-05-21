// Docs page. Public — works without a session. Full-bleed page with
// Home-style float-bar chrome (see partials/docs.html).
//
// Two GETs:
//   /api/docs           → { items: [{ slug, title, section, order }, …] }
//   /api/docs/<slug>    → rendered HTML (server-rendered via pulldown-cmark)
//
// The selected slug lives in the hash query (#/docs?p=getting-started)
// so links are deep-shareable.

import { api } from "/scripts/api.js";

export default async function mount(root, ctx) {
  const nav     = root.querySelector("#docs-nav");
  const content = root.querySelector("#docs-content");

  fillAvatar(root, ctx?.session ?? {});

  // Log out — exposed for the top-right float bar's inline onclick.
  window.doLogout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    location.hash = "#/landing";
    location.reload();
  };

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
    markActive(nav, slug);
    loadSlug(slug, content);
  });

  const slug = currentSlug() ?? (index.items?.[0]?.slug);
  if (slug) {
    markActive(nav, slug);
    await loadSlug(slug, content);
  }
}

function currentSlug() {
  const m = location.hash.match(/[?&]p=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function loadSlug(slug, content) {
  content.innerHTML = `<p class="rp-muted">Loading…</p>`;
  try {
    // slug is a path-safe doc path (e.g. `api/auth`) — keep the slashes
    // so the backend's `/api/docs/*slug` wildcard route matches.
    const html = await fetch(`/api/docs/${slug}`).then((r) => r.text());
    content.innerHTML = html;
    content.scrollTop = 0;
  } catch (err) {
    content.innerHTML = `<p class="rp-muted">Failed to load: ${slug}</p>`;
  }
}

// Paints the shared rp-side-nav component: a group header per section,
// then one link per doc. markActive() toggles `.is-active` on the
// link whose data-slug matches the open doc.
function renderNav(items) {
  const bySection = items.reduce((acc, it) => {
    (acc[it.section ?? "Misc"] ??= []).push(it);
    return acc;
  }, {});
  return Object.entries(bySection).map(([section, list]) => `
    <div class="rp-side-nav__group-hdr">${section}</div>
    ${list.map((it) => `<a class="rp-side-nav__link" href="#" data-slug="${it.slug}"><span>${it.title}</span></a>`).join("")}
  `).join("");
}

// Light the nav entry for the open doc.
function markActive(nav, slug) {
  nav.querySelectorAll("a[data-slug]").forEach((a) => {
    a.classList.toggle("is-active", a.dataset.slug === slug);
  });
}

// Top-left float avatar — initials from the session, photo when set.
// Mirrors home.js: a photo (when present) becomes a background-image so
// the library's background-size:cover crops it square inside the circle.
function fillAvatar(root, session) {
  const avatar = root.querySelector("#docs-avatar");
  if (!avatar) return;
  const label = session.display_name ?? session.username ?? "··";
  const initials = label
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "··";
  if (session.avatar_url) {
    avatar.classList.remove("rp-initials");
    avatar.style.backgroundImage = `url("/api/me/avatar")`;
    avatar.textContent = "";
    avatar.setAttribute("aria-label", label);
  } else {
    avatar.textContent = initials;
  }
}
