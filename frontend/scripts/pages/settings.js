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

  // SWR — paint from cache instantly if available, then await fresh
  // for the correction pass. Cold cache shows "Loading…" until fetch.
  const _hydrate = (me) => {
    const prefs = me.prefs ?? {};
    form.elements.accent.value  = prefs.accent  || DEFAULT_ACCENT;
    form.elements.density.value = prefs.density || "comfortable";
  };

  const { cached, fresh } = api.getCached("/me");
  let me = cached;
  if (me) { _hydrate(me); status.textContent = ""; }

  try { me = await fresh; _hydrate(me); status.textContent = ""; }
  catch (err) {
    if (!cached) { status.textContent = "Failed to load settings."; return; }
    // else: keep the cached values painted; correction pass will retry
    // on the next mount.
  }

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
      // PATCH /me returns UserProfile (no global_sentinels); invalidate
      // so loadSession re-fetches a full MeResponse next time.
      api.invalidateCached("/me");
      applyAccent(updated.prefs?.accent);
      toast.success("Settings saved.");
    } catch (err) {
      toast.error(`Save failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Tier 2 E — Settings only fetches /me; warm the list endpoints so
  // navigating back out (Home / Objects / Profile) paints instantly.
  api.prewarm(["/projects", "/files", "/reports", "/dashboards", "/users", "/companies"]);
}
