// Settings page — app preferences. First fill: the theme picker
// (mirrors the topbar's toggle but exposed explicitly so it stays
// visible alongside future preference rows).

import { mountTopbar } from "/scripts/topbar.js";
import { applyTheme, currentTheme } from "/scripts/theme.js";

export default function settings(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "settings", session });

  const picker = app.querySelector("#rp-settings-theme");
  if (!picker) return;

  const paint = () => {
    const t = currentTheme();
    picker.querySelectorAll("[data-theme]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.theme === t);
    });
  };
  paint();
  picker.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme]");
    if (!btn) return;
    applyTheme(btn.dataset.theme);
    paint();
  });
}
