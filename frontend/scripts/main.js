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

// Arm frontend error capture before anything else runs, so a
// boot-time exception still reaches the Events log.
installErrorCapture();

const ROUTES = {
  "/login":      { partial: "/partials/login.html",      script: "/scripts/pages/login.js",      auth: false },
  "/home":       { partial: "/partials/home.html",       script: "/scripts/pages/home.js",       auth: true  },
  "/workspace":  { partial: "/partials/workspace.html",  script: "/scripts/pages/workspace.js",  auth: true  },
  "/monitoring": { partial: "/partials/monitoring.html", script: "/scripts/pages/monitoring.js", auth: true  },
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
  mount(currentPath()).catch((err) => {
    console.error("[router] mount failed:", err);
    document.getElementById("app").innerHTML =
      errorShell("⚠", "Something went wrong", "Reload to try again.");
  });
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
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

window.addEventListener("hashchange", () => {
  // Bare in-page anchors (#section) are not routes — ignore them.
  if (location.hash && !location.hash.startsWith("#/")) return;
  navigate();
});

// ─── Service worker ─────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

// ─── Boot ───────────────────────────────────────────────────────
(async () => {
  await loadSession();
  navigate();
})();
