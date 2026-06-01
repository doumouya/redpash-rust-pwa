/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/sw-update.md */
// Service-worker registration.
//
// The SW keeps RedPash installable as a desktop PWA (manifest + a
// registered SW with a fetch handler = installable) AND cache-first-serves
// the content-hashed wasm engine for instant repeat loads + offline
// edge-compute (see service-worker.js). It caches ONLY the immutable-hashed
// wasm — no JS/CSS — so there's still no stale-asset situation and no
// "new version — refresh to apply" banner. `skipWaiting` + `clients.claim`
// in the worker apply updates silently; nothing here prompts the user.
//
// Kept the name `mountSwUpdate` so main.js's boot wiring is unchanged;
// it now simply registers the worker.

export function mountSwUpdate() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/service-worker.js")
    .catch(() => { /* dev / file:// — silently skip */ });
}
