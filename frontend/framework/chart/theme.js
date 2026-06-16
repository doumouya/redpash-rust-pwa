/* chart/theme.js — ECharts theme registration + resolver. The four RedPash
   chart themes live as JSON in /echarts-themes/redpash-{mocha,latte,newdark,
   newlight}.json (one per app theme). ensureRegisteredThemes() fetches + registers
   them once per page-load (memoized). chartTheme() maps the current app theme
   (html[data-theme]) → its chart-theme name, so charts carry the RedPash identity.
   Ported from the prerelease echarts-theme.js. */

const THEME_NAMES = ["redpash-mocha", "redpash-latte", "redpash-newdark", "redpash-newlight"];

// html[data-theme] → chart theme name. Legacy catppuccin aliases kept so a
// stored legacy value still themes correctly.
const CHART_THEME = {
  "new-dark":         "redpash-newdark",
  "new-light":        "redpash-newlight",
  "dark":             "redpash-mocha",
  "catppuccin-mocha": "redpash-mocha",
  "light":            "redpash-latte",
  "catppuccin-latte": "redpash-latte",
};
let registerP = null;

/** Fetch + register the RedPash themes once (memoized). Fire-and-forget from
    chart-init paths; a cold first paint may use the ECharts default for a few ms. */
export function ensureRegisteredThemes() {
  if (registerP) return registerP;
  if (!window.echarts) return Promise.resolve();
  registerP = Promise.all(THEME_NAMES.map(async (name) => {
    try {
      const r = await fetch("/echarts-themes/" + name + ".json");
      if (!r.ok) return;
      window.echarts.registerTheme(name, await r.json());
    } catch {
      /* silent — caller falls back to ECharts default */
    }
  }));
  return registerP;
}

/** The chart-theme NAME for the current app theme (html[data-theme]); OS match
    as the fallback, defaulting to the new identity. */
export function chartTheme() {
  const t = document.documentElement?.dataset?.theme;
  if (t && CHART_THEME[t]) return CHART_THEME[t];
  const light = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return light ? "redpash-newlight" : "redpash-newdark";
}
