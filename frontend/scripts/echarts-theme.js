/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/echarts-theme.md */
// ECharts theme registration + resolver — shared across designer.js,
// echarts-kpi.js, and any page that paints a chart.
//
// One source of truth for our two RedPash themes (Mocha + Latte):
// the JSON files in /echarts-themes/redpash-{mocha,latte}.json.
// ensureRegisteredThemes() fetches both once per page-load and calls
// echarts.registerTheme. Returns a memoized promise; safe to await
// from every chart-init path without duplicating fetches.
//
// chartTheme() resolves the right theme NAME for the current chrome
// theme — Mocha when the page is dark, Latte when light. Pages that
// want a different theme pass the name to echarts.init directly;
// most consumers (Home / Monitoring / Profile) just use this default.
//
// The hand-rolled REDPASH_MOCHA / REDPASH_LATTE constants that used
// to live here were retired when the JSON files landed — keeping two
// copies of the same theme is the survival risk Em flagged when he
// asked for the refactor. JSON files are the canonical source; this
// module is the runtime wiring.

const THEME_NAMES = ["redpash-mocha", "redpash-latte"];
let registerP = null;

// Fetch + register both RedPash themes. Memoized — subsequent calls
// return the in-flight or resolved promise without re-fetching. Fire-
// and-forget from chart-init paths; the first chart on a cold load
// may paint with ECharts' default theme for the few ms before the
// JSON resolves (acceptable degradation; the SW caches the files
// after the first visit so subsequent loads are instant).
export function ensureRegisteredThemes() {
  if (registerP) return registerP;
  if (!window.echarts) return Promise.resolve();
  registerP = Promise.all(THEME_NAMES.map(async (name) => {
    try {
      const r = await fetch("/echarts-themes/" + name + ".json");
      if (!r.ok) return;
      const json = await r.json();
      window.echarts.registerTheme(name, json);
    } catch {
      /* silent — caller falls back to ECharts default theme */
    }
  }));
  return registerP;
}

// Returns "redpash-mocha" when the page chrome is dark (default),
// "redpash-latte" when light. Reads html[data-theme] first
// (set by tokens.css + the boot script in index.html), then falls
// back to the OS-level prefers-color-scheme.
export function chartTheme() {
  return resolveDark() ? "redpash-mocha" : "redpash-latte";
}

function resolveDark() {
  const t = document.documentElement?.dataset?.theme;
  if (t === "light") return false;
  if (t === "dark")  return true;
  return !window.matchMedia?.("(prefers-color-scheme: light)").matches;
}
