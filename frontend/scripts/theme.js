// Theme — dark (default) ↔ light.
//
// The two palettes live in tokens.css: :root is dark, html[data-theme=
// "light"] overrides it. This module just flips the attribute and
// remembers the choice. index.html applies the saved value before
// first paint, so there's no flash of the wrong theme on load.

const KEY = "rp-theme";

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* private mode — non-fatal */ }
  return t;
}

export function toggleTheme() {
  return applyTheme(currentTheme() === "light" ? "dark" : "light");
}
