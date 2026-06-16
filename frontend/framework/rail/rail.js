/* rail — the page's left navigation: a data-driven two-level group/tab strip
   ported from the predecessor (CAS_37B2E1BF) into redpash-next conventions.
   A group = a container (project / status bucket); a tab = a leaf (file / case).
   The rail owns its own structure + behavior ("lego brick"): pages supply a
   config of data + handlers, the builder emits the whole rp-rail-* DOM.

   mountRail(host, config) -> { el, setGroups(groups, hidden, emptyText),
                                setActive(id), destroy() }

   config = {
     title?, collapsed?=false,
     search?:   { placeholder?, onInput(q) },
     overview?: { label, icon?, active? },
     groups:    [{ id, name, mark?, count?, collapsed?, renamable?, hidable?,
                   addLabel?, tabs:[{ id, name, icon?, dot?, active?, renamable?,
                   hidable?, actions?:[{action, icon, title}] }] }],
     hidden?:   [{ title, items:[{ id, kind, name, meta? }] }],
     footer?:   { create?:{label}, universals?:{ profileInitials, themeLabel, activeId? } },
     on: { tab, tabRename, tabHide, groupToggle, groupRename, groupHide, groupAdd,
           overview, restore, create, theme, settings, signOut, profile,
           collapseToggle, [customAction] },
   }

   Composes the atoms (button, input) rather than re-declaring their classes —
   every rp-rail-* class is owned solely by rail.css (ui-fork-audit R4). Collapse
   to the icon-rail (`.compact`) is driven from OUTSIDE via the handle's
   toggleCollapse (the topbar's sidebar button); the `@media` overlay drawer in
   rail.css is a separate narrow-viewport behavior. */

import { el, esc } from "../boot/dom.js";
import { button, input } from "../atoms/atoms.js";
import { register } from "../registry/component-registry.js";

/** Build + wire the rail into `host`. `host` is the page slot; the rail's own
 *  `<aside class="rp-rail">` is created inside it and returned as `el`. */
export function mountRail(host, config = {}) {
  if (!host) return null;
  const on = config.on || {};

  const rail = el("aside", { class: "rp-rail" + (config.collapsed ? " compact" : "") });

  // ── static chrome (search) — built once, never re-rendered. No title: the
  //    page name lives in the topbar, so the rail goes straight to its content.
  if (config.search) rail.append(searchEl(config));

  // ── body (overview + groups + hidden) — re-rendered by setGroups ───────────
  const body = el("div", { class: "rp-rail-body" });
  rail.append(body);
  renderBody(body, config, config.groups || [], config.hidden, null);

  // ── footer (create + universals) — built once ──────────────────────────────
  if (config.footer) rail.append(footerEl(config, on));

  // Collapse to/from the icon-only strip. `want` omitted ⇒ toggle. Reports the
  // new state (rail-data persists it). The topbar's sidebar button drives this
  // via the handle's toggleCollapse — the rail has no chevron of its own.
  function setCompact(want) {
    const isCompact = want ?? !rail.classList.contains("compact");
    rail.classList.toggle("compact", isCompact);
    on.collapseToggle?.(isCompact);
    return isCompact;
  }

  // ── narrow-viewport drawer (≤ --rp-bp-md, 64rem): the SAME topbar sidebar
  //    toggle opens the rail as an off-canvas drawer + scrim here, instead of
  //    the desktop icon-rail. matchMedia is event-driven (no width polling);
  //    classList only (no inline styles). The drawer state is transient — it is
  //    NOT persisted as rail.collapsed. ───────────────────────────────────────
  const narrow = window.matchMedia("(max-width: 64rem)"); // --rp-bp-md
  const scrim = el("div", { class: "rp-rail-scrim" });
  const setDrawer = (open) => {
    rail.classList.toggle("is-open", open);
    scrim.classList.toggle("is-open", open);
  };
  scrim.addEventListener("click", () => setDrawer(false));
  // Crossing back to wide drops any drawer state (the rail becomes the sidebar).
  const onNarrowChange = (e) => { if (!e.matches) setDrawer(false); };
  narrow.addEventListener("change", onNarrowChange);
  // After a navigation in drawer mode, close so the surface is visible.
  const closeDrawerIfNarrow = () => { if (narrow.matches) setDrawer(false); };

  // ── ONE delegated click handler, routed by data-rail-action. Survives the
  //    wholesale body re-render in setGroups because it lives on the root. ─────
  rail.addEventListener("click", (e) => {
    const elx = e.target.closest("[data-rail-action]");
    if (!elx || !rail.contains(elx)) return;
    const action = elx.dataset.railAction;

    const tabEl = elx.closest(".rp-rail-tab");
    const groupEl = elx.closest(".rp-rail-group");
    const tabId = tabEl?.dataset.tabId;
    const groupId = groupEl?.dataset.groupId;

    switch (action) {
      case "overview":
        e.preventDefault();
        on.overview?.();
        closeDrawerIfNarrow();
        return;
      case "group-toggle": {
        e.preventDefault();
        // rail.css shows the body via `.expanded`; toggling reports the new
        // *collapsed* state (the inverse of expanded) to the orchestrator.
        const expanded = groupEl.classList.toggle("expanded");
        on.groupToggle?.(groupId, !expanded);
        return;
      }
      case "group-rename":
        e.stopPropagation();
        inlineRename(groupEl.querySelector(".rp-rail-group-name"),
          (v) => on.groupRename?.(groupId, v));
        return;
      case "group-hide":
        e.stopPropagation();
        on.groupHide?.(groupId);
        return;
      case "group-add":
        e.stopPropagation();
        on.groupAdd?.(groupId);
        return;
      case "tab":
        e.preventDefault();
        on.tab?.(tabId, groupId);
        closeDrawerIfNarrow();
        return;
      case "tab-rename":
        e.stopPropagation();
        inlineRename(tabEl.querySelector(".rp-rail-tab-name"),
          (v) => on.tabRename?.(tabId, v));
        return;
      case "tab-hide":
        e.stopPropagation();
        on.tabHide?.(tabId);
        return;
      case "restore":
        e.preventDefault();
        on.restore?.(elx.dataset.restoreId, elx.dataset.restoreKind);
        return;
      case "create":
        on.create?.();
        return;
      case "theme":
        on.theme?.();
        return;
      case "settings":
        on.settings?.();
        return;
      case "signOut":
        on.signOut?.();
        return;
      case "profile":
        on.profile?.();
        return;
      // Custom per-row / per-group actions (e.g. a tab's "visualize"): listed
      // in a tab's `actions`, dispatched by action name to on[action].
      default:
        e.stopPropagation();
        on[action]?.(tabId, groupId);
    }
  });

  // ── search wiring: live filter + inline auto-complete with ↑↓ match cycling ─
  // onInput filters the tree (re-rendering it); we then collect the PREFIX
  // matches among the rendered items (groups + leaf tabs, display order). These
  // are the type-ahead targets: forward typing completes to the first, ↑↓ walk
  // the rest, Enter opens the active one (a file), Esc clears. The completion is
  // a SELECTED suffix, so the next keystroke overwrites it and Backspace clears
  // just the completion — never the typed text.
  const searchBox = rail.querySelector(".rp-rail-search");
  const searchInput = searchBox?.querySelector("input");
  if (searchInput && config.search?.onInput) {
    let typedPrefix = ""; // what the user actually typed (drives the completion)
    let matchEls = []; // [{ el, name, kind }] prefix matches, DOM order
    let cursor = -1;

    const collectMatches = (prefix) => {
      const p = prefix.toLowerCase();
      const out = [];
      if (!p) return out;
      for (const g of rail.querySelectorAll(".rp-rail-body > .rp-rail-group")) {
        const gn = g.querySelector(".rp-rail-group-name")?.textContent || "";
        if (gn.toLowerCase().startsWith(p)) {
          out.push({ el: g.querySelector(".rp-rail-group-head"), name: gn, kind: "group" });
        }
        for (const t of g.querySelectorAll(".rp-rail-tab")) {
          const tn = t.querySelector(".rp-rail-tab-name")?.textContent || "";
          if (tn.toLowerCase().startsWith(p)) out.push({ el: t, name: tn, kind: "tab" });
        }
      }
      return out;
    };

    const clearCursor = () =>
      rail.querySelector(".rp-rail-tab.is-cursor, .rp-rail-group-head.is-cursor")
        ?.classList.remove("is-cursor");

    const paintCursor = () => {
      clearCursor();
      if (cursor < 0 || cursor >= matchEls.length) return;
      const m = matchEls[cursor];
      m.el?.classList.add("is-cursor");
      m.el?.scrollIntoView({ block: "nearest" });
      if (m.name.length > typedPrefix.length) {
        searchInput.value = typedPrefix + m.name.slice(typedPrefix.length); // keep typed case
        searchInput.setSelectionRange(typedPrefix.length, m.name.length);
      }
    };

    searchInput.addEventListener("input", (e) => {
      typedPrefix = searchInput.value;
      config.search.onInput(typedPrefix.trim()); // filters + re-renders the tree
      matchEls = collectMatches(typedPrefix.trim());
      // complete to the first match on FORWARD typing only (never delete/paste).
      cursor = e.inputType === "insertText" && matchEls.length ? 0 : -1;
      paintCursor();
    });

    searchInput.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matchEls.length) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        cursor = cursor < 0
          ? (step > 0 ? 0 : matchEls.length - 1)
          : (cursor + step + matchEls.length) % matchEls.length;
        paintCursor();
      } else if (e.key === "Enter" && cursor >= 0 && matchEls[cursor]) {
        e.preventDefault();
        // a leaf (file) opens via its delegated click; a group has no open
        // action — the completion already named it and the list is narrowed.
        if (matchEls[cursor].kind === "tab") matchEls[cursor].el.click();
      } else if (e.key === "Escape") {
        clearCursor();
        cursor = -1;
        searchInput.blur();
      }
    });

    searchInput.addEventListener("blur", clearCursor);
  }
  // In the collapsed icon-rail the field is hidden and only the search icon
  // shows; clicking it expands the rail and focuses the field.
  searchBox?.addEventListener("click", () => {
    if (!rail.classList.contains("compact")) return;
    setCompact(false);
    searchInput?.focus();
  });

  host.append(rail);
  host.append(scrim);

  return {
    el: rail,
    /** Re-render the body (overview + groups + hidden) in place after a data
     *  change. `emptyText` shows a `.rp-rail-state` line when groups is empty
     *  (e.g. a filter matched nothing) — distinct from a load error. */
    setGroups(groups, hidden, emptyText) {
      renderBody(body, config, groups || [], hidden, emptyText);
    },
    /** Open/close the rail from outside (the topbar's sidebar toggle). Below
     *  --rp-bp-md it drives the off-canvas DRAWER (transient); above, the
     *  desktop `.compact` icon-rail (persisted). `want` omitted ⇒ toggle. */
    toggleCollapse(want) {
      if (narrow.matches) {
        const open = want ?? !rail.classList.contains("is-open");
        setDrawer(open);
        return open;
      }
      return setCompact(want);
    },
    /** Flip the active tab highlight without a full rebuild. */
    setActive(id) {
      for (const t of rail.querySelectorAll(".rp-rail-tab.active")) {
        t.classList.remove("active");
      }
      const next = rail.querySelector(
        `.rp-rail-tab[data-tab-id="${cssEscape(String(id ?? ""))}"]`);
      next?.classList.add("active");
    },
    destroy() {
      narrow.removeEventListener("change", onNarrowChange);
      scrim.remove();
      rail.remove();
    },
  };
}

// ── body renderer (overview + groups + hidden), used on mount + setGroups ────
function renderBody(body, config, groups, hidden, emptyText) {
  const children = [];
  if (config.overview) children.push(overviewEl(config.overview));
  for (const g of groups) children.push(groupEl(g));
  if (!groups.length && emptyText) {
    children.push(el("div", { class: "rp-rail-state" }, emptyText));
  }
  const hiddenEl = hidden ?? config.hidden;
  if (hiddenEl?.length) children.push(hiddenDrawerEl(hiddenEl));
  body.replaceChildren(...children);
}

// ── search: composes the input atom inside a rail-owned wrapper ──────────────
function searchEl(c) {
  const box = el("div", { class: "rp-rail-search" },
    el("i", { class: "bi bi-search rp-rail-search-icon" }),
    input({ type: "search", placeholder: c.search.placeholder || "Filter…" }),
  );
  return el("div", { class: "rp-rail-filter" }, box);
}

// ── overview: a pinned pseudo-tab above the groups ───────────────────────────
function overviewEl(o) {
  return el("div", { class: "rp-rail-overview" },
    el("button", {
      class: "rp-rail-tab" + (o.active ? " active" : ""),
      type: "button",
      "data-rail-action": "overview",
    },
      el("i", { class: "rp-rail-tab-icon bi " + (o.icon || "bi-grid-1x2") }),
      el("span", { class: "rp-rail-tab-name" }, o.label || "Overview"),
    ),
  );
}

// ── group: caret + mark + name + count + rename/hide affordances + tabs ──────
function markInitials(g) {
  if (g.initials) return g.initials;
  return ((g.name || "?").trim().split(/\s+/).map((w) => w[0]).join("") || "?")
    .slice(0, 2).toUpperCase();
}

function groupEl(g) {
  const head = el("div", {
    class: "rp-rail-group-head",
    "data-rail-action": "group-toggle",
  },
    el("i", { class: "rp-rail-group-caret bi bi-chevron-down" }),
    g.mark
      ? el("span", { class: "rp-rail-group-mark", style: "--mark:" + esc(g.mark) },
          markInitials(g))
      : null,
    el("span", { class: "rp-rail-group-name" }, g.name || ""),
    Number.isFinite(g.count)
      ? el("span", { class: "rp-rail-group-count" }, String(g.count))
      : null,
    g.renamable
      ? affordance("rp-rail-group-rename", "group-rename", "bi-pencil", "Rename")
      : null,
    g.hidable
      ? affordance("rp-rail-group-hide", "group-hide", "bi-eye-slash", "Hide")
      : null,
  );

  const tabs = (g.tabs || []).map(tabEl);
  if (g.addLabel) {
    tabs.push(el("button", {
      class: "rp-rail-group-add",
      type: "button",
      "data-rail-action": "group-add",
    }, el("i", { class: "bi bi-plus" }), g.addLabel));
  }

  // `.expanded` shows the body (rail.css); default to expanded, omit when collapsed.
  return el("div", {
    class: "rp-rail-group" + (g.collapsed ? "" : " expanded"),
    "data-group-id": esc(g.id ?? ""),
  },
    head,
    el("div", { class: "rp-rail-group-body" }, ...tabs),
  );
}

// ── tab: icon + name + per-row actions + dot + rename/hide affordances ───────
function tabEl(t) {
  const actions = (t.actions || []).map((a) =>
    el("span", {
      class: "rp-rail-tab-" + (a.cls || a.action),
      "data-rail-action": a.action,
      title: a.title || "",
    }, el("i", { class: "bi " + (a.icon || "") })),
  );

  return el("button", {
    class: "rp-rail-tab" + (t.active ? " active" : ""),
    type: "button",
    "data-rail-action": "tab",
    "data-tab-id": esc(t.id ?? ""),
    title: t.title || null,
  },
    el("i", { class: "rp-rail-tab-icon bi " + (t.icon || "bi-file-earmark") }),
    el("span", { class: "rp-rail-tab-name" }, t.name || ""),
    ...actions,
    t.dot ? el("span", { class: "rp-rail-tab-dot " + t.dot }) : null,
    t.renamable
      ? affordance("rp-rail-tab-rename", "tab-rename", "bi-pencil", "Rename")
      : null,
    t.hidable
      ? affordance("rp-rail-tab-hide", "tab-hide", "bi-x", "Hide")
      : null,
  );
}

// Bare <span> affordance (NOT <button> — the tab is itself a button; nested
// buttons are invalid). Hover-fades in via rail.css.
function affordance(cls, action, icon, title) {
  return el("span", { class: cls, "data-rail-action": action, title },
    el("i", { class: "bi " + icon }));
}

// ── "Hidden (N)" restore drawer ──────────────────────────────────────────────
function hiddenDrawerEl(hidden) {
  const count = hidden.reduce((n, s) => n + (s.items?.length || 0), 0);
  const sections = hidden.map((s) =>
    el("div", { class: "rp-rail-hidden-section" },
      s.title ? el("div", { class: "rp-rail-hidden-title" }, s.title) : null,
      ...(s.items || []).map((it) =>
        el("button", {
          class: "rp-rail-hidden-item",
          type: "button",
          "data-rail-action": "restore",
          "data-restore-id": esc(it.id ?? ""),
          "data-restore-kind": esc(it.kind || ""),
        },
          el("span", { class: "rp-rail-hidden-name" }, it.name || ""),
          it.meta ? el("span", { class: "rp-rail-hidden-meta" }, it.meta) : null,
          el("i", { class: "rp-rail-hidden-restore bi bi-arrow-counterclockwise" }),
        ),
      ),
    ),
  );
  return el("details", { class: "rp-rail-hidden" },
    el("summary", { class: "rp-rail-hidden-summary" },
      el("i", { class: "bi bi-eye-slash" }), " Hidden (" + count + ")"),
    el("div", { class: "rp-rail-hidden-body" }, ...sections),
  );
}

// ── footer: contextual create button + the universals cluster ────────────────
function footerEl(c, on) {
  const f = c.footer || {};
  const children = [];

  if (f.create) {
    const create = button({ label: f.create.label || "Create", variant: "accent" });
    create.classList.add("rp-rail-footer-create");
    create.dataset.railAction = "create";
    // The delegated root handler owns the click; the atom's own onClick is unset.
    children.push(create);
  }

  if (f.universals) {
    children.push(universalsEl(f.universals));
  }

  return el("div", { class: "rp-rail-footer" }, ...children);
}

function universalsEl(u) {
  const active = u.activeId;
  const item = (id, icon, title) =>
    el("button", {
      class: "rp-rail-footer-nav-item" + (active === id ? " is-active" : ""),
      type: "button",
      "data-rail-action": id,
      title,
      "aria-label": title,
    }, el("i", { class: "bi " + icon }));

  const profile = el("button", {
    class: "rp-rail-footer-nav-item rp-rail-footer-nav-avatar"
      + (active === "profile" ? " is-active" : ""),
    type: "button",
    "data-rail-action": "profile",
    title: "Profile",
    "aria-label": "Profile",
  }, u.profileInitials || "··");

  return el("div", {
    class: "rp-rail-footer-nav",
    role: "navigation",
    "aria-label": "Utility",
  },
    profile,
    item("settings", "bi-gear", "Settings"),
    item("theme", "bi-circle-half", u.themeLabel || "Theme"),
    item("signOut", "bi-box-arrow-right", "Sign out"),
  );
}

// ── inline rename — swaps the name span for an input, commits on Enter/blur,
//    reverts on Esc; empty/unchanged reverts silently. (Ported verbatim.) ─────
function inlineRename(nameEl, onCommit) {
  if (!nameEl || nameEl.querySelector("input")) return;
  const current = nameEl.textContent;
  const isTab = nameEl.classList.contains("rp-rail-tab-name");
  nameEl.classList.add(isTab ? "rp-rail-tab-name-editing" : "rp-rail-group-name-editing");

  const field = el("input", { type: "text" });
  field.value = current;
  nameEl.replaceChildren(field);
  field.focus();
  field.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const value = field.value.trim();
    nameEl.classList.remove("rp-rail-tab-name-editing", "rp-rail-group-name-editing");
    nameEl.textContent = save && value ? value : current;
    if (save && value && value !== current) onCommit?.(value);
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  field.addEventListener("blur", () => commit(true));
}

// Minimal CSS.escape fallback for the setActive attribute selector (ids are
// app-controlled tokens, but quote-safe just in case).
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}

register("rail", mountRail);
