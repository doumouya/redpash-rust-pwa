// /settings — app preferences. Full-bleed page with Home-style float-bar
// chrome (see partials/settings.html). Public surface mirrors /docs: a
// frosted rp-side-nav rail on the left scroll-jumps the article on the
// right, and the open section is reflected in the hash query
// (#/settings?s=files) so links are deep-shareable.
//
// Every control persists to users.prefs via the global rpSavePref helper
// (main.js): localStorage mirror + PATCH /me, shallow-merged server-side.
//
// This UI used to live inside /profile as an embedded "step 2"; the
// per-control wiring is unchanged, only relocated. accent + density are
// folded in from the old standalone settings page and now also persist
// through rpSavePref rather than a one-shot form submit.

import { api }   from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";
import { normalizeObjectTabs, OBJECT_TAB_CATALOG } from "/scripts/objects-catalog.js";

// Mirrors the default accent in styles/main.css :root. Kept here so the
// Reset button works even when no override is stored on the account.
const DEFAULT_ACCENT = "#b3001b";

const SECTIONS = ["appearance", "objects", "files", "sentinels"];

export default async function mount(root, ctx) {
  const nav     = root.querySelector("#settings-nav");
  const content = root.querySelector("#settings-content");

  fillAvatar(root, ctx?.session ?? {});

  // Log out — exposed for the top-right float bar's inline onclick.
  window.doLogout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    location.hash = "#/landing";
    location.reload();
  };

  // ── Section nav — scroll-jump on click, deep-linked via ?s= ─────
  nav.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-section]");
    if (!a) return;
    e.preventDefault();
    const id = a.dataset.section;
    location.hash = `#/settings?s=${id}`;
    markActive(nav, id);
    scrollToSection(content, id, true);
  });

  // ── Scroll-spy — light the rail entry for the section in view ───
  // A thin horizontal band (rootMargin) near the top of the article
  // decides which section is "current"; tall sections that never reach
  // a high intersectionRatio still resolve cleanly.
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      const entering = entries.filter((e) => e.isIntersecting);
      if (entering.length) {
        markActive(nav, entering[entering.length - 1].target.id.replace("section-", ""));
      }
    }, { root: content, rootMargin: "-45% 0px -50% 0px", threshold: 0 });
    SECTIONS.forEach((id) => {
      const el = content.querySelector(`#section-${id}`);
      if (el) io.observe(el);
    });
  }

  // ── Load /me — hydrate every control from the account ───────────
  // SWR: paint from cache instantly, then await fresh and re-hydrate.
  let me = null;
  const { cached, fresh } = api.getCached("/me");
  if (cached) me = cached;
  try { me = await fresh; }
  catch (err) {
    if (!me) { toast.error("Failed to load settings."); return; }
    // else: keep the cached hydrate; next mount retries the fetch.
  }

  wireAppearance(root, me);
  wireLanguage(root);
  wirePrefGroups(root);
  wirePosPickers(root);
  wireObjectTabsPicker(root, me).catch(() => {});
  wireObjectViewsList(root, me).catch(() => {});
  wireSentinelSettings(root, me).catch(() => {});
  // Sync the bg-preview toggle's visual state now that the DOM is here.
  window.rpRestoreBgPreview?.();

  // Jump to the section named in the hash query (#/settings?s=files).
  const start = currentSection() ?? "appearance";
  markActive(nav, start);
  if (start !== "appearance") scrollToSection(content, start, false);

  // Tier 2 E — warm the list endpoints so navigating back out
  // (Home / Objects / Profile) paints instantly.
  api.prewarm(["/projects", "/files", "/reports", "/dashboards", "/users", "/companies"]);
}

// ── Section-nav helpers ───────────────────────────────────────────
function currentSection() {
  const m = location.hash.match(/[?&]s=([^&]+)/);
  const s = m ? decodeURIComponent(m[1]) : null;
  return SECTIONS.includes(s) ? s : null;
}
function scrollToSection(content, id, smooth) {
  content.querySelector(`#section-${id}`)?.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    block: "start",
  });
}
function markActive(nav, id) {
  nav.querySelectorAll("a[data-section]").forEach((a) => {
    a.classList.toggle("is-active", a.dataset.section === id);
  });
}

// ── Appearance — theme switcher + accent + density ────────────────
function wireAppearance(root, me) {
  // Theme 3-state switcher — buttons fire rpSetTheme via inline onclick;
  // here we only keep the .active state in sync, including when the
  // float-bar toggle flips <html data-theme> from outside this group.
  syncThemeActive(root);
  new MutationObserver(() => syncThemeActive(root))
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // Accent colour — live-applies while picking, persists on commit.
  // `null` is stored when the value matches the default so the account
  // pref stays empty (shallow merge can't unset, so we write null).
  const accent = root.querySelector("#settings-accent");
  const reset  = root.querySelector("#settings-accent-reset");
  if (accent) {
    accent.value = me.prefs?.accent || DEFAULT_ACCENT;
    accent.addEventListener("input",  () => applyAccent(accent.value));
    accent.addEventListener("change", () => {
      const v = accent.value;
      window.rpSavePref?.("accent", v.toLowerCase() === DEFAULT_ACCENT ? null : v);
    });
  }
  if (reset && accent) {
    reset.addEventListener("click", () => {
      accent.value = DEFAULT_ACCENT;
      applyAccent(null);
      window.rpSavePref?.("accent", null);
    });
  }

  // Table density — single-select pill group.
  const density = me.prefs?.density || "comfortable";
  root.querySelectorAll("#settings-density .rp-set-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === density);
    btn.addEventListener("click", () => {
      root.querySelectorAll("#settings-density .rp-set-opt")
        .forEach((p) => p.classList.toggle("active", p === btn));
      window.rpSavePref?.("density", btn.dataset.value);
    });
  });
}

function applyAccent(value) {
  const s = document.documentElement.style;
  if (value) {
    s.setProperty("--rp-accent", value);
    s.setProperty("--accent",    value);
  } else {
    s.removeProperty("--rp-accent");
    s.removeProperty("--accent");
  }
}

function syncThemeActive(root) {
  const cur = document.documentElement.getAttribute("data-theme") || "system";
  root.querySelectorAll(".rp-theme-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === cur);
  });
}

// ── Language pills ────────────────────────────────────────────────
// localStorage is seeded from the account at login (main.js
// seedPrefsToLocalStorage), so reading it gives the saved choice;
// rpSavePref writes both localStorage AND the account.
function wireLanguage(root) {
  const lang = localStorage.getItem("redpash-lang") || "en";
  root.querySelectorAll("#settings-lang .rp-set-opt").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
    btn.addEventListener("click", () => {
      const choice = btn.dataset.lang;
      window.rpSavePref?.("language", choice);
      root.querySelectorAll("#settings-lang .rp-set-opt").forEach((p) => {
        p.classList.toggle("active", p === btn);
      });
      toast.info(`Language set to ${choice.toUpperCase()} — refresh /landing to see translations apply.`);
    });
  });
}

// ── File-handling option groups (delimiter / encoding / export) ───
// Each group persists its chosen `data-value` to the account via
// rpSavePref. localStorage (seeded from the account at login) holds
// the restore value so the saved choice shows on any browser.
function wirePrefGroups(root) {
  const PREF_GROUPS = [
    { sel: "#settings-delimiter",     key: "rp-default-delimiter", pref: "default_delimiter" },
    { sel: "#settings-encoding",      key: "rp-default-encoding",  pref: "default_encoding"  },
    { sel: "#settings-export-format", key: "rp-export-format",     pref: "export_format"     },
  ];
  PREF_GROUPS.forEach(({ sel, key, pref }) => {
    const opts = root.querySelectorAll(`${sel} .rp-set-opt`);
    if (!opts.length) return;
    let saved = null;
    try { saved = localStorage.getItem(key); } catch {}
    if (saved) {
      opts.forEach((p) => p.classList.toggle("active", p.dataset.value === saved));
    }
    opts.forEach((btn) => {
      btn.addEventListener("click", () => {
        opts.forEach((p) => p.classList.toggle("active", p === btn));
        window.rpSavePref?.(pref, btn.dataset.value);
      });
    });
  });
}

// ── Float-bar position pickers (topbar + footer) ──────────────────
// The class swap + persistence lives in main.js (rpSetBarPos); this
// just toggles the active pill and dispatches to the shell.
function wirePosPickers(root) {
  const wire = (groupSel, rail, fallback) => {
    const saved = (() => {
      try { return localStorage.getItem(`rp-${rail}bar-pos`) ?? fallback; }
      catch { return fallback; }
    })();
    root.querySelectorAll(`${groupSel} .rp-set-opt`).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pos === saved);
      btn.addEventListener("click", () => {
        root.querySelectorAll(`${groupSel} .rp-set-opt`)
          .forEach((p) => p.classList.toggle("active", p === btn));
        window.rpSetBarPos?.(rail, btn.dataset.pos);
      });
    });
  };
  wire("#settings-topbar-pos", "top",    "r");
  wire("#settings-footer-pos", "bottom", "l");
}

// ── Object-tabs picker ────────────────────────────────────────────
// Same pref (prefs.objects_tabs) as the inline ×/+/drag on the Objects
// page, so both surfaces stay in sync. Multi-select: toggle each pill;
// at least one tab must stay on. Active pills are draggable — order
// maps to the visual order of the tabs on the Objects page.
async function wireObjectTabsPicker(root, me) {
  const grp = root.querySelector("#settings-object-tabs");
  if (!grp) return;
  const allOpts = [...grp.querySelectorAll(".rp-set-opt")];
  if (!allOpts.length) return;

  let order = normalizeObjectTabs(me.prefs?.objects_tabs);

  const reorderDom = () => {
    const activeSet = new Set(order);
    const sorted = [...allOpts].sort((a, b) => {
      const ai = order.indexOf(a.dataset.key);
      const bi = order.indexOf(b.dataset.key);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return allOpts.indexOf(a) - allOpts.indexOf(b);
    });
    sorted.forEach((el) => grp.appendChild(el));
    allOpts.forEach((b) => b.classList.toggle("active", activeSet.has(b.dataset.key)));
  };

  allOpts.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.justDragged === "1") { delete btn.dataset.justDragged; return; }
      const key = btn.dataset.key;
      const isOn = order.includes(key);
      if (isOn && order.length === 1) {
        toast.info("Keep at least one object tab.");
        return;
      }
      if (isOn) order = order.filter((k) => k !== key);
      else      order.push(key);
      window.rpSavePref?.("objects_tabs", order);
      reorderDom();
    });
  });

  let _dragKey = null;
  const setDraggable = () => {
    const activeSet = new Set(order);
    allOpts.forEach((b) => {
      const isActive = activeSet.has(b.dataset.key);
      b.draggable = isActive;
      if (!isActive) return;
      b.addEventListener("dragstart", onStart);
      b.addEventListener("dragover",  onOver);
      b.addEventListener("dragleave", onLeave);
      b.addEventListener("drop",      onDrop);
      b.addEventListener("dragend",   onEnd);
    });
  };
  const onStart = (e) => {
    const b = e.currentTarget;
    _dragKey = b.dataset.key;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", _dragKey); } catch {}
    b.classList.add("obj-tab-drag");
    b.dataset.justDragged = "1";
  };
  const onOver = (e) => {
    if (!_dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const b = e.currentTarget;
    if (b.dataset.key !== _dragKey) b.classList.add("obj-tab-drop");
  };
  const onLeave = (e) => e.currentTarget.classList.remove("obj-tab-drop");
  const onEnd = () => {
    grp.querySelectorAll(".obj-tab-drag, .obj-tab-drop")
       .forEach((el) => el.classList.remove("obj-tab-drag", "obj-tab-drop"));
    _dragKey = null;
  };
  const onDrop = (e) => {
    e.preventDefault();
    const targetKey = e.currentTarget.dataset.key;
    const sourceKey = _dragKey;
    onEnd();
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    if (!order.includes(targetKey)) return;
    order = order.filter((k) => k !== sourceKey);
    const insertAt = order.indexOf(targetKey);
    order.splice(insertAt, 0, sourceKey);
    window.rpSavePref?.("objects_tabs", order);
    reorderDom();
    setDraggable();
  };

  reorderDom();
  setDraggable();
}

// ── Cleanness vocabulary — personal sentinel list + share toggle ──
// Mirror of the Cleaner Fix-invalid modal's two prefs:
//   prefs.learned_sentinels (canonical string[])
//   prefs.share_sentinels   (bool | null)
// Plus the cross-user global_sentinels set (read-only) for provenance.
async function wireSentinelSettings(root, me) {
  const list  = root.querySelector("#settings-sentinels-list");
  const share = root.querySelector("#settings-share-sentinels");
  if (!list || !share) return;

  const learned = new Set(
    (Array.isArray(me.prefs?.learned_sentinels) ? me.prefs.learned_sentinels : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean),
  );
  const global = new Set(
    (Array.isArray(me.global_sentinels) ? me.global_sentinels : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean),
  );
  let consent = me.prefs?.share_sentinels;
  if (consent !== true && consent !== false) consent = null;

  const provenance = (canon) => {
    if (global.has(canon)) return ["global", "rp-sent-chip-prov--global"];
    if (consent === true)  return ["submitted", "rp-sent-chip-prov--submitted"];
    return ["learned", "rp-sent-chip-prov--learned"];
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));

  const renderList = () => {
    if (!learned.size) {
      list.innerHTML = `<div class="rp-sentinels-empty" style="font-size:0.75rem;color:var(--muted)">No personal sentinels yet — add them via the Cleaner's Fix invalid values modal.</div>`;
      return;
    }
    list.innerHTML = [...learned].sort().map((canon) => {
      const [provLbl] = provenance(canon);
      const title = provLbl === "global"
        ? "In the global vocabulary (≥2 users flagged it)"
        : provLbl === "submitted"
          ? "Submitted — will join the global vocabulary after 1 more user flags it"
          : "Personal-only — sharing is off";
      return `<span class="rp-sent-chip">
        <span class="rp-sent-chip-val">${esc(canon)}</span>
        <span class="rp-sent-chip-prov rp-sent-chip-prov--${provLbl}" title="${esc(title)}">${provLbl}</span>
        <button type="button" class="rp-sent-chip-rm" data-canon="${esc(canon)}" title="Remove from your personal list" aria-label="Remove ${esc(canon)}">×</button>
      </span>`;
    }).join("");
    list.querySelectorAll(".rp-sent-chip-rm").forEach((btn) => {
      btn.addEventListener("click", () => {
        const canon = btn.dataset.canon;
        if (!canon || !learned.delete(canon)) return;
        window.rpSavePref?.("learned_sentinels", [...learned]);
        renderList();
      });
    });
  };
  renderList();

  const setActive = () => {
    share.querySelectorAll(".rp-set-opt").forEach((b) => {
      const matches = (b.dataset.value === "true"  && consent === true)
                   || (b.dataset.value === "false" && consent === false);
      b.classList.toggle("active", matches);
    });
  };
  setActive();
  share.querySelectorAll(".rp-set-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.value === "true";
      if (next === consent) return;
      consent = next;
      setActive();
      window.rpSavePref?.("share_sentinels", consent);
      renderList();
    });
  });
}

// ── Saved tab views — one row per Objects-page tab ────────────────
// Reads prefs.objects_views (map keyed by tab kind). The Objects page
// writes this on every column/sort/page change; here we surface the
// current value and let the user reset a tab's view.
async function wireObjectViewsList(root, me) {
  const list = root.querySelector("#settings-views-list");
  if (!list) return;
  const views = { ...(me.prefs?.objects_views && typeof me.prefs.objects_views === "object"
                       ? me.prefs.objects_views
                       : {}) };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));

  const sortIcon = (dir) => dir === "desc" ? "bi-arrow-down"
                          : dir === "asc"  ? "bi-arrow-up"
                          : "bi-arrow-down-up";

  const summaryChips = (v) => {
    if (!v || typeof v !== "object") {
      return `<span class="rp-view-default">Default view</span>`;
    }
    const chips = [];
    const visible = Array.isArray(v.visibleCols) ? v.visibleCols.length : null;
    if (visible != null) {
      chips.push(`<span class="rp-view-chip" title="${visible} visible column${visible === 1 ? "" : "s"}">
        <i class="bi bi-layout-three-columns"></i>${visible}
      </span>`);
    }
    if (v.rowsPerPage) {
      chips.push(`<span class="rp-view-chip" title="${v.rowsPerPage} rows per page">
        <i class="bi bi-stack"></i>${v.rowsPerPage}
      </span>`);
    }
    if (Array.isArray(v.sorts) && v.sorts.length) {
      const first = v.sorts[0];
      const extra = v.sorts.length > 1 ? `<sup>+${v.sorts.length - 1}</sup>` : "";
      chips.push(`<span class="rp-view-chip" title="Sorted by ${first.col} (${first.dir})${v.sorts.length > 1 ? ` and ${v.sorts.length - 1} more` : ""}">
        <i class="bi ${sortIcon(first.dir)}"></i>${esc(first.col)}${extra}
      </span>`);
    }
    if (v.dateFmt && v.dateFmt !== "auto") {
      chips.push(`<span class="rp-view-chip" title="Date format: ${v.dateFmt}">
        <i class="bi bi-calendar3"></i>${esc(v.dateFmt)}
      </span>`);
    }
    if (v.showRowNums) {
      chips.push(`<span class="rp-view-chip" title="Row numbers shown">
        <i class="bi bi-list-ol"></i>
      </span>`);
    }
    return chips.length ? chips.join("") : `<span class="rp-view-default">Default view</span>`;
  };

  const renderList = () => {
    list.innerHTML = OBJECT_TAB_CATALOG.map((tab) => {
      const v = views[tab.key];
      const isSet = !!v && typeof v === "object";
      return `<div class="rp-view-row${isSet ? " is-set" : ""}" data-key="${esc(tab.key)}">
        <div class="rp-view-head">
          <i class="bi ${esc(tab.icon)} rp-view-icon"></i>
          <span class="rp-view-name">${esc(tab.label)}</span>
          ${isSet
            ? `<button type="button" class="rp-view-rm" data-key="${esc(tab.key)}" title="Reset ${esc(tab.label)} to the default view">Reset</button>`
            : ``}
        </div>
        <div class="rp-view-sum">${summaryChips(v)}</div>
      </div>`;
    }).join("");
    list.querySelectorAll(".rp-view-rm").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.key;
        if (!k || !(k in views)) return;
        delete views[k];
        window.rpSavePref?.("objects_views", views);
        renderList();
        toast.success(`${OBJECT_TAB_CATALOG.find((t) => t.key === k)?.label ?? k} view reset.`);
      });
    });
  };
  renderList();
}

// Top-left float avatar — initials from the session, photo when set.
// Mirrors docs.js: a photo (when present) becomes a background-image so
// the library's background-size:cover crops it square inside the circle.
function fillAvatar(root, session) {
  const avatar = root.querySelector("#settings-avatar");
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
