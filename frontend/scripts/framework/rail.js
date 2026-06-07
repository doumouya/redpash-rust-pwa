/* Purpose: Rail framework component — the vertical 2-level group/tab navigation strip.
   Doc: docs/internal/code/frontend/scripts/framework/rail.md */
// ── Rail (framework component, CAS_37B2E1BF) ────────────────────────────────
// The vertical two-level navigation strip: a group = a container (project /
// status bucket), a tab = a leaf (file / case). Collapses to a 3.75rem
// icon-only rail. Generic + data-driven: mountRail(host, config) emits the
// whole rp-rail-* structure from a config of data + handlers — pages supply
// the config, the builder owns the structure + behavior ("lego brick").
//
// Composes, not duplicates:
//   - rp-search atom (.rp-rail context) for the filter box
//   - rp-chip atom for the filter chips
//   - rp-btn-icon atom for every icon button (collapse / rename / hide / create)
//   - mountRailCollapse + mountRailSeg (rail-controls.js) for the two behaviors
//     that were already deduped live — class-agnostic, reused verbatim.
// The footer (upload / create / footer-nav) is part of the rail component here:
// the live split into rail-footer.js was a 2026-05-28 relocation artifact; the
// framework re-unifies the rail as one self-contained component (legacy
// rail-footer.js + rp-rail-footer-nav retire at the shell cutover).
"use strict";

import { register } from "/scripts/framework/component-registry.js";
import { esc } from "/scripts/dom.js";
import { mountRailCollapse, mountRailSeg } from "/scripts/rail-controls.js";

// ── config shape (every section optional) ───────────────────────────────────
//   title       : string                       → rp-rail-title
//   collapsible : bool                          → head collapse toggle
//   views       : { pref, fallback, options:[{value,label,icon}], onChange }
//                                                 → rp-rail-views seg
//   search      : { placeholder, onInput(q) }   → rp-rail-filter > rp-search
//   chips       : [{ value, label, active }]    → rp-rail-chips > rp-chip
//   onChip      : (value) => void
//   overview    : { label, icon, active }       → rp-rail-overview (pinned tab)
//   onOverview  : () => void
//   groups      : [{ id, name, mark, count, collapsed, renamable, hidable,
//                    addLabel, tabs:[{ id, name, icon, dot, ghost, active,
//                    busy, renamable, hidable }] }]
//   hidden      : [{ title, items:[{ id, kind, name, meta }] }]
//   footer      : { upload:{label}, create:{label}, nav:{ active, session } }
//   on          : { tab, tabRename, tabHide, groupToggle, groupRename,
//                    groupHide, groupAdd, restore, upload, create }
// Every handler receives the relevant id(s); the builder owns the DOM, the
// caller owns what each action *does*.

const FOOTER_NAV = [
  { id: "docs",     hash: "#/docs",     icon: "bi-book-half", label: "Docs" },
  { id: "settings", hash: "#/settings", icon: "bi-gear",      label: "Settings" },
  // Profile renders as an avatar (initials) — the "this is you" read.
  { id: "profile",  hash: "#/profile",  avatar: true,         label: "Profile" },
];

function initialsOf(session) {
  const name = (session?.display_name || session?.username || "").trim();
  return name
    ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "··";
}

/** Build + wire the rail into `host`. `host` becomes the `.rp-rail` element. */
export function mountRail(host, config = {}) {
  if (!host) return null;
  const on = config.on || {};
  host.className = "rp-rail";
  host.innerHTML =
      headHTML(config)
    + viewsHTML(config)
    + filterHTML(config)
    + chipsHTML(config)
    + '<div class="rp-rail-body">'
    +   overviewHTML(config)
    +   (config.groups || []).map(groupHTML).join("")
    +   hiddenHTML(config)
    + '</div>'
    + footerHTML(config);

  // ── behaviors ──────────────────────────────────────────────────────────
  if (config.collapsible !== false) {
    mountRailCollapse(host, host.querySelector('[data-rail-action="collapse"]'));
  }

  let seg = null;
  const segEl = host.querySelector(".rp-rail-views");
  if (segEl && config.views) {
    seg = mountRailSeg(segEl, {
      pref: config.views.pref,
      fallback: config.views.fallback,
      onChange: config.views.onChange || null,
    });
  }

  const input = host.querySelector(".rp-rail-filter input");
  if (input && config.search?.onInput) {
    input.addEventListener("input", () => config.search.onInput(input.value.trim()));
  }

  // One delegated click handler routes every rail action by data-* attribute —
  // survives re-renders of the body without re-binding per element.
  host.addEventListener("click", (e) => {
    const el = e.target.closest("[data-rail-action]");
    if (!el || !host.contains(el)) return;
    const action = el.dataset.railAction;
    if (action === "collapse") return;                 // handled by mountRailCollapse

    const tabEl   = el.closest(".rp-rail-tab");
    const groupEl = el.closest(".rp-rail-group");
    const tabId   = tabEl?.dataset.tabId;
    const groupId = groupEl?.dataset.groupId;

    switch (action) {
      case "chip":     on && config.onChip?.(el.dataset.chip); return;
      case "overview": e.preventDefault(); config.onOverview?.(); return;
      case "group-toggle": {
        e.preventDefault();
        // rail.css shows the group body via `.expanded` (NOT `.is-collapsed`) —
        // `.rp-rail-group:not(.expanded) .rp-rail-group-body { display:none }`.
        const expanded = groupEl.classList.toggle("expanded");
        on.groupToggle?.(groupId, !expanded);
        return;
      }
      case "group-rename": e.stopPropagation();
        inlineRename(groupEl.querySelector(".rp-rail-group-name"),
          (v) => on.groupRename?.(groupId, v)); return;
      case "group-hide":   e.stopPropagation(); on.groupHide?.(groupId); return;
      case "group-add":    e.stopPropagation(); on.groupAdd?.(groupId); return;
      case "tab":          e.preventDefault(); on.tab?.(tabId, groupId); return;
      case "tab-rename":   e.stopPropagation();
        inlineRename(tabEl.querySelector(".rp-rail-tab-name"),
          (v) => on.tabRename?.(tabId, v)); return;
      case "tab-hide":     e.stopPropagation(); on.tabHide?.(tabId); return;
      case "restore":      e.preventDefault(); on.restore?.(el.dataset.restoreId, el.dataset.restoreKind); return;
      case "upload":       on.upload?.(); return;
      case "create":       on.create?.(); return;
    }
  });

  return {
    el: host,
    seg,
    /** Re-render the body (groups + hidden) in place after a data change. */
    setGroups(groups, hidden) {
      const body = host.querySelector(".rp-rail-body");
      if (!body) return;
      body.innerHTML =
          overviewHTML(config)
        + (groups || []).map(groupHTML).join("")
        + hiddenHTML({ ...config, hidden });
    },
  };
}

// ── section renderers (pure HTML, all user content via esc()) ───────────────

function headHTML(c) {
  const collapse = c.collapsible === false ? "" :
    '<button class="rp-btn-icon" data-rail-action="collapse" title="Collapse">'
    + '<i class="bi bi-chevron-double-left"></i></button>';
  return '<div class="rp-rail-head">'
    + '<span class="rp-rail-title">' + esc(c.title || "") + '</span>'
    + collapse
    + '</div>';
}

function viewsHTML(c) {
  if (!c.views?.options?.length) return "";
  const btns = c.views.options.map((o) =>
    '<button type="button" data-rail-seg="' + esc(o.value) + '">'
    + (o.icon ? '<i class="bi ' + esc(o.icon) + '"></i>' : "")
    + esc(o.label) + '</button>').join("");
  return '<div class="rp-rail-views">' + btns + '</div>';
}

function filterHTML(c) {
  if (!c.search) return "";
  // the rp-search atom in the .rp-rail context (a plain filter box — no results
  // dropdown; that part is omni-specific). Search is one atom everywhere.
  return '<div class="rp-rail-filter">'
    + '<div class="rp-search">'
    +   '<i class="bi bi-search"></i>'
    +   '<input type="search" placeholder="' + esc(c.search.placeholder || "Filter…") + '" />'
    + '</div></div>';
}

function chipsHTML(c) {
  if (!c.chips?.length) return "";
  const chips = c.chips.map((ch) =>
    '<button type="button" class="rp-chip' + (ch.active ? " is-active" : "") + '" '
    + 'data-rail-action="chip" data-chip="' + esc(ch.value) + '">' + esc(ch.label) + '</button>'
  ).join("");
  return '<div class="rp-rail-chips">' + chips + '</div>';
}

function overviewHTML(c) {
  if (!c.overview) return "";
  const o = c.overview;
  return '<div class="rp-rail-overview">'
    + '<button type="button" class="rp-rail-tab' + (o.active ? " active" : "") + '" '
    + 'data-rail-action="overview">'
    +   '<i class="rp-rail-tab-icon bi ' + esc(o.icon || "bi-grid-1x2") + '"></i>'
    +   '<span class="rp-rail-tab-name">' + esc(o.label || "Overview") + '</span>'
    + '</button></div>';
}

function groupHTML(g) {
  const head = '<div class="rp-rail-group-head" data-rail-action="group-toggle">'
    + '<i class="rp-rail-group-caret bi bi-chevron-right"></i>'
    + (g.mark ? '<span class="rp-rail-group-mark" style="--mark:' + esc(g.mark) + '"></span>' : "")
    + '<span class="rp-rail-group-name">' + esc(g.name || "") + '</span>'
    + (Number.isFinite(g.count) ? '<span class="rp-rail-group-count">' + g.count + '</span>' : "")
    + (g.renamable ? '<button class="rp-btn-icon rp-rail-group-rename" data-rail-action="group-rename" title="Rename"><i class="bi bi-pencil"></i></button>' : "")
    + (g.hidable ? '<button class="rp-btn-icon rp-rail-group-hide" data-rail-action="group-hide" title="Hide"><i class="bi bi-eye-slash"></i></button>' : "")
    + '</div>';
  const tabs = (g.tabs || []).map(tabHTML).join("");
  const add = g.addLabel
    ? '<button type="button" class="rp-rail-group-add" data-rail-action="group-add"><i class="bi bi-plus"></i>' + esc(g.addLabel) + '</button>'
    : "";
  // `.expanded` shows the body (rail.css); default to expanded, omit it when collapsed.
  return '<div class="rp-rail-group' + (g.collapsed ? "" : " expanded") + '" '
    + 'data-group-id="' + esc(g.id ?? "") + '">'
    + head
    + '<div class="rp-rail-group-body">' + tabs + add + '</div>'
    + '</div>';
}

function tabHTML(t) {
  const ghost = t.ghost
    ? ' rp-rail-tab-ghost' + (t.ghost === "active" ? " rp-rail-tab-ghost-active"
        : t.ghost === "done" ? " rp-rail-tab-ghost-done"
        : t.ghost === "failed" ? " rp-rail-tab-ghost-failed" : "")
    : "";
  return '<button type="button" class="rp-rail-tab' + (t.active ? " active" : "")
    + (t.busy ? " is-busy" : "") + ghost + '" data-rail-action="tab" data-tab-id="' + esc(t.id ?? "") + '">'
    + '<i class="rp-rail-tab-icon bi ' + esc(t.icon || "bi-file-earmark") + '"></i>'
    + '<span class="rp-rail-tab-name">' + esc(t.name || "") + '</span>'
    + (t.busy ? '<span class="rp-rail-tab-spinner"></span>' : "")
    + (t.dot ? '<span class="rp-rail-tab-dot" style="--dot:' + esc(t.dot) + '"></span>' : "")
    + (t.renamable ? '<button class="rp-btn-icon rp-rail-tab-rename" data-rail-action="tab-rename" title="Rename"><i class="bi bi-pencil"></i></button>' : "")
    + (t.hidable ? '<button class="rp-btn-icon rp-rail-tab-hide" data-rail-action="tab-hide" title="Hide"><i class="bi bi-x"></i></button>' : "")
    + '</button>';
}

function hiddenHTML(c) {
  if (!c.hidden?.length) return "";
  const sections = c.hidden.map((s) => {
    const items = (s.items || []).map((it) =>
      '<button type="button" class="rp-rail-hidden-item" data-rail-action="restore" '
      + 'data-restore-id="' + esc(it.id ?? "") + '" data-restore-kind="' + esc(it.kind || "") + '">'
      +   '<span class="rp-rail-hidden-name">' + esc(it.name || "") + '</span>'
      +   (it.meta ? '<span class="rp-rail-hidden-meta">' + esc(it.meta) + '</span>' : "")
      +   '<i class="rp-rail-hidden-restore bi bi-arrow-counterclockwise"></i>'
      + '</button>').join("");
    return '<div class="rp-rail-hidden-section">'
      + (s.title ? '<div class="rp-rail-hidden-title">' + esc(s.title) + '</div>' : "")
      + items + '</div>';
  }).join("");
  return '<details class="rp-rail-hidden">'
    + '<summary class="rp-rail-hidden-summary">Hidden</summary>'
    + '<div class="rp-rail-hidden-body">' + sections + '</div>'
    + '</details>';
}

function footerHTML(c) {
  const f = c.footer || {};
  const upload = f.upload
    ? '<button class="rp-btn-icon rp-btn-icon--glass" data-rail-action="upload" title="' + esc(f.upload.label || "Upload") + '"><i class="bi bi-upload"></i><span>' + esc(f.upload.label || "Upload") + '</span></button>'
    : "";
  const create = f.create
    ? '<button class="rp-btn-icon rp-btn-icon--glass" data-rail-action="create" title="' + esc(f.create.label || "Create") + '"><i class="bi bi-plus-lg"></i><span>' + esc(f.create.label || "Create") + '</span></button>'
    : "";
  return '<div class="rp-rail-footer">' + upload + create + footerNavHTML(f.nav) + '</div>';
}

function footerNavHTML(nav) {
  if (!nav) return "";
  const initials = initialsOf(nav.session);
  const items = FOOTER_NAV.map((n) => {
    const isActive = n.id === nav.active ? " is-active" : "";
    if (n.avatar) {
      return '<a class="rp-rail-footer-nav-item rp-rail-footer-nav-avatar' + isActive + '" '
        + 'href="' + n.hash + '" title="' + esc(n.label) + '">' + esc(initials) + '</a>';
    }
    return '<a class="rp-rail-footer-nav-item' + isActive + '" '
      + 'href="' + n.hash + '" title="' + esc(n.label) + '"><i class="bi ' + n.icon + '"></i></a>';
  }).join("");
  return '<div class="rp-rail-footer-nav" role="navigation" aria-label="Utility">' + items + '</div>';
}

// ── inline rename — swaps the name span for an input, commits on Enter/blur ──
function inlineRename(nameEl, onCommit) {
  if (!nameEl || nameEl.querySelector("input")) return;
  const current = nameEl.textContent;
  nameEl.classList.add(
    nameEl.classList.contains("rp-rail-tab-name") ? "rp-rail-tab-name-editing" : "rp-rail-group-name-editing");
  nameEl.innerHTML = '<input type="text" value="' + esc(current) + '" />';
  const input = nameEl.querySelector("input");
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    nameEl.classList.remove("rp-rail-tab-name-editing", "rp-rail-group-name-editing");
    nameEl.textContent = save && value ? value : current;
    if (save && value && value !== current) onCommit?.(value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

register("rail", mountRail);
