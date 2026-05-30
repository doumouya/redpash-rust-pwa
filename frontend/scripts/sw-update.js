/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/sw-update.md */
// Service-worker registration.
//
// The SW exists for ONE reason: to keep RedPash installable as a desktop
// PWA (manifest + a registered SW with a fetch handler = installable).
// It does no caching (see service-worker.js), so there's no stale-asset
// situation and therefore no "new version — refresh to apply" banner.
// `skipWaiting` + `clients.claim` in the worker make updates apply
// silently; nothing here needs to prompt the user.
//
// Kept the name `mountSwUpdate` so main.js's boot wiring is unchanged;
// it now simply registers the worker.

export function mountSwUpdate() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/service-worker.js")
    .catch(() => { /* dev / file:// — silently skip */ });
}
