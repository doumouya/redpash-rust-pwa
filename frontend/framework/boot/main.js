/* main.js — boot: error capture → session → behavior-registry seed → router.
   One /api/me round-trip boots everything (it carries the resolved settings
   cascade). */

import { api } from "./api.js";
import { allPages } from "./apps.js";
import { installErrorCapture } from "./events.js";
import { configureRouter, startRouter } from "./router.js";
import { registerServiceWorker } from "./sw-update.js";
import { seedResolved, applyDocumentPref, getPref } from "../registry/pref-registry.js";

installErrorCapture();
registerServiceWorker();

let session = null;

async function boot() {
  try {
    const me = await api.get("/me");
    session = { ...me.user, is_platform_admin: me.is_platform_admin };
    seedResolved(me.settings, { userRid: me.user.redpash_id });
  } catch {
    session = null; // release build without a session → login
  }
  // Reflect the (possibly server-corrected) document prefs.
  for (const key of ["theme", "density", "fontsize"]) {
    const v = getPref(key);
    if (v && v !== "default") applyDocumentPref(key, v);
  }
  configureRouter({ session, getSession: () => session });
  startRouter();

  // Pre-load every BUILT page module (fire-and-forget): page modules register
  // their prefs/policies at module load, so Settings and Admin Console see
  // the full registry regardless of navigation order. Dynamic import later
  // returns the same cached module — lazy mounting is unaffected.
  for (const p of allPages().filter((p) => p.built)) {
    import(`/apps/${p.app.id}/${p.id}/${p.id}.js`).catch(() => {});
  }
}

boot();
