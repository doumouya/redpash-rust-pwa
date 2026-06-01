/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/main.md */
// ─────────────────────── RedPash router ───────────────────────
//
// Hash-based SPA router, rebuilt clean for the 2026-05-22 frontend
// reset. Each route names a partial (HTML fetched into #app) and a
// script (an ES module whose default export is called with the
// mounted node and a context). Pages are added to ROUTES as the
// rebuild brings them back — login and home are the blank scaffold.
//
// Hash routing (not the History API) keeps the app a single static
// file set: Axum's ServeDir returns index.html for "/", the hash
// carries the route, and the service worker can serve it offline.

import { api } from "/scripts/api.js";
import { installErrorCapture } from "/scripts/events.js";
import { seedPrefs } from "/scripts/prefs.js";
import { esc } from "/scripts/dom.js";

// Arm frontend error capture before anything else runs, so a
// boot-time exception still reaches the Events log.
installErrorCapture();

const ROUTES = {
  "/login":      { partial: "/partials/login.html",      script: "/scripts/pages/login.js",      auth: false },
  "/home":       { partial: "/partials/home.html",       script: "/scripts/pages/home.js",       auth: true  },
  "/workspace":  { partial: "/partials/workspace.html",  script: "/scripts/pages/workspace.js",  auth: true  },
  "/cases":      { partial: "/partials/cases.html",      script: "/scripts/pages/cases.js",      auth: true  },
  "/monitoring": { partial: "/partials/monitoring.html", script: "/scripts/pages/monitoring.js", auth: true, admin: true },
  "/profile":    { partial: "/partials/profile.html",    script: "/scripts/pages/profile.js",    auth: true  },
  "/settings":   { partial: "/partials/settings.html",   script: "/scripts/pages/settings.js",   auth: true  },
  "/docs":       { partial: "/partials/docs.html",       script: "/scripts/pages/docs.js",       auth: true  },
};

// ─── Session ────────────────────────────────────────────────────
// One /api/me fetch on boot. Real auth is not fully wired yet: a 404
// means the endpoint is absent — fall back to a dev sentinel so /home
// still mounts during the rebuild. Any other failure (401, network)
// means "no session".
let session = null;

async function loadSession() {
  try {
    session = await api.get("/me");
    // Seed the prefs SWR cache from the server's source of truth. Done
    // here (not inside prefs.js's import) because the boot fetch is
    // what guarantees we *have* server state before any page mounts —
    // otherwise the first paint of e.g. /settings would render the
    // local cache's defaults and snap to server state a tick later.
    seedPrefs(session?.prefs);
  } catch (err) {
    session = err.status === 404
      ? { dev: true, username: "dev", display_name: "Dev user" }
      : null;
  }
}
export function getSession() { return session; }

// ─── Navigation ─────────────────────────────────────────────────
function currentPath() {
  const h = location.hash.replace(/^#/, "").split("?")[0];
  if (h && h.startsWith("/")) return h;
  return session ? "/home" : "/login";
}

async function mount(path) {
  const app = document.getElementById("app");
  const route = ROUTES[path];

  if (!route) { app.innerHTML = errorShell("404", "Page not found", "We couldn't find " + path + "."); return; }
  if (route.auth && !session) {
    location.hash = "#/login";
    return;
  }
  // Platform-admin-only route (Monitoring / Admin Console, CAS_274EDF3B):
  // a member / viewer deep-linking the hash is bounced home. The topbar
  // already hides the link; this guards the URL path. Backend /monitoring/*
  // + /admin/* endpoints are the real auth — this is the UX gate.
  if (route.admin && !session?.is_platform_admin) {
    location.hash = "#/home";
    return;
  }

  app.setAttribute("aria-busy", "true");
  const [html, mod] = await Promise.all([
    fetch(route.partial).then((r) => (r.ok ? r.text() : Promise.reject(r.status))),
    import(route.script),
  ]);
  app.innerHTML = html;
  await mod.default?.(app, { session, getSession });
  app.setAttribute("aria-busy", "false");
}

function navigate() {
  mount(currentPath())
    .then(tryAuditCapture)
    .catch((err) => {
      console.error("[router] mount failed:", err);
      document.getElementById("app").innerHTML =
        errorShell("⚠", "Something went wrong", "Reload to try again.");
    });
}

// ─── ?audit=1 mode — UI-snapshot self-report ─────────────────────
// When the SPA loads with `?audit=1` in the URL, every page mount
// triggers a computed-style snapshot of the foundation atom catalog
// (.rt-* + .rp-* — see scripts/audit/snapshot.js) and downloads the
// JSON. Feed the files into tools/ui-snapshot-audit/audit.js to
// surface drift in the standard audit pipeline (audit.run_diff).
//
// v2 (Em's "we need v2 bro — capturing at tab switch, other actions"):
// the auto-on-mount capture (state=default) is the v1 baseline;
// additional interactive states surface via two paths:
//   • Auto on tab switch — MutationObserver on `.rp-chip.is-active`
//     class transitions; debounced; state = the new chip's
//     `data-value` (or textContent fallback). Catches Home tab
//     switches, Monitoring tabs, any future chip-driven nav.
//   • Manual — floating "📸 Capture" button bottom-right + the
//     programmatic `window.__rpCapture(state?)` API for devtools /
//     test harnesses. Use for non-tab interactions: drill-down
//     panels, modals, mode toggles, etc.
//
// Lazy-imported so non-audit page loads never pay the module-fetch
// cost. Errors swallowed (only console.warn) so a snapshot failure
// can't break the page — the audit is best-effort instrumentation,
// not a hard dependency.
function isAuditMode() {
  return new URLSearchParams(location.search).get("audit") === "1";
}

let _snapshotApi = null;
async function loadSnapshotApi() {
  if (!_snapshotApi) _snapshotApi = await import("/scripts/audit/snapshot.js");
  return _snapshotApi;
}

async function tryAuditCapture(state = null) {
  if (!isAuditMode()) return;
  try {
    const { captureSnapshot, downloadSnapshot } = await loadSnapshotApi();
    const snap = await captureSnapshot(state);
    downloadSnapshot(snap);
  } catch (err) {
    console.warn("[audit] snapshot capture failed:", err);
  }
}

// v2 auto-capture: watch for tab switches via `.rp-chip.is-active`
// class transitions. Debounced because chip clicks usually trigger
// two class mutations (one removes is-active from the old chip,
// one adds it to the new); we want one capture per logical switch.
//
// State derivation: when a chip gains is-active, prefer its
// data-value (the chip-row's canonical tag); fall back to its
// trimmed textContent. The state string lands in the filename +
// finding_key so the same route's multi-tab snapshots don't
// collide.
let _auditObserverArmed = false;
let _tabCaptureTimer = null;
function armTabCaptureObserver() {
  if (!isAuditMode() || _auditObserverArmed) return;
  _auditObserverArmed = true;
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== "attributes" || m.attributeName !== "class") continue;
      const el = m.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains("rp-chip")) continue;
      if (!el.classList.contains("is-active")) continue;
      // Newly active chip — debounce + capture. Re-firing across the
      // 250ms window collapses to the latest state.
      const state = (el.getAttribute("data-value") || el.textContent || "tab")
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase()
        .slice(0, 32);
      clearTimeout(_tabCaptureTimer);
      _tabCaptureTimer = setTimeout(() => tryAuditCapture(state), 250);
      return;
    }
  });
  observer.observe(document.body, {
    attributes:       true,
    attributeFilter:  ["class"],
    subtree:          true,
  });
}

// v2 floating capture button — manual control for non-tab states
// (drill-downs, modals, row-clicks, mode toggles, anything the
// auto-observer doesn't catch). Bottom-right corner, minimal
// chrome so it doesn't interfere with the page being audited.
// Idempotent — only mounts once per session.
let _captureBarMounted = false;
function mountCaptureBar() {
  if (!isAuditMode() || _captureBarMounted) return;
  _captureBarMounted = true;
  const bar = document.createElement("div");
  bar.id = "rp-audit-bar";
  bar.style.cssText =
    "position:fixed;bottom:12px;right:12px;z-index:99999;" +
    "display:flex;gap:6px;align-items:center;" +
    "padding:6px 8px;border-radius:8px;" +
    "background:rgba(15,15,25,0.92);color:#cdd6f4;" +
    "font:12px/1 system-ui,sans-serif;" +
    "box-shadow:0 4px 12px rgba(0,0,0,0.3);";
  bar.innerHTML =
    '<input type="text" id="rp-audit-state" placeholder="state tag" '
    + 'style="width:120px;padding:4px 6px;border:1px solid #45475a;'
    + 'border-radius:4px;background:#1e1e2e;color:inherit;font:inherit;">'
    + '<button type="button" id="rp-audit-snap" '
    + 'style="padding:4px 10px;border:0;border-radius:4px;'
    + 'background:#89b4fa;color:#1e1e2e;font:inherit;font-weight:600;'
    + 'cursor:pointer;">📸 Capture</button>';
  document.body.appendChild(bar);
  document.getElementById("rp-audit-snap").addEventListener("click", () => {
    const input = document.getElementById("rp-audit-state");
    const state = input.value.trim() || "manual";
    tryAuditCapture(state);
    input.value = "";
  });
}

// Programmatic API for devtools / future test harnesses. Bypasses
// the floating UI — useful for scripting a sequence of captures.
if (typeof window !== "undefined") {
  window.__rpCapture = (state) => tryAuditCapture(state);
}

// Shared shell for 404 + mount-failure surfaces. Uses .rp-page tokens
// so it inherits the theme + spacing from the existing page CSS — no
// new selectors. The CTA falls back to /login when there's no session;
// /home otherwise.
function errorShell(badge, title, body) {
  const back = session ? "#/home" : "#/login";
  const label = session ? "Back to home" : "Go to sign in";
  return ''
    + '<section class="rp-page">'
    +   '<div class="rp-page__body" style="display:flex;align-items:center;justify-content:center;min-height:70vh;">'
    +     '<div class="rp-page__placeholder" style="max-width:420px;">'
    +       '<div style="font-size:36px;font-weight:700;color:var(--rp-text);">' + esc(badge) + '</div>'
    +       '<h1 class="rp-page__title" style="margin-top:8px;">' + esc(title) + '</h1>'
    +       '<p class="rp-page__sub">' + esc(body) + '</p>'
    +       '<p style="margin-top:20px;"><a class="rp-btn rp-btn--glass" href="' + back + '">' + label + '</a></p>'
    +     '</div>'
    +   '</div>'
    + '</section>';
}
window.addEventListener("hashchange", () => {
  // Bare in-page anchors (#section) are not routes — ignore them.
  if (location.hash && !location.hash.startsWith("#/")) return;
  navigate();
});

// ─── Service worker ─────────────────────────────────────────────
// Registration + update banner — when a new version takes control,
// sw-update.js shows a refresh prompt instead of leaving users on
// stale JS until they happen to hard-refresh.
import { mountSwUpdate } from "/scripts/sw-update.js";
window.addEventListener("load", mountSwUpdate);

// ─── Dropdown atom — one delegated handler covers every page ────
// `[data-dd]` trigger + `.rt-dd` body, click-to-toggle + click-
// elsewhere-to-close. Lives in dropdown.js so per-page mount code
// (workspace, report builder, etc.) doesn't have to wire its own
// — and so dynamically-rendered buttons work without a re-sweep.
import { bindDropdown } from "/scripts/dropdown.js";
bindDropdown();

// ─── Boot ───────────────────────────────────────────────────────
(async () => {
  await loadSession();
  navigate();
  // v2 audit-mode wiring — both armers are idempotent + cheap when
  // not in audit mode (early-return on the isAuditMode check). Run
  // them after navigate kicks off so the body has the first-page DOM
  // when the observer attaches and when the floating bar mounts.
  armTabCaptureObserver();
  mountCaptureBar();
})();
