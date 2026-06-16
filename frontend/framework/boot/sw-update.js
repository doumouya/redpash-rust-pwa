/* sw-update.js — service-worker registration only. There is deliberately no
   update banner: the SW caches nothing that can go stale (hashed wasm only),
   and updates apply silently. */

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/service-worker.js").catch(() => {
    /* SW is an optimization, never a boot blocker */
  });
}
