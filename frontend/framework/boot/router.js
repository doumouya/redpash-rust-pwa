/* router.js — hash router over the apps registry. `#/<page-id>` fetches
   /apps/<app>/<page>/<page>.html into #app and calls the module's default
   export with (host, ctx). Auth/admin gates are UX bounce only — the backend
   gates remain the boundary. */

import { allPages, landingFor } from "./apps.js";
import { captureMountError } from "./events.js";

let current = { destroy: null };
let ctx = { session: null, getSession: () => null };

export function configureRouter(c) {
  ctx = { ...ctx, ...c };
}

function targetPage() {
  const id = (location.hash || "").replace(/^#\//, "").split("?")[0];
  return allPages().find((p) => p.id === id) ?? null;
}

async function mount() {
  const app = document.getElementById("app");
  const session = ctx.getSession();
  let page = targetPage();

  // No route / unknown route → land.
  if (!page) {
    location.hash = session ? landingFor(session) : "#/login";
    return;
  }
  // Auth gates (UX only).
  const needsAuth = page.auth !== false;
  if (needsAuth && !session) {
    location.hash = "#/login";
    return;
  }
  if (page.app.admin && !session?.is_platform_admin) {
    location.hash = landingFor(session);
    return;
  }
  if (page.id === "login" && session) {
    location.hash = landingFor(session);
    return;
  }

  app.setAttribute("aria-busy", "true");
  try {
    current.destroy?.();
  } catch {
    /* a failing destroy must not block navigation */
  }
  current = { destroy: null };

  if (!page.built) {
    // Construction-time only: unbuilt pages are hidden from all nav; reaching
    // one directly during the build phase shows plain text, not a fake page.
    app.innerHTML = `<p style="padding:2rem;color:var(--rp-text-mute)">${page.label} is not built yet.</p>`;
    app.removeAttribute("aria-busy");
    return;
  }

  const base = `/apps/${page.app.id}/${page.id}/${page.id}`;
  try {
    const [html, mod] = await Promise.all([
      fetch(`${base}.html`).then((r) => {
        if (!r.ok) throw new Error(`partial ${r.status}`);
        return r.text();
      }),
      import(`${base}.js`),
    ]);
    app.innerHTML = html;
    const handle = await mod.default(app.firstElementChild ?? app, ctx);
    current.destroy = handle?.destroy ?? null;
  } catch (err) {
    captureMountError(page.id, err);
    app.innerHTML = `<p style="padding:2rem;color:var(--rp-danger)">This page failed to load.</p>`;
  } finally {
    app.removeAttribute("aria-busy");
  }
}

export function startRouter() {
  window.addEventListener("hashchange", mount);
  mount();
}
