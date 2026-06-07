/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/echarts-theme.md */
// ECharts theme registration + resolver — shared across designer.js,
// echarts-kpi.js, and any page that paints a chart.
//
// One source of truth for our four chart themes — the JSON files in
// /echarts-themes/redpash-{mocha,latte,newdark,newlight}.json (one per app
// theme). ensureRegisteredThemes() fetches all four once per page-load and
// calls echarts.registerTheme. Returns a memoized promise; safe to await
// from every chart-init path without duplicating fetches.
//
// chartTheme() resolves the right theme NAME for the current app theme via
// CHART_THEME — so charts carry the RedPash identity in new-dark/new-light
// and the catppuccin palette in mocha/latte. Pages that want a different
// theme pass the name to echarts.init directly.
//
// The hand-rolled REDPASH_MOCHA / REDPASH_LATTE constants that used
// to live here were retired when the JSON files landed — keeping two
// copies of the same theme is the survival risk Em flagged when he
// asked for the refactor. JSON files are the canonical source; this
// module is the runtime wiring.

// One chart theme per app theme. mocha/latte = the catppuccin palettes;
// newdark/newlight = the RedPash identity (red lead), generated from the
// former by gen-chart-themes.js with the new-theme --rp-* token values.
const THEME_NAMES = ["redpash-mocha", "redpash-latte", "redpash-newdark", "redpash-newlight"];

// html[data-theme] value → its chart theme. `dark`/`light` are the legacy
// catppuccin aliases (tokens.css aliases them too); keep both mapping so a
// stored legacy value still themes its charts correctly.
const CHART_THEME = {
  "new-dark":         "redpash-newdark",
  "new-light":        "redpash-newlight",
  "dark":             "redpash-mocha",
  "catppuccin-mocha": "redpash-mocha",
  "light":            "redpash-latte",
  "catppuccin-latte": "redpash-latte",
};
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

// Resolve the chart theme NAME for the current app theme. Reads
// html[data-theme] (set by tokens.css + index.html's pre-paint) and maps it
// via CHART_THEME so every one of the 4 themes gets its matching palette —
// new-dark/new-light render the RedPash identity, not the catppuccin fallback.
// No/unknown data-theme → match the OS, defaulting to the new identity.
export function chartTheme() {
  const t = document.documentElement?.dataset?.theme;
  if (t && CHART_THEME[t]) return CHART_THEME[t];
  const light = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return light ? "redpash-newlight" : "redpash-newdark";
}
