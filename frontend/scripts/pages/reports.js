// Reports page — sandbox port Phase 1 (visual shell + drag-handle split).
//
// Phase 1 scope (this file):
//   • Pull in the partial subtree via rpInclude (router doesn't recurse
//     into data-include).
//   • Wire the horizontal drag handle that resizes the table / chart
//     pane split. Persists the split fraction to prefs.reports_split
//     on release; restores from prefs on next mount.
//
// Phase 2 (TODO):
//   • Source-file picker → real /api/projects + /api/files list, swap
//     the table contents on selection.
//   • +Chart modal submit → push a chart spec into STATE.charts, render
//     into [data-reports-chart-grid] (chart lib pick deferred).
//   • Save / Export → /api/reports POST + canvas-to-blob download.
//
// The old multi-file builder (/scripts/reports/index.js) is no longer
// called; it's preserved on disk while we wire the new layout but the
// old DOM hooks it expects (#reports-list, #reports-builder, etc.)
// don't exist in the new shell, so calling it would throw.

const DEFAULT_SPLIT = 0.60;   // table 60% / chart dock 40%
const MIN_SPLIT     = 0.20;   // don't let either pane shrink past 20%
const MAX_SPLIT     = 0.85;

export default async function mount(root, ctx) {
  // Sandbox subtree — router only loaded the thin shell; include.js's
  // recursive walker pulls in the rest. Without this the page renders
  // empty (mirrors cleaner.js / objects.js mount() pattern).
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[reports] rpInclude failed", err); }
  }

  // Restore saved split if the user has one.
  const savedSplit = Number(ctx?.session?.prefs?.reports_split);
  const split = Number.isFinite(savedSplit) && savedSplit >= MIN_SPLIT && savedSplit <= MAX_SPLIT
    ? savedSplit
    : DEFAULT_SPLIT;
  _applySplit(root, split);

  // Drag-handle wiring — pointer events (covers mouse + touch). The
  // handle straddles the split line; dragging adjusts the inline
  // height % on the table pane and the matching top % on the chart
  // pane. Once the user releases, persist via rpSavePref.
  const handle = root.querySelector("[data-reports-split-handle]");
  if (handle && !handle.__rpReportsBound) {
    handle.__rpReportsBound = true;
    let dragging = false;
    let bodyEl   = null;

    const startDrag = (ev) => {
      bodyEl = root.querySelector(".rp-rt-body");
      if (!bodyEl) return;
      dragging = true;
      handle.classList.add("is-dragging");
      handle.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    };
    const moveDrag = (ev) => {
      if (!dragging || !bodyEl) return;
      const rect = bodyEl.getBoundingClientRect();
      const y = (ev.clientY ?? ev.touches?.[0]?.clientY ?? 0) - rect.top;
      let frac = y / rect.height;
      if (frac < MIN_SPLIT) frac = MIN_SPLIT;
      if (frac > MAX_SPLIT) frac = MAX_SPLIT;
      _applySplit(root, frac);
    };
    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("is-dragging");
      handle.releasePointerCapture?.(ev.pointerId);
      // Persist whatever fraction the user landed on. The table pane's
      // inline height is the source of truth post-drag.
      const tablePane = root.querySelector("[data-reports-table-pane]");
      const pct = parseFloat(tablePane?.style.height || "");
      if (Number.isFinite(pct) && pct >= 1) {
        window.rpSavePref?.("reports_split", pct / 100);
      }
    };
    handle.addEventListener("pointerdown",   startDrag);
    handle.addEventListener("pointermove",   moveDrag);
    handle.addEventListener("pointerup",     endDrag);
    handle.addEventListener("pointercancel", endDrag);

    // Keyboard accessibility — arrow keys nudge the split by 2% steps.
    handle.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      const tablePane = root.querySelector("[data-reports-table-pane]");
      const cur = parseFloat(tablePane?.style.height || "") / 100;
      if (!Number.isFinite(cur)) return;
      const step = ev.key === "ArrowUp" ? -0.02 : 0.02;
      let next = cur + step;
      if (next < MIN_SPLIT) next = MIN_SPLIT;
      if (next > MAX_SPLIT) next = MAX_SPLIT;
      _applySplit(root, next);
      window.rpSavePref?.("reports_split", next);
      ev.preventDefault();
    });
  }
}

// Write the same fraction to all three split-aware elements so the
// table pane, chart pane, and handle stay aligned. Fraction is the
// table pane's height as a 0-1 number; chart pane fills the rest.
// Handle is biased up by 0.25rem so its 0.5rem hit area straddles the
// pane boundary line (matches the CSS calc()).
function _applySplit(root, frac) {
  const pct       = (frac * 100).toFixed(2) + "%";
  const handlePct = `calc(${pct} - 0.25rem)`;
  const tablePane = root.querySelector("[data-reports-table-pane]");
  const chartPane = root.querySelector("[data-reports-chart-pane]");
  const handle    = root.querySelector("[data-reports-split-handle]");
  if (tablePane) tablePane.style.height = pct;
  if (chartPane) chartPane.style.top    = pct;
  if (handle)    handle.style.top       = handlePct;
}
