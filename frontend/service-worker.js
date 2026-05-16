// ─────────────── RedPash service worker ───────────────
//
// Three strategies:
//   • /api/*                              → network-first, fall back to
//                                            cached response (so /docs
//                                            works offline once visited).
//   • partials/*.html  + index.html       → network-first too. These
//                                            change every iteration during
//                                            dev and a stale partial means
//                                            inline onclick handlers point
//                                            at JS that no longer exists.
//                                            The cache acts as an offline
//                                            fallback.
//   • everything else (CSS, JS modules,   → cache-first with stale-while-
//     icons, library vendor files)         revalidate. These are mostly
//                                            stable; CACHE_VERSION bumps
//                                            invalidate them when they do
//                                            change. Fast repeat-visit
//                                            paint, refreshed in the
//                                            background.
//
// Bump CACHE_VERSION on any breaking change to invalidate old caches.

const CACHE_VERSION = "v268";
const SHELL_CACHE   = `redpash-shell-${CACHE_VERSION}`;
const API_CACHE     = `redpash-api-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/styles/main.css",
  "/scripts/main.js",
  "/scripts/api.js",
  "/icons/logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k !== SHELL_CACHE && k !== API_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // HTML partials + index.html change frequently and inline-onclick
  // handlers in them couple them tightly to JS. Stale partials reference
  // handlers that have been renamed — better to take the network hit and
  // fall back to cache only when offline.
  const isHtml = url.pathname.endsWith(".html") || url.pathname === "/";

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req, API_CACHE));
  } else if (isHtml) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    return cached ?? new Response(JSON.stringify({ message: "offline" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
}

async function cacheFirst(req) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached ?? (await network) ?? new Response("offline", { status: 503 });
}
