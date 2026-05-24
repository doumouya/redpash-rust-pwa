// Service-worker update banner.
//
// service-worker.js calls skipWaiting() in install + clients.claim()
// in activate — a new SW takes control of the page as soon as it's
// installed. BUT the JS bundle that's running in the current tab is
// still the old code (the SW only changes what FUTURE fetches hit;
// it doesn't reload modules already on the call stack). So we need
// to tell the user: "a new version is here, reload to actually run
// it." This module shows that banner and reloads on click.
//
// Mounted once at boot from main.js. Listens for two SW events:
//   - reg.updatefound + installing.statechange === "installed"
//     while an existing controller is present → an update just
//     installed, banner appears.
//   - controllerchange → covers the rarer case where a different
//     tab triggered the update first; banner appears too.

export function mountSwUpdate() {
  if (!("serviceWorker" in navigator)) return;
  // Register first; success path wires the update listeners.
  navigator.serviceWorker.register("/service-worker.js").then((reg) => {
    if (!reg) return;

    // A SW is installing — watch its statechange to detect when it
    // reaches "installed" with an existing controller (= update).
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          showBanner();
        }
      });
    });

    // Edge case: another tab triggered the update before this tab
    // even subscribed to updatefound — the new SW already controls
    // us by the time we register. controllerchange catches it.
    let didReload = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Don't auto-reload (would interrupt work in flight). The
      // banner click is the manual trigger. Flag so the banner's
      // reload-on-click handler doesn't double-fire if the user
      // clicked first and the event arrives a moment later.
      if (didReload) return;
      showBanner();
    });
  }).catch(() => { /* dev / file:// — silently skip */ });
}

// ── banner ───────────────────────────────────────────────────────────
// Lazy-injected once, kept hidden until shown. Survives page renders
// because it lives on <body>, not inside #app (which the router
// replaces on every navigation).
let bannerEl = null;
function showBanner() {
  if (!bannerEl) {
    bannerEl = document.createElement("div");
    bannerEl.id = "rp-sw-update";
    bannerEl.className = "rp-sw-update";
    bannerEl.setAttribute("role", "status");
    bannerEl.innerHTML = ''
      + '<span class="rp-sw-update__msg">'
      +   '<i class="bi bi-arrow-down-circle"></i> '
      +   'RedPash has updated.'
      + '</span>'
      + '<button class="rp-sw-update__btn" type="button">'
      +   'Refresh to apply'
      + '</button>'
      + '<button class="rp-sw-update__close" type="button" aria-label="Dismiss">'
      +   '<i class="bi bi-x-lg"></i>'
      + '</button>';
    document.body.appendChild(bannerEl);
    bannerEl.querySelector(".rp-sw-update__btn").addEventListener("click", () => {
      location.reload();
    });
    bannerEl.querySelector(".rp-sw-update__close").addEventListener("click", () => {
      bannerEl.classList.remove("is-visible");
    });
  }
  // Slight delay before adding the class so the CSS transition catches.
  requestAnimationFrame(() => bannerEl.classList.add("is-visible"));
}
