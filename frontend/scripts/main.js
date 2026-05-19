// ─────────────────────── RedPash router ───────────────────────
//
// Hash-based SPA router. Why hash and not History API?
//   • Works offline from the service worker without rewriting every URL.
//   • No server-side fallback needed — Axum's ServeDir always returns
//     index.html for `/`, and the hash carries the route.
//
// Each route declares:
//   path     hash fragment ("#/home" → "/home")
//   partial  HTML file fetched into #app
//   script   JS module dynamically imported (its default export is
//            called with the mounted node)
//   css      optional per-page stylesheet, swapped on navigation
//   auth     true → bounce to "#/landing" if user is not signed in
//
// The route table is the single source of truth; the topbar nav is
// derived from it (see renderTopbar).

import { api } from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";

// chrome:
//   "default" (or unset) → app shell (topbar + gutter padding around #app)
//   "full"               → no topbar, #app claims the viewport edge-to-edge.
//                          Used by full-bleed surfaces (landing, home).
const ROUTES = [
  { path: "/landing",    partial: "/partials/landing.html",    script: "/scripts/pages/landing.js",    auth: false, hidden: true, css: "/styles/pages/landing.css", chrome: "full" },
  { path: "/home",       partial: "/partials/home.html",       script: "/scripts/pages/home.js",       auth: true,  label: "Home",       css: "/styles/pages/home.css", chrome: "full" },
  // Cleaner — URL is #/cleaner?project=PRJ_… or #/cleaner?file=FIL_….
  // (Django used /project/:id/clean as a path; we keep the query-string
  // form here so the hash router stays flat and the cleaner module can
  // accept either entry point via URLSearchParams.)
  { path: "/cleaner",    partial: "/partials/cleaner.html",    script: "/scripts/pages/cleaner.js",    auth: true,  label: "Cleaner",    css: "/styles/pages/cleaner.css", chrome: "full" },
  // Objects — the single BROWSE surface for projects / files / reports /
  // dashboards (one redtable, four tabs). Replaces Home's old steps 2–5
  // and the top-level Reports / Dashboards nav entries. Deep-link form:
  // #/objects?tab=files. (Working name — may be renamed.)
  { path: "/objects",    partial: "/partials/objects.html",    script: "/scripts/pages/objects.js",    auth: true,  label: "Objects",    css: "/styles/pages/objects.css", chrome: "full" },
  // Reports / Dashboards routes stay (they host the full builder UIs —
  // create / edit modes via #/reports?new=1 / ?id=…), but they're
  // `hidden` now: no longer top-level nav items. Browsing happens on
  // /objects; these resolve only as builder deep-link targets.
  { path: "/reports",    partial: "/partials/reports.html",    script: "/scripts/pages/reports.js",    auth: true,  hidden: true, css: "/styles/pages/reports.css", chrome: "full" },
  { path: "/dashboards", partial: "/partials/dashboards.html", script: "/scripts/pages/dashboards.js", auth: true,  hidden: true, css: "/styles/pages/dashboards.css" },
  { path: "/profile",    partial: "/partials/profile.html",    script: "/scripts/pages/profile.js",    auth: true,  hidden: true, css: "/styles/pages/profile.css", chrome: "full" },
  { path: "/settings",   partial: "/partials/settings.html",   script: "/scripts/pages/settings.js",   auth: true,  hidden: true  },
  { path: "/docs",       partial: "/partials/docs.html",       script: "/scripts/pages/docs.js",       auth: false, label: "Docs" },
];

const NOT_FOUND = {
  partial: "/partials/not-found.html",
  script:  "/scripts/pages/not-found.js",
};

// ─── Session ────────────────────────────────────────────────────
// One-time fetch of /api/me on boot. Until Phase 4 (Google OAuth) the
// endpoint doesn't exist — when /api/me 404s we fall back to a dev
// sentinel so authed pages still load. Once real auth ships, a 404
// will mean "endpoint exists but you're not signed in" and the
// sentinel goes away.
let session = null;
async function loadSession() {
  try { session = await api.get("/me"); }
  catch (err) {
    session = err.status === 404
      ? { dev: true, username: "dev", display_name: "Dev user" }
      : null;
  }
  // Apply per-user accent override (Settings page) so the brand colour
  // persists across reloads without a paint flash from re-binding.
  // Set BOTH custom-properties — app sheets use --rp-accent (alias)
  // but most pre-existing rules (and library overrides) read --accent
  // directly. Without overriding --accent too, the user's blue theme
  // would still paint half the surfaces (active mode buttons, project
  // tab rims, drag-drop outlines, etc.) RedPash red.
  const accent = session?.prefs?.accent;
  if (accent) {
    document.documentElement.style.setProperty("--rp-accent", accent);
    document.documentElement.style.setProperty("--accent",    accent);
  }
  // Seed localStorage from the account so the synchronous shell
  // restores (theme, float-bar positions, bg palette) read the user's
  // SAVED choices — not whatever this browser happened to cache.
  seedPrefsToLocalStorage(session?.prefs);
}
export function getSession() { return session; }

// ─── Account-level prefs sync ───────────────────────────────────
// users.prefs (jsonb) is the source of truth for every persisted UI
// preference. localStorage mirrors it as a SYNCHRONOUS cache so the
// boot-time shell restores (theme, float-bar positions, bg palette)
// don't have to await a network round-trip before first paint.
//
// Map: prefs key (server) ↔ localStorage key (client/shell). The
// localStorage keys are historical — chosen before account
// persistence existed — so this map bridges the two namespaces.
const PREFS_LS_MAP = {
  theme:             "redpash-theme",
  topbar_pos:        "rp-topbar-pos",
  footer_pos:        "rp-bottombar-pos",
  default_delimiter: "rp-default-delimiter",
  default_encoding:  "rp-default-encoding",
  export_format:     "rp-export-format",
  language:          "redpash-lang",
  bg_palette:        "rp-bg-palette",
  bg_preview:        "rp-bg-preview",
};

// Boot/login: copy the account's saved prefs into localStorage so the
// synchronous restores read the user's real choices even on a fresh
// browser. Also re-applies the <html> attributes the boot IIFEs
// already painted from (possibly stale) localStorage — the account
// always wins.
function seedPrefsToLocalStorage(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  for (const [pk, lk] of Object.entries(PREFS_LS_MAP)) {
    const v = prefs[pk];
    if (v == null) continue;
    try { localStorage.setItem(lk, String(v)); } catch {}
  }
  // The boot IIFEs ran before the session resolved, so they may have
  // used this browser's stale cache — re-apply from the account.
  if (["dark", "light", "system"].includes(prefs.theme)) {
    document.documentElement.setAttribute("data-theme", prefs.theme);
  }
  if (_RP_BG_PALETTES.includes(prefs.bg_palette)) {
    document.documentElement.setAttribute("data-bg-palette", prefs.bg_palette);
  }
  if (prefs.bg_preview === "on") {
    document.documentElement.setAttribute("data-bg-preview", "on");
  } else if (prefs.bg_preview === "off") {
    document.documentElement.removeAttribute("data-bg-preview");
  }
}

// Persist one preference to the account. Writes localStorage first
// (instant, synchronous — the UI already reflects the change) then
// PATCHes /me. The PATCH is fire-and-forget: a failure leaves the
// choice in localStorage for this browser and we warn rather than
// block the interaction. The dev sentinel user (no real session)
// still gets localStorage-only behaviour, same as before.
window.rpSavePref = async (prefsKey, value) => {
  const lk = PREFS_LS_MAP[prefsKey];
  if (lk) { try { localStorage.setItem(lk, String(value)); } catch {} }
  try {
    await api.patch("/me", { prefs: { [prefsKey]: value } });
    if (session && session.prefs) session.prefs[prefsKey] = value;
  } catch (err) {
    console.warn(`rpSavePref(${prefsKey}) failed:`, err);
  }
};

// ─── Navigation ─────────────────────────────────────────────────
async function mount(route, app, params) {
  app.setAttribute("aria-busy", "true");
  // Swap per-page CSS.
  document.querySelectorAll('link[data-page-css]').forEach((n) => n.remove());
  if (route.css) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = route.css;
    link.dataset.pageCss = "1";
    document.head.appendChild(link);
  }

  // Fetch partial + module in parallel.
  const [html, mod] = await Promise.all([
    fetch(route.partial).then((r) => r.ok ? r.text() : Promise.reject(r.status)),
    import(route.script).catch(() => ({ default: () => {} })),
  ]);
  app.innerHTML = html;
  try { await mod.default?.(app, { session, params: params || {} }); }
  catch (err) { console.error(`[router] mount failed for ${route.path}`, err); toast.error("Failed to load page"); }
  app.setAttribute("aria-busy", "false");
}

function currentPath() {
  // Strip query params — those are read by individual pages (e.g. the
  // cleaner reads `?file=FIL_…`) but route resolution is path-only.
  const h = location.hash.replace(/^#/, "").split("?")[0];
  return h || (session ? "/home" : "/landing");
}

// Path resolution with `:param` pattern support. Static routes (no
// colons) match by string equality; pattern routes match segment-by-
// segment with the colon segments captured into `params`. Returns
// { route, params }; falls through to NOT_FOUND when nothing matches.
function resolve(path) {
  const segs = path.split("/").filter(Boolean);
  for (const route of ROUTES) {
    const params = _matchPath(route.path, segs);
    if (params) return { route, params };
  }
  return { route: NOT_FOUND, params: {} };
}

function _matchPath(pattern, segs) {
  const pp = pattern.split("/").filter(Boolean);
  if (pp.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = decodeURIComponent(segs[i]);
    } else if (pp[i] !== segs[i]) {
      return null;
    }
  }
  return params;
}

async function navigate() {
  const app = document.getElementById("app");
  const path = currentPath();
  const { route, params } = resolve(path);

  if (route.auth && !session) {
    location.hash = "#/landing";
    return;
  }
  // Flip the shell-chrome attribute BEFORE the partial mounts so the
  // app's default body padding / topbar don't flash on full-bleed
  // pages (landing, home). main.css's body[data-chrome="full"] rules
  // pick it up immediately, no per-page :has() override needed.
  document.body.dataset.chrome = route.chrome || "default";
  renderTopbar(path, route);
  await mount(route, app, params);
  // Float bars on the freshly-mounted page get the default position
  // classes from their partial — re-apply the user's saved choice so
  // the picker selection persists across navigations.
  window.rpRestoreBarPositions?.();
  window.rpRestoreBgPreview?.();
}

function renderTopbar(activePath, route) {
  const bar = document.getElementById("topbar");
  const nav = document.getElementById("topbar-nav");
  const user = document.getElementById("topbar-user");
  if (!bar || !nav || !user) return;

  // Full-bleed pages (landing, home) own their own chrome via float bars.
  bar.hidden = (route?.chrome === "full");

  nav.innerHTML = ROUTES
    .filter((r) => r.label && (!r.auth || session))
    .map((r) => `<a href="#${r.path}" class="rp-topbar__link${r.path === activePath ? " is-active" : ""}">${r.label}</a>`)
    .join("");

  if (!session) {
    user.innerHTML = `<a href="#/landing" class="rp-topbar__user-chip">Sign in</a>`;
    return;
  }
  // Signed-in: chip toggles a small dropdown menu. Outside-click and
  // Escape close it; per-item navigation closes it via the hashchange
  // re-render of the topbar.
  const label = session.display_name ?? session.username;
  user.innerHTML = `
    <button type="button" class="rp-topbar__user-chip" id="rp-user-trigger" aria-haspopup="menu" aria-expanded="false">${label}</button>
    <div class="rp-topbar__user-menu" id="rp-user-menu" role="menu" hidden>
      <a class="rp-topbar__user-menu-item" role="menuitem" href="#/profile">Profile</a>
      <a class="rp-topbar__user-menu-item" role="menuitem" href="#/settings">Settings</a>
      <button type="button" class="rp-topbar__user-menu-item" role="menuitem" id="rp-user-logout">Sign out</button>
    </div>
  `;
  const trigger = user.querySelector("#rp-user-trigger");
  const menu    = user.querySelector("#rp-user-menu");
  const onDocClick = (e) => { if (!user.contains(e.target)) close(); };
  const onKey      = (e) => { if (e.key === "Escape") close(); };
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening) {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    } else {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    }
  });
  user.querySelector("#rp-user-logout").addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear cookie even on failure */ }
    session = null;
    location.hash = "#/landing";
    location.reload();
  });
}

// ─── Service worker ─────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  // Register after first paint so it never blocks the boot path.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

// ─── PWA install prompt ─────────────────────────────────────────
// Chromium fires `beforeinstallprompt` once the site meets install
// criteria (manifest + service worker + HTTPS / localhost) AND the
// browser decides this user/profile is a good candidate.
//
// Mirrors the Django /welcome pattern (static/js/ui.js): pwa-install-btn
// elements start hidden via style="display:none"; we reveal them when
// the prompt arms, and re-hide once the user accepts/dismisses. If
// the event never fires (Safari, Firefox, or Chromium already
// dismissed/installed), the button stays hidden — the absence is the
// signal that install isn't on the table here.
let _pwaPrompt = null;

function _showInstallBtns() {
  document.querySelectorAll(".pwa-install-btn").forEach((b) => {
    b.style.display = "inline-flex";
  });
}
function _hideInstallBtns() {
  document.querySelectorAll(".pwa-install-btn").forEach((b) => {
    b.style.display = "none";
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  _pwaPrompt = e;
  _showInstallBtns();
});

window.installPWA = async () => {
  if (!_pwaPrompt) return;
  _pwaPrompt.prompt();
  try { await _pwaPrompt.userChoice; } catch {}
  _pwaPrompt = null;
  _hideInstallBtns();
};

window.addEventListener("appinstalled", () => {
  _pwaPrompt = null;
  _hideInstallBtns();
});

// ─── Float-bar position picker ──────────────────────────────────
// Mirrors the demos/index.html `setBarPos(rail, pos)` pattern: each
// rail (top / bottom) has L / C / R anchor variants on the float bar
// via `.rp-float-bar--{tl,tc,tr,bl,bc,br}` classes (defined in
// `redpash-components/components/float-btn.css`). The choice persists
// in localStorage and re-applies on every page mount because the
// router re-renders #app and the float bars get re-created with their
// default position classes.
const _RP_TOP_POS    = { l: "rp-float-bar--tl", c: "rp-float-bar--tc", r: "rp-float-bar--tr" };
const _RP_BOTTOM_POS = { l: "rp-float-bar--bl", c: "rp-float-bar--bc", r: "rp-float-bar--br" };

function _rpApplyBarPos(rail, pos) {
  const map = rail === "top" ? _RP_TOP_POS : _RP_BOTTOM_POS;
  const all = Object.values(map);
  const selector = rail === "top"
    ? ".rp-float-bar--tr, .rp-float-bar--tl, .rp-float-bar--tc"
    : ".rp-float-bar--bl, .rp-float-bar--br, .rp-float-bar--bc";
  document.querySelectorAll(selector).forEach((bar) => {
    all.forEach((cls) => bar.classList.remove(cls));
    bar.classList.add(map[pos]);
  });
}

window.rpSetBarPos = (rail, pos) => {
  _rpApplyBarPos(rail, pos);
  try { localStorage.setItem(`rp-${rail}bar-pos`, pos); } catch {}
  window.rpSavePref?.(rail === "top" ? "topbar_pos" : "footer_pos", pos);
};

window.rpRestoreBarPositions = () => {
  try {
    const top    = localStorage.getItem("rp-topbar-pos");
    const bottom = localStorage.getItem("rp-bottombar-pos");
    if (top)    _rpApplyBarPos("top",    top);
    if (bottom) _rpApplyBarPos("bottom", bottom);
  } catch {}
};

// ─── Modal open/close ───────────────────────────────────────────
// Two id conventions coexist in the codebase:
//   • Library / auth modals — id="modal-{key}" (.modal-overlay)
//     Used by landing/home/profile (login, contact, etc.).
//   • Sandbox cleaner modals — id="rp-modal-{key}" (.rp-modal-overlay)
//     Used by the cleaner page (open-project, new-project, tool-*).
//
// We accept both — look up rp-modal-{key} first (sandbox is the active
// page when we care about modals from cleaner code), fall back to
// modal-{key} for the legacy callers. Same for the close-others sweep
// at top: it walks both class families so opening a cleaner modal
// also dismisses any stale landing/contact overlay (and vice versa).
//
// This used to be a single-id helper that overwrote controls.js's
// sandbox openModal. Since module scripts run after deferred scripts,
// the override silently broke every cleaner sandbox modal — opening
// hit getElementById("modal-open-project") which never exists.
window.openModal = (key) => {
  const sandboxId = `rp-modal-${key}`;
  const legacyId  = `modal-${key}`;
  document.querySelectorAll(".modal-overlay.open, .rp-modal-overlay.open").forEach((o) => {
    if (o.id !== sandboxId && o.id !== legacyId) o.classList.remove("open");
  });
  const el = document.getElementById(sandboxId) || document.getElementById(legacyId);
  el?.classList.add("open");
};
window.closeModal = (key) => {
  if (!key) {
    // Bare close — dismiss every open overlay (Esc handler, etc.).
    document.querySelectorAll(".modal-overlay.open, .rp-modal-overlay.open")
      .forEach((o) => o.classList.remove("open"));
    return;
  }
  document.getElementById(`rp-modal-${key}`)?.classList.remove("open");
  document.getElementById(`modal-${key}`)?.classList.remove("open");
};
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal-overlay.open, .rp-modal-overlay.open")
    .forEach((o) => o.classList.remove("open"));
});

// ─── Theme toggle ───────────────────────────────────────────────
// Mirrors redpash-components/js/theme.js. Binary dark ↔ light when the
// icon toggle is clicked; rpSetTheme() can also receive 'system' for
// the 3-state Settings switch. Available on every page that wears a
// .rp-theme-icon (landing float bar, home float bar, future Settings).
function _rpSyncToggleIcons(t) {
  document.querySelectorAll(".rp-theme-icon").forEach((icon) => {
    icon.style.opacity   = "0";
    icon.style.transform = "scale(0.3) rotate(180deg)";
    setTimeout(() => {
      icon.className = (t === "light" ? "bi bi-sun-fill" : "bi bi-moon-fill") + " rp-theme-icon";
      icon.style.opacity   = "1";
      icon.style.transform = "scale(1) rotate(0deg)";
    }, 260);
  });
}
window.rpSetTheme = (t) => {
  const html = document.documentElement;
  html.classList.add("rp-theme-transitioning");
  setTimeout(() => html.classList.remove("rp-theme-transitioning"), 400);
  html.setAttribute("data-theme", t);
  // theme-color drives the Android status bar + desktop Chrome titlebar.
  // Match the slate-cobalt page bg so the system chrome blends with the
  // topbar (Phase 0/1/2 cleanup palette). Two strategies depending on
  // mode:
  //   • pinned light/dark — strip the `media` attribute so the tag
  //     wins regardless of OS prefers-color-scheme (the second tag in
  //     index.html with `media=(prefers-color-scheme: light)` still
  //     lives but loses to this unscoped one).
  //   • system — restore the `media=(prefers-color-scheme: dark)`
  //     scope so the two media-scoped <meta>s in index.html auto-track
  //     the OS theme together.
  const meta = document.getElementById("meta-theme");
  if (meta) {
    if (t === "system") {
      meta.setAttribute("media", "(prefers-color-scheme: dark)");
      meta.setAttribute("content", "#0f172a");
    } else {
      meta.removeAttribute("media");
      meta.setAttribute("content", t === "light" ? "#f0f4ff" : "#0f172a");
    }
  }
  try { localStorage.setItem("redpash-theme", t); } catch {}
  window.rpSavePref?.("theme", t);
  _rpSyncToggleIcons(t);
};
window.rpToggleTheme = () => {
  const cur = document.documentElement.getAttribute("data-theme") || "system";
  window.rpSetTheme(cur === "light" ? "dark" : "light");
};

// Restore saved theme on boot — no animation; sync the icon class so
// the first paint already reflects the choice on whatever page mounts.
(() => {
  try {
    const saved = localStorage.getItem("redpash-theme");
    if (saved === "dark" || saved === "light" || saved === "system") {
      document.documentElement.setAttribute("data-theme", saved);
      // Defer icon class sync until DOM has rendered the per-page partial.
      const sync = () => {
        document.querySelectorAll(".rp-theme-icon").forEach((icon) => {
          icon.className = (saved === "light" ? "bi bi-sun-fill" : "bi bi-moon-fill") + " rp-theme-icon";
        });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", sync);
      } else {
        sync();
      }
    }
  } catch {}
})();

// Detect standalone-mode launch (PWA installed to home screen) and tag
// <html data-display="standalone"> so CSS can opt into PWA-only tweaks
// (hide "install RedPash" prompts, tighten chrome that the browser
// no longer provides, etc.) via html[data-display="standalone"] {...}.
// matchMedia('(display-mode: standalone)') covers Chrome / Edge /
// Android; navigator.standalone is the legacy iOS Safari property.
(() => {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (standalone) {
    document.documentElement.setAttribute("data-display", "standalone");
  }
})();

// ─── Background palette preview ─────────────────────────────────
// 4 home-step gradients (import / clean / report / publish) selectable as
// a live preview from the Settings page. The state lives on <html> as
// two data attributes the CSS layers read:
//   data-bg-palette = "import" | "clean" | "report" | "publish"
//   data-bg-preview = "on"     | (absent when off)
// When preview is ON, main.css repaints every .hs-card on the page with
// the chosen gradient so the user sees their choice immediately. When
// OFF the cards revert to their normal .hs-import / .hs-clean / etc.
// Persisted via localStorage("rp-bg-palette" / "rp-bg-preview"); restored
// on boot below and on every navigation so the choice survives reloads
// and route switches.
const _RP_BG_PALETTES = ["import", "clean", "report", "publish"];

window.rpSetBgPalette = (name) => {
  if (!_RP_BG_PALETTES.includes(name)) return;
  document.documentElement.setAttribute("data-bg-palette", name);
  try { localStorage.setItem("rp-bg-palette", name); } catch {}
  window.rpSavePref?.("bg_palette", name);
  // Re-sync the swatches if the picker is on screen.
  document.querySelectorAll("#settings-bg-sw .rp-bg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.bg === name));
};

window.rpToggleBgPreview = () => {
  const html  = document.documentElement;
  const isOn  = html.getAttribute("data-bg-preview") === "on";
  const next  = !isOn;
  if (next) html.setAttribute("data-bg-preview", "on");
  else      html.removeAttribute("data-bg-preview");
  try { localStorage.setItem("rp-bg-preview", next ? "on" : "off"); } catch {}
  window.rpSavePref?.("bg_preview", next ? "on" : "off");
  // Reflect on the toggle button (icon + aria-checked).
  const btn = document.getElementById("settings-bg-preview");
  if (btn) {
    btn.setAttribute("aria-checked", next ? "true" : "false");
    const icon = btn.querySelector("i.bi");
    if (icon) icon.className = `bi ${next ? "bi-eye" : "bi-eye-slash"}`;
  }
};

window.rpRestoreBgPreview = () => {
  try {
    const palette = localStorage.getItem("rp-bg-palette");
    const preview = localStorage.getItem("rp-bg-preview");
    if (palette && _RP_BG_PALETTES.includes(palette)) {
      document.documentElement.setAttribute("data-bg-palette", palette);
      document.querySelectorAll("#settings-bg-sw .rp-bg-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.bg === palette));
    }
    if (preview === "on") {
      document.documentElement.setAttribute("data-bg-preview", "on");
      const btn = document.getElementById("settings-bg-preview");
      if (btn) {
        btn.setAttribute("aria-checked", "true");
        const icon = btn.querySelector("i.bi");
        if (icon) icon.className = "bi bi-eye";
      }
    }
  } catch {}
};

// Apply the saved palette attribute on boot so every page renders with
// the user's choice; the per-page mount fires rpRestoreBgPreview() again
// to sync the picker UI once the partial is in the DOM.
(() => {
  try {
    const palette = localStorage.getItem("rp-bg-palette");
    const preview = localStorage.getItem("rp-bg-preview");
    if (palette && _RP_BG_PALETTES.includes(palette)) {
      document.documentElement.setAttribute("data-bg-palette", palette);
    }
    if (preview === "on") {
      document.documentElement.setAttribute("data-bg-preview", "on");
    }
  } catch {}
})();

// ─── Boot ───────────────────────────────────────────────────────
window.addEventListener("hashchange", navigate);
(async () => {
  await loadSession();
  await navigate();
})();
