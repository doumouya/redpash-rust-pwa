// Topbar — the shared chrome for the authed pages (home, Workspace).
//
// One component, one button pattern: brand · omnibox · nav + theme +
// sign-out + avatar. A page drops <header id="rp-topbar"></header> into
// its partial and its script calls mountTopbar(el, { active, session });
// `active` names which nav entry is the current page. There is exactly
// one topbar — every authed page renders the identical thing.
//
// NAV is the closed list of the app's authed pages. Entries marked
// `parked: true` render as a disabled button (an honest "coming soon",
// not a broken link); wiring lands when the page does, by dropping the
// `parked` flag from the entry — no other topbar edit needed.

import { api } from "/scripts/api.js";
import { toggleTheme, currentTheme } from "/scripts/theme.js";

// Profile lives on the avatar (bottom-right of the topbar nav), not
// as a generic rt-btn — saves a slot and the avatar already advertises
// "this is you", so clicking it for "your profile" is the natural read.
const NAV = [
  { id: "home",       hash: "#/home",       icon: "bi-house-door",  label: "Home" },
  { id: "workspace",  hash: "#/workspace",  icon: "bi-stars",       label: "Workspace" },
  { id: "monitoring", hash: "#/monitoring", icon: "bi-activity",    label: "Monitoring" },
  { id: "settings",   hash: "#/settings",   icon: "bi-gear",        label: "Settings" },
  { id: "docs",       hash: "#/docs",       icon: "bi-book-half",   label: "Docs" },
];

// The Ctrl/Cmd+K handler is global and must bind once for the app's
// life, not once per topbar mount.
let _ctrlKBound = false;

export function mountTopbar(host, { active = "", session = null } = {}) {
  if (!host) return;
  host.className = "rp-topbar";
  host.innerHTML =
      '<a class="rp-brand" href="#/home" title="Home">'
    +   '<span class="rp-brand-mark"></span>'
    +   '<span class="rp-brand-name">RedPash</span>'
    + '</a>'
    + '<div class="rp-omni">'
    +   '<i class="bi bi-search"></i>'
    +   '<input type="search" id="rp-omni" placeholder="Search RedPash — projects, files, settings…" />'
    +   '<kbd class="rp-omni-kbd">Ctrl K</kbd>'
    + '</div>'
    + '<nav class="rp-topbar-actions">'
    +   NAV.map((n) => n.parked
          ? '<button class="rt-btn" type="button" disabled title="' + n.label + ' — coming soon">'
            + '<i class="bi ' + n.icon + '"></i></button>'
          : '<a class="rt-btn' + (n.id === active ? ' is-active' : '') + '"'
            + ' href="' + n.hash + '" title="' + n.label + '"><i class="bi ' + n.icon + '"></i></a>'
        ).join('')
    +   '<button class="rt-btn" type="button" data-act="theme" title="Toggle theme">'
    +     '<i class="bi bi-sun"></i></button>'
    +   '<button class="rt-btn" type="button" data-act="signout" title="Sign out">'
    +     '<i class="bi bi-box-arrow-right"></i></button>'
    +   '<a class="rp-avatar' + (active === "profile" ? ' is-active' : '') + '"'
    +     ' href="#/profile" data-avatar title="Profile">··</a>'
    + '</nav>';

  // avatar — the signed-in user's initials
  const name = (session?.display_name || session?.username || "").trim();
  host.querySelector("[data-avatar]").textContent = name
    ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "··";

  // theme toggle — the icon shows the theme the click switches to
  const themeBtn = host.querySelector('[data-act="theme"]');
  const paintTheme = () => {
    themeBtn.querySelector("i").className =
      currentTheme() === "light" ? "bi bi-moon-stars" : "bi bi-sun";
  };
  paintTheme();
  themeBtn.addEventListener("click", () => { toggleTheme(); paintTheme(); });

  // sign out
  host.querySelector('[data-act="signout"]').addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });

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
    return ({ project: "Projects", file: "Files", chart: "Charts", dashboard: "Dashboards" })[k]
      || (k.charAt(0).toUpperCase() + k.slice(1) + "s");
  }
  function kindIcon(k) {
    return ({
      project:   "bi bi-folder",
      file:      "bi bi-file-earmark",
      chart:     "bi bi-bar-chart",
      dashboard: "bi bi-grid",
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
