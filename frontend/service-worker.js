// ─────────────── RedPash service worker ───────────────
//
// Install-only. RedPash is a server-dependent, authenticated desktop
// tool — the data lives server-side, every clean/step/join hits /api,
// so "offline" is meaningless here. The PWA exists for ONE reason: the
// installable desktop-app effect (standalone window, add-to-dock). That
// needs a manifest + a registered SW with a fetch handler — nothing more.
//
// So this worker does NOT cache. It used to (network-first / cache-first
// with a CACHE_VERSION), and that only ever produced pain: stale assets
// after deploy, the "refresh to apply" banner, and a hard-refresh ritual.
// Asset freshness is now the network's job (HTTP caching / versioned
// filenames); this worker just needs to *exist*.
//
// `skipWaiting` + `clients.claim` mean a new version takes over silently —
// no waiting worker, so no update banner. On activate it also evicts any
// caches left behind by the previous caching worker, so existing installs
// self-heal on their next visit.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // One-time cleanup: drop every cache the old caching SW created.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// A fetch handler must exist for the app to qualify as installable, but
// this one intentionally does not intercept — the browser fetches every
// request normally and the HTTP layer decides freshness. No caching, no
// offline, no staleness.
self.addEventListener("fetch", () => { /* presence only */ });
