/* ─────────────────── SpreadSheet Paper — fragment loader ───────────────────
 *
 * Composable HTML via <... data-include="path/to/fragment.html">. The loader
 * walks every [data-include] under `root`, fetches each fragment in parallel,
 * inlines the response, then recurses so a fragment can itself include sub-
 * fragments. Each fragment becomes the new base URL for its descendants —
 * `./modals/x.html` inside `cleaner/index.html` resolves to
 * `partials/cleaner/modals/x.html`, NOT to the document's `partials/modals/`.
 *
 * Usage:
 *   <body>
 *     <div data-include="./partials/cleaner/header.html"></div>
 *   </body>
 *   <script defer src="./include.js"></script>
 *
 * On DOMContentLoaded the loader fires once. For dynamic mounts (router
 * swaps a partial in), call `window.rpInclude(newRoot)` to walk just the
 * subtree you just attached.
 * ───────────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const LOG = (typeof window !== "undefined") && (window.SP_INCLUDE_DEBUG !== false);

  async function rpInclude(root, base) {
    root = root || document;
    base = base || (typeof location !== "undefined" ? location.href : "");

    // Snapshot the slot list — innerHTML mutations below would skew a live
    // querySelectorAll if we iterated it directly while replacing children.
    const slots = Array.prototype.slice.call(
      root.querySelectorAll("[data-include]"),
    );
    if (!slots.length) return;
    if (LOG) console.log("[rp-include] walking", slots.length, "slot(s) against base", base);

    await Promise.all(slots.map(async (slot) => {
      const raw = slot.getAttribute("data-include");
      if (!raw) return;

      let url;
      try { url = new URL(raw, base).href; }
      catch (err) {
        if (LOG) console.warn("[rp-include] bad URL", raw, "vs base", base, err);
        _fail(slot, raw, `bad URL: ${err.message}`);
        return;
      }

      try {
        if (LOG) console.log("[rp-include] fetch", url);
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        slot.innerHTML = await res.text();
        if (LOG) console.log("[rp-include] OK   ", url);
      } catch (err) {
        if (LOG) console.warn("[rp-include] FAIL ", url, err);
        _fail(slot, raw, err.message);
        return;
      }

      // Mark consumed so a later re-walk of the same root doesn't double-
      // include. The included path is preserved for inspection / debugging.
      slot.removeAttribute("data-include");
      slot.setAttribute("data-included", raw);

      // Recurse — child includes are relative to THIS fragment's URL,
      // not to the document. Lets a fragment under partials/cleaner/
      // write `./modals/foo.html` to mean "sibling modals dir".
      await rpInclude(slot, url);
    }));

    // Re-run controls.js binders against the freshly-mounted subtree
    // so hover-grace handlers / etc. wire onto the new DOM. Idempotent —
    // each binder dataset-guards itself, so repeat calls are no-ops.
    if (typeof window.spInit === "function") window.spInit(root);
  }

  function _fail(slot, raw, msg) {
    slot.innerHTML =
      '<pre style="color:var(--muted,#888);font-size:0.6875rem;padding:0.5rem;border:0.0625rem dashed var(--muted,#888)">'
      + '[include error: ' + raw + ' — ' + msg + ']'
      + '</pre>';
  }

  window.rpInclude = rpInclude;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => rpInclude());
  } else {
    rpInclude();
  }
})();
