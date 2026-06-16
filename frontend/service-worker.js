/* service-worker.js — caches EXACTLY ONE thing: the content-hashed wasm
   engine. The hash IS the cache version (a rebuild yields a new URL, so
   cache-first can never serve a stale engine). JS/CSS/HTML and /api are
   never intercepted — freshness rides HTTP. Updates apply silently
   (skipWaiting + clients.claim); nothing cacheable can go stale, so there is
   no update banner. */

const WASM_RE = /\/wasm\/data_bg\.[0-9a-f]+\.wasm$/;
const CACHE = "rp-wasm";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !WASM_RE.test(url.pathname)) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const resp = await fetch(e.request);
      if (resp.ok) {
        cache.put(e.request, resp.clone());
        // Prune other-hash engines — hold ~one.
        const keys = await cache.keys();
        for (const k of keys) {
          if (k.url !== e.request.url) cache.delete(k);
        }
      }
      return resp;
    })
  );
});
