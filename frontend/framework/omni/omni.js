/* omni — the topbar's centred OMNISEARCH. A pill (search icon + input + Ctrl-K
   hint) plus a results dropdown. Content from GET /api/search — debounced 200ms,
   abortable, reach-scoped server-side (the same reach the rails use, across every
   source at once). Each result carries a ready `#/…` hash, so a click is one
   line. Ctrl/Cmd+K focuses it (bound once for the app's life). Keyboard nav
   (↑↓/Enter/Esc). Sole owner of .rp-omni* (rail-search + the input atom are
   separate). mountOmni(host, { placeholder? }) → { el, focus, destroy }.

   wire: GET /api/search?q=&limit= → { q, ms, results:[{ kind, rid, label, sub, hash }] } */

import { el } from "../boot/dom.js";
import { kbd } from "../atoms/atoms.js";
import { api } from "../boot/api.js";
import { register } from "../registry/component-registry.js";

const KIND_LABEL = {
  project: "Projects", file: "Files", chart: "Charts", dashboard: "Dashboards",
  user: "Users", company: "Companies", team: "Teams",
};
const KIND_ICON = {
  project: "bi-folder", file: "bi-file-earmark", chart: "bi-bar-chart",
  dashboard: "bi-grid-1x2", user: "bi-person", company: "bi-building", team: "bi-people",
};
const kindLabel = (k) => KIND_LABEL[k] ?? (k.charAt(0).toUpperCase() + k.slice(1) + "s");
const kindIcon = (k) => "bi " + (KIND_ICON[k] ?? "bi-dot");

// The Ctrl/Cmd+K handler binds once for the app's life and focuses whichever
// omnibox is currently mounted (one topbar at a time).
let ctrlKBound = false;

export function mountOmni(host, { placeholder = "Search RedPash — projects, files, settings…" } = {}) {
  if (!host) return null;

  const field = el("input", { type: "search", placeholder, "aria-label": "Search" });
  const menu = el("div", { class: "rp-omni-menu" });
  menu.hidden = true;
  const box = el("div", { class: "rp-omni" },
    el("i", { class: "bi bi-search" }),
    field,
    kbd("Ctrl K"),
    menu,
  );

  let results = [];
  let cursor = -1;
  let lastQ = "";
  let timer = null;
  let inflight = null;

  const close = () => { menu.hidden = true; cursor = -1; };
  const open = () => { menu.hidden = false; };

  async function search(q) {
    if (inflight) inflight.abort();
    inflight = new AbortController();
    try {
      const data = await api.get(
        `/search?q=${encodeURIComponent(q)}&limit=20`, { signal: inflight.signal });
      results = data?.results || [];
      cursor = results.length ? 0 : -1;
      render(q);
      open();
    } catch (err) {
      if (err?.name === "AbortError") return; // a newer keystroke won
      menu.replaceChildren(el("div", { class: "rp-omni-state" },
        "Search failed" + (err?.status ? ` (${err.status})` : "") + "."));
      open();
    }
  }

  function render(q) {
    if (!results.length) {
      menu.replaceChildren(el("div", { class: "rp-omni-state" }, "No results."));
      return;
    }
    const kids = [];
    let lastKind = null;
    results.forEach((r, idx) => {
      if (r.kind !== lastKind) {
        kids.push(el("div", { class: "rp-omni-section" }, kindLabel(r.kind)));
        lastKind = r.kind;
      }
      kids.push(resultEl(r, idx, q));
    });
    menu.replaceChildren(...kids);
  }

  function resultEl(r, idx, q) {
    const label = el("span", { class: "rp-omni-result-label" });
    const hit = q ? (r.label || "").toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (hit < 0) {
      label.textContent = r.label || "";
    } else {
      // text nodes + a highlighted span — no innerHTML, so q is never markup.
      label.append(
        document.createTextNode(r.label.slice(0, hit)),
        el("span", { class: "rp-omni-hl" }, r.label.slice(hit, hit + q.length)),
        document.createTextNode(r.label.slice(hit + q.length)),
      );
    }
    return el("button", {
      class: "rp-omni-result" + (idx === cursor ? " is-active" : ""),
      type: "button",
      "data-idx": String(idx),
    },
      el("i", { class: kindIcon(r.kind) }),
      label,
      r.sub ? el("span", { class: "rp-omni-result-sub" }, r.sub) : null,
    );
  }

  function scrollCursorIntoView() {
    menu.querySelector(".rp-omni-result.is-active")?.scrollIntoView({ block: "nearest" });
  }

  function navigateTo(r) {
    close();
    field.value = ""; lastQ = ""; results = [];
    location.hash = r.hash;
  }

  field.addEventListener("input", () => {
    const q = field.value.trim();
    if (q === lastQ) return;
    lastQ = q;
    if (timer) clearTimeout(timer);
    if (!q) { close(); return; }
    timer = setTimeout(() => search(q), 200);
  });

  field.addEventListener("focus", () => {
    if (results.length && field.value.trim()) open();
  });

  field.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); field.blur(); return; }
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

  // mousedown (not click) so it fires before the input's blur closes the menu.
  menu.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".rp-omni-result");
    if (!btn) return;
    e.preventDefault();
    const idx = parseInt(btn.dataset.idx, 10);
    if (Number.isFinite(idx) && results[idx]) navigateTo(results[idx]);
  });

  const onDocDown = (e) => { if (!box.contains(e.target)) close(); };
  document.addEventListener("mousedown", onDocDown);

  if (!ctrlKBound) {
    ctrlKBound = true;
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        const omni = document.querySelector(".rp-omni input");
        if (omni) { e.preventDefault(); omni.focus(); }
      }
    });
  }

  host.append(box);

  return {
    el: box,
    focus: () => field.focus(),
    destroy: () => { document.removeEventListener("mousedown", onDocDown); box.remove(); },
  };
}

register("omni", mountOmni);
