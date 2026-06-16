/* format — tiny, shared display formatters (no deps, no DOM). Pages/components
   import these instead of re-declaring local helpers (the dedup the fe-framework
   audit flags). Lean has no i18n layer yet; these are locale-default + tolerant. */

/** An ISO timestamp → the browser-locale date+time string; "" for a falsy/absent
    value, the raw string if it isn't a parseable date. */
export const fmtDateTime = (s) => {
  if (!s) return "";
  try {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString();
  } catch {
    return String(s);
  }
};
