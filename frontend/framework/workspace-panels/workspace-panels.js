/* workspace-panels — the RESPONSIVE 3-region frame: a left region, a center,
   and a right region. It owns the responsive @media + the side-drawer behavior
   (the SAME off-canvas drawer + scrim pattern the rail uses below the
   breakpoint — matchMedia event-driven, classList only, no width polling).

   It returns the three region HOST elements; the consumer mounts a side-panel
   into left + right and a grid-view into center. The frame knows nothing about
   their content.

   mountWorkspacePanels(host) → {
     left, center, right,            // the three region elements
     togglePanel("left"|"right"),    // flip a side drawer
     setPanelOpen(side, bool), isOpen(side),
     destroy,
   }

   Layout: ≥ --rp-bp-lg (80rem) the three regions are a CSS grid; below, the
   center is the single column and left/right become FIXED off-canvas drawers
   over a shared scrim. Opening one closes the other (single overlay); a scrim
   click closes. Above the breakpoint the drawer state is dropped (the regions
   are inline again). Sole owner of every .rp-wsp* class (ui-fork-audit R4).
   knobs: --rp-wsp-left-w --rp-wsp-right-w */

import { el } from "../boot/dom.js";
import { register } from "../registry/component-registry.js";

export function mountWorkspacePanels(host) {
  const root = el("div", { class: "rp-wsp" });
  const left = el("div", { class: "rp-wsp-region rp-wsp-left" });
  const center = el("div", { class: "rp-wsp-region rp-wsp-center" });
  const right = el("div", { class: "rp-wsp-region rp-wsp-right" });
  const scrim = el("div", { class: "rp-wsp-scrim" });
  root.append(left, center, right, scrim);

  // ── narrow-viewport drawer (below --rp-bp-lg, 80rem): the side regions
  //    become off-canvas drawers. matchMedia is event-driven; classList only —
  //    no inline styles (ui-fork-audit R9-clean). ──────────────────────────
  const narrow = window.matchMedia("(max-width: 80rem)"); // --rp-bp-lg

  function regionFor(side) {
    return side === "left" ? left : side === "right" ? right : null;
  }
  function isOpen(side) {
    return !!regionFor(side)?.classList.contains("is-open");
  }
  function setPanelOpen(side, want) {
    const region = regionFor(side);
    if (!region) return;
    const open = !!want;
    // single overlay: opening one closes the other.
    if (open) {
      const other = side === "left" ? right : left;
      other.classList.remove("is-open");
    }
    region.classList.toggle("is-open", open);
    // the scrim shows whenever EITHER drawer is open.
    scrim.classList.toggle("is-open", left.classList.contains("is-open") || right.classList.contains("is-open"));
  }
  function togglePanel(side) {
    setPanelOpen(side, !isOpen(side));
  }

  scrim.addEventListener("click", () => {
    left.classList.remove("is-open");
    right.classList.remove("is-open");
    scrim.classList.remove("is-open");
  });

  // Crossing back to wide drops any drawer state (the regions are inline grid
  // columns again, no overlay).
  const onWideChange = (e) => {
    if (!e.matches) {
      left.classList.remove("is-open");
      right.classList.remove("is-open");
      scrim.classList.remove("is-open");
    }
  };
  narrow.addEventListener("change", onWideChange);

  host.append(root);
  return {
    el: root,
    left,
    center,
    right,
    togglePanel,
    setPanelOpen,
    isOpen,
    destroy: () => {
      narrow.removeEventListener("change", onWideChange);
      root.remove();
    },
  };
}

register("workspace-panels", mountWorkspacePanels);
