// ─────────────── RedPash service worker ───────────────
//
// Mostly pass-through, with ONE deliberate exception: it cache-first-serves
// the content-hashed wasm engine (`/wasm/data_bg.<hash>.wasm`).
//
// Why cache it: RedPash's edge-compute runs the `data` crate IN the browser
// (parse / clean / sort, file-never-leaves-device) — so "offline" is NOT
// meaningless for the ingest/clean path, it's the governance moat. And the
// engine is ~3.3 MB gz; re-downloading it every visit is the load cost we
// measured. Caching it → instant repeat loads + offline edge-compute.
//
// Why it's SAFE now (it wasn't before): the wasm filename is CONTENT-HASHED
// by tools/build-wasm.sh, so the hash IS the cache version. A rebuild changes
// the bytes → changes the hash → changes the URL → cache-first can NEVER
// serve a stale engine (new hash = new URL = cache miss = fresh). There is no
// CACHE_VERSION to bump by hand — that manual treadmill is what made the old
// everything-caching SW produce stale-asset pain, so it got gutted. This
// caches ONLY the immutable-hashed wasm; nothing else.
//
// Everything else (JS / CSS / HTML / /api) is NOT intercepted — the network +
// HTTP cache decide freshness, so dev edits still show on a normal reload.
//
// `skipWaiting` + `clients.claim` → a new worker takes over silently.

const WASM_CACHE = "rp-wasm"; // static — the wasm HASH versions per build; never bump this by hand
const isHashedWasm = (p) => p.startsWith("/wasm/data_bg.") && p.endsWith(".wasm");

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Drop legacy caches from the old everything-caching SW; keep WASM_CACHE.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== WASM_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only the content-hashed wasm is cached; everything else hits the network.
  if (event.request.method !== "GET" || !isHashedWasm(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(WASM_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit; // cache-first — safe because the URL is content-hashed (immutable)
    const resp = await fetch(event.request);
    if (resp.ok) {
      // Hold ~one engine: prune any other-hash wasm entries, then store this one.
      for (const k of await cache.keys()) {
        if (k.url !== event.request.url) await cache.delete(k);
      }
      await cache.put(event.request, resp.clone());
    }
    return resp;
  })());
});
