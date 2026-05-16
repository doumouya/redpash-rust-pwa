// Settings page — edits `users.prefs jsonb` via PATCH /me.
//
// The prefs object is shallow-merged server-side, so we only send the
// keys we manage here. Other prefs (set elsewhere, e.g. by future
// pages) round-trip unchanged.

import { api } from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";

// Mirrors the default in styles/main.css :root. Kept here so the
// Reset button works even when no override is set on the user.
const DEFAULT_ACCENT = "#b3001b";

function applyAccent(value) {
  if (value) document.documentElement.style.setProperty("--rp-accent", value);
  else       document.documentElement.style.removeProperty("--rp-accent");
}

export default async function mount(root) {
  const form   = root.querySelector("#settings-form");
  const status = root.querySelector("#settings-status");
  status.textContent = "Loading…";

  let me;
  try { me = await api.get("/me"); }
  catch (err) { status.textContent = "Failed to load settings."; return; }

  const prefs = me.prefs ?? {};
  form.elements.accent.value  = prefs.accent  || DEFAULT_ACCENT;
  form.elements.density.value = prefs.density || "comfortable";
  status.textContent = "";

  root.querySelector("#settings-accent-reset").addEventListener("click", () => {
    form.elements.accent.value = DEFAULT_ACCENT;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const accent  = form.elements.accent.value;
    const density = form.elements.density.value;
    // Send `null` for accent when it matches the default so the stored
    // pref stays empty (server-side jsonb_strip would be nicer, but
    // shallow merge can't unset a key — we just write null).
    const body = {
      prefs: {
        accent:  accent === DEFAULT_ACCENT ? null : accent,
        density,
      },
    };
    const btn = form.querySelector("button[type='submit']");
    btn.disabled = true;
    try {
      const updated = await api.patch("/me", body);
      applyAccent(updated.prefs?.accent);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(`Save failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}
