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
  "/login":     { partial: "/partials/login.html",     script: "/scripts/pages/login.js",     auth: false },
  "/home":      { partial: "/partials/home.html",      script: "/scripts/pages/home.js",      auth: true  },
  "/workspace": { partial: "/partials/workspace.html", script: "/scripts/pages/workspace.js", auth: true  },
  "/profile":   { partial: "/partials/profile.html",   script: "/scripts/pages/profile.js",   auth: true  },
  "/settings":  { partial: "/partials/settings.html",  script: "/scripts/pages/settings.js",  auth: true  },
  "/docs":      { partial: "/partials/docs.html",      script: "/scripts/pages/docs.js",      auth: true  },
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

  if (!route) {
    app.innerHTML = '<p style="padding:24px">Page not found.</p>';
    return;
  }
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
      '<p style="padding:24px">Something went wrong loading this page.</p>';
  });
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
