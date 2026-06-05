/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/audit/snapshot.md */
// UI snapshot — the page audits itself.
//
// When the SPA loads with `?audit=1` in the URL, every page mount
// triggers `captureSnapshot()` from this module — walks the rendered
// DOM, captures `getComputedStyle()` for the foundation atom catalog,
// and downloads a JSON file. Feed the captured files into
// `tools/ui-snapshot-audit/audit.js` to surface computed-style drift in the
// standard audit pipeline (audit.run / audit.finding / audit.run_diff).
//
// Per [[feedback-no-frameworks]] + Em's "tailor-made for our app"
// brief on UX/UI automation: this is intentionally NOT a pixel-diff
// regression tool. Pixel-diff (BackstopJS, Playwright `toHaveScreenshot`,
// reg-suit) carries font-rendering + anti-alias noise that has nothing
// to do with our actual UI changes. The atom catalog + computed-style
// snapshot tracks the design-system contract instead — every `.rt-*`
// foundation atom is supposed to compute to a known set of values per
// theme; drift on those values is what we want to catch.
//
// Architecture: the page self-reports rather than being driven by a
// headless browser. The "driver" is just whichever browser Em already
// has open with `?audit=1` pinned. Mirrors the wasm-bench harness's
// "the app reports its own state" pattern.

// Atom catalog — the foundation classes the design system contract
// guarantees. Start with the cross-page atoms (rail/topbar/page-shell
// territory) + the inspo-deck card vocabulary. Page-specific atoms
// (.rp-cases-detail, .rp-cases-board, etc.) get their own captures
// implicitly via the same walker on those routes.
//
// v1 is conservative — expand only when a real drift escapes (per
// [[feedback-process-oriented]]: the catalog grows in response to
// findings, not in anticipation of them). Co-owned with Torv's atom
// catalog in redtable-unification.md.
const ATOM_CATALOG = [
  ".rp-surface",
  ".rt-toolbar",
  ".rt-table-wrap",
  ".rp-pager",
  ".rt-card",
  ".rt-btn",
  ".rp-page__section",
  ".rp-page__head",
  ".rp-page__title",
  ".rp-chip-row",
  ".rp-chip",
  ".rp-avatar",
];

// Tracked computed-style properties — the design tokens' downstream
// effects. Each property's value crosses the design-system contract
// surface (token → atom → rendered value). Drift on any of these is
// what the snapshot exists to catch.
//
// Deliberately NOT capturing every getComputedStyle property — would
// produce a 300-key dict per atom and bury real drift in noise. The
// 14 below are the load-bearing ones for the inspo-deck "lifted card
// on calm bg" + "pill chip vocabulary" direction Em locked.
const TRACKED_PROPS = [
  "background-color",
  "color",
  "border-top-color",
  "border-bottom-color",
  "border-radius",
  "box-shadow",
  "padding",
  "margin",
  "font-size",
  "font-weight",
  "line-height",
  "display",
  "flex-direction",
  "gap",
];

/**
 * Capture a UI snapshot for the current page state. Returns the JSON-
 * serializable snapshot object — caller decides what to do with it
 * (download, post to an endpoint, log, …).
 *
 * Two requestAnimationFrame ticks before reading: lets any deferred
 * page-script async rendering (echarts mounts, redtable initial paint,
 * etc.) complete before we sample. Empirically sufficient for every
 * RedPash page tested; bumpable if a slow page surfaces drift here.
 *
 * `state` (v2) is an optional tag identifying the interactive UI state
 * the capture is recording. Default `null` (auto-captures on page
 * mount). Explicit values come from two sources:
 *   - The tab-change MutationObserver in main.js (state = the new
 *     `.rp-chip.is-active`'s `data-value` / textContent).
 *   - Manual capture button / `window.__rpCapture(state)` from
 *     devtools (state = whatever the operator types in).
 *
 * The state propagates into the JSON's `state` field + the filename
 * suffix + the audit.js finding_key encoding. v1 captures (no state
 * field) read as `state = "default"` on ingest — backward compatible.
 */
export async function captureSnapshot(state = null) {
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));

  const atoms = {};
  for (const sel of ATOM_CATALOG) {
    const els = document.querySelectorAll(sel);
    if (els.length === 0) {
      atoms[sel] = { found: false, instances: 0 };
      continue;
    }
    // v1 captures the FIRST instance only. Multi-instance divergence
    // (same selector, different computed values across the page) is a
    // real signal but a v2 concern — emits one finding per atom for now.
    const el = els[0];
    const cs = getComputedStyle(el);
    const styles = {};
    for (const prop of TRACKED_PROPS) {
      styles[prop] = cs.getPropertyValue(prop).trim();
    }
    atoms[sel] = { found: true, instances: els.length, styles };
  }

  return {
    route:       location.hash || "#/",
    theme:       document.documentElement.getAttribute("data-theme") || "dark",
    state:       state || "default",
    captured_at: new Date().toISOString(),
    viewport:    { width: window.innerWidth, height: window.innerHeight },
    atoms,
  };
}

/**
 * `?audit=2` — the full rendered-component inventory (distinct from the
 * `?audit=1` atom-drift snapshot above). Captures EVERY class the live DOM
 * renders in this state — incl. JS-built + `display:none`-present components
 * (redtable rows, chips, modal/dropdown portals, kanban cards, designer
 * canvas) that never appear in the static partials, which is exactly what a
 * source-only pass misses. Bucketed by shell region (topbar / rail / main) so
 * the consumer can map classes to the proposition's component groups.
 *
 * Consumed by `tools/lib/fe-inventory.js` → `tools/ui-doc-audit/audit.js`.
 */
export async function captureInventory(state = null) {
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));

  const class_counts = collectClasses();

  // region buckets — which classes render inside each shell region. A class
  // can appear in more than one region; that's fine (it's a set per region).
  const REGION_ROOTS = { topbar: ".rp-topbar", rail: ".rt-nav", main: ".rp-main" };
  const regions = {};
  for (const name in REGION_ROOTS) {
    const root = document.querySelector(REGION_ROOTS[name]);
    const set = new Set();
    if (root) {
      const els = root.querySelectorAll("*");
      for (const el of els) for (let i = 0; i < el.classList.length; i++) set.add(el.classList[i]);
    }
    regions[name] = Array.from(set).sort();
  }

  return {
    capture:     "inventory",          // discriminates from the v1 atom snapshot
    route:       location.hash || "#/",
    theme:       document.documentElement.getAttribute("data-theme") || "dark",
    state:       state || "default",
    captured_at: new Date().toISOString(),
    viewport:    { width: window.innerWidth, height: window.innerHeight },
    classes:      Object.keys(class_counts).sort(),
    class_counts: class_counts,
    regions:      regions,
  };
}

/**
 * Walk the live DOM under <body> and tally every class name → instance
 * count. <body> (not a scoped root) so modal/dropdown portals appended
 * outside the shell are caught. Returns a plain `{ class: count }` map.
 *
 * Virtualized lists (virtual-rows.js mounts only the ~visible window)
 * still surface their row/cell classes — the class SET is identical
 * whether 30 or 30k rows are mounted, which is exactly what an inventory
 * needs. Counts reflect only the mounted window (don't read row totals
 * off them).
 */
export function collectClasses() {
  const counts = Object.create(null);
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (const el of all) {
    const list = el.classList;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      counts[c] = (counts[c] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Download the snapshot as a JSON file. Filename encodes route + theme
 * so consecutive captures across SPA navigation don't overwrite each
 * other in the Downloads folder.
 *
 * The file format is the canonical input shape for
 * `tools/ui-snapshot-audit/audit.js` (Layer 2b) — that script reads the
 * captured JSONs, emits a standard `audit.json` for ingest, and the
 * existing `audit.run_diff` SQL function does the drift comparison.
 */
export function downloadSnapshot(snapshot) {
  const safeRoute = (snapshot.route || "root")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    || "root";
  // v2: state suffix in filename when non-default. Keeps v1 filenames
  // (`ui-snapshot__<route>__<theme>.json`) unchanged for default
  // page-mount captures; tagged captures get `__<state>` to avoid
  // overwriting the default snapshot in Downloads.
  const state = snapshot.state && snapshot.state !== "default"
    ? "_" + snapshot.state.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "")
    : "";
  const fname = `ui-snapshot__${safeRoute}__${snapshot.theme}${state}.json`;

  const blob = new Blob(
    [JSON.stringify(snapshot, null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  // Give the browser one tick to start the download, then clean up.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
