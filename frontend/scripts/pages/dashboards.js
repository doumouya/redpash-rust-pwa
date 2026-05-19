// Dashboards page — sandbox port Phase 1 (full canvas + floating tools).
//
// Phase 1 scope (this file):
//   • Pull in the partial subtree via rpInclude (router doesn't recurse
//     into data-include).
//   • Wire the floating tools window: drag (pointer events on the
//     header), collapse / restore (data-dashboards-tools-collapse), and
//     persist position + collapsed state via prefs.dashboards_tools_pos.
//   • Open the tools window by default so the canvas + tools both
//     read as part of the same interface on first mount.
//
// Phase 2 (TODO):
//   • Source-file picker → /api/files swap canvas data
//   • Template selector → write grid-template-columns/rows inline
//   • +Widget flow → push spec into STATE.widgets, render via
//     /scripts/dashboards/echarts.js + chart-render.js
//   • Save / Export → /api/dashboards POST + canvas-to-blob download
//
// The old multi-file delegator (/scripts/dashboards/index.js) is no
// longer called — its DOM hooks (#dashboards-list, #dashboards-builder)
// don't exist in the new shell. Kept on disk for revertability.

export default async function mount(root, ctx) {
  // Sandbox subtree — router only loaded the thin shell.
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[dashboards] rpInclude failed", err); }
  }

  // Open the tools window by default. spToggle from controls.js
  // toggles .open on the element; the matching CSS rule shows it.
  const win = root.querySelector("#dashboards-tools-window");
  if (win) win.classList.add("open");

  // Restore saved tools-window position + collapsed state.
  const savedPos = ctx?.session?.prefs?.dashboards_tools_pos;
  if (savedPos && typeof savedPos === "object" && win) {
    if (typeof savedPos.top === "number")  win.style.top    = savedPos.top + "px";
    if (typeof savedPos.left === "number") win.style.left   = savedPos.left + "px";
    if (typeof savedPos.top === "number")  win.style.bottom = "auto";
    if (typeof savedPos.left === "number") win.style.right  = "auto";
    if (savedPos.collapsed) win.classList.add("is-collapsed");
  }

  // Drag wiring — pointer events on the header. Header has CSS
  // cursor: grab; while dragging we add .is-dragging on the window
  // for the deeper shadow.
  const drag = root.querySelector("[data-dashboards-tools-drag]");
  if (drag && win && !drag.__rpBound) {
    drag.__rpBound = true;
    let dragging = false;
    let originLeft = 0, originTop = 0;
    let startX = 0,     startY = 0;
    let bodyEl  = null;

    const startDrag = (ev) => {
      // Ignore clicks on the buttons inside the header (collapse/close).
      if (ev.target.closest("button")) return;
      bodyEl = root.querySelector(".rp-rt-body");
      if (!bodyEl) return;
      const rect = win.getBoundingClientRect();
      const bodyRect = bodyEl.getBoundingClientRect();
      originLeft = rect.left - bodyRect.left;
      originTop  = rect.top  - bodyRect.top;
      startX = ev.clientX;
      startY = ev.clientY;
      dragging = true;
      win.classList.add("is-dragging");
      drag.setPointerCapture?.(ev.pointerId);
      // Switch from bottom/right anchoring to top/left so the inline
      // style updates land at predictable positions.
      win.style.bottom = "auto";
      win.style.right  = "auto";
      win.style.top    = originTop  + "px";
      win.style.left   = originLeft + "px";
      ev.preventDefault();
    };
    const moveDrag = (ev) => {
      if (!dragging || !bodyEl) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Clamp to body bounds so the window can't escape off-screen.
      const winRect  = win.getBoundingClientRect();
      const bodyRect = bodyEl.getBoundingClientRect();
      const maxLeft = bodyRect.width  - winRect.width;
      const maxTop  = bodyRect.height - winRect.height;
      let nextLeft = originLeft + dx;
      let nextTop  = originTop  + dy;
      nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
      nextTop  = Math.max(0, Math.min(nextTop,  maxTop));
      win.style.left = nextLeft + "px";
      win.style.top  = nextTop  + "px";
    };
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      win.classList.remove("is-dragging");
      drag.releasePointerCapture?.(ev.pointerId);
      // Persist position + collapsed state. dashboards_tools_pos shape:
      // { top: <number>, left: <number>, collapsed: <bool> }.
      const top  = parseFloat(win.style.top  || "");
      const left = parseFloat(win.style.left || "");
      if (Number.isFinite(top) && Number.isFinite(left)) {
        window.rpSavePref?.("dashboards_tools_pos", {
          top, left,
          collapsed: win.classList.contains("is-collapsed"),
        });
      }
    };
    drag.addEventListener("pointerdown",   startDrag);
    drag.addEventListener("pointermove",   moveDrag);
    drag.addEventListener("pointerup",     endDrag);
    drag.addEventListener("pointercancel", endDrag);
  }

  // Collapse toggle — minimize the body, keep the header bar. Persist
  // the collapsed state alongside the position via rpSavePref.
  const collapseBtn = root.querySelector("[data-dashboards-tools-collapse]");
  if (collapseBtn && win && !collapseBtn.__rpBound) {
    collapseBtn.__rpBound = true;
    collapseBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      win.classList.toggle("is-collapsed");
      const top  = parseFloat(win.style.top  || "");
      const left = parseFloat(win.style.left || "");
      window.rpSavePref?.("dashboards_tools_pos", {
        top:  Number.isFinite(top)  ? top  : undefined,
        left: Number.isFinite(left) ? left : undefined,
        collapsed: win.classList.contains("is-collapsed"),
      });
    });
  }
}
