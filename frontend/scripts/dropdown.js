/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/dropdown.md */
// dropdown.js — one delegated click handler for the [data-dd] +
// .rp-menu dropdown atom. Replaces the mount-time $$([data-dd])
// sweep in workspace.js (only caught statically-rendered buttons)
// + the inline workaround we shipped in report.js when the
// builder's dynamically-rendered buttons couldn't subscribe to
// the workspace sweep.
//
// The framework .rp-menu atom (the legacy .rt-dd is fully retired; the
// mutex/outside-click close targets every open .rp-menu panel — toolbar,
// report builder, multi-picker, list-page, home):
//   <button data-dd="myDdId">…</button>
//   <div class="rp-menu" id="myDdId">…items…</div>
//
// Behaviour:
//   1. Click a trigger button → toggle that dropdown's `.open`
//      class, close every other open dropdown (mutex).
//      stopPropagation so the click doesn't bubble back to step 3
//      and immediately re-close us.
//   2. Click an item inside an open dropdown → the consumer's
//      item handler runs first (bubble phase), then the document
//      handler closes the dropdown — the standard "click-to-
//      dismiss" pattern.
//   3. Click anywhere else → close every open dropdown.
//
// Idempotent: bindDropdown() can be called multiple times safely
// (module-level singleton). Cheapest call site: main.js at app
// boot. Each page then mounts whatever HTML it wants — newly-
// added [data-dd] buttons work without any per-page wiring.

let wired = false;

export function bindDropdown() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dd]");
    if (btn) {
      e.stopPropagation();
      const dd = document.getElementById(btn.dataset.dd);
      if (!dd) return;
      const wasOpen = dd.classList.contains("open");
      // Mutex — only one dropdown open at a time.
      document.querySelectorAll(".rp-menu.open").forEach((d) => d.classList.remove("open"));
      dd.classList.toggle("open", !wasOpen);
      return;
    }
    // Item click inside a dropdown OR click outside any dropdown:
    // close every open dropdown. The consumer's item handler ran
    // already (bubble phase fires children-first), so the close
    // is purely visual + state cleanup.
    document.querySelectorAll(".rp-menu.open").forEach((d) => d.classList.remove("open"));
  });
}
