/* login — one primary action (Continue with Google). If OAuth is not
   configured on this deployment, say so honestly instead of showing a button
   that 503s (never render a control the backend can't honor). */

export default async function mount(root) {
  const note = root.querySelector('[data-pg="note"]');
  // Probe the start route HEAD-ish: a 503 means OAuth unconfigured.
  try {
    const resp = await fetch("/api/auth/google/start", { redirect: "manual" });
    if (resp.status === 503) {
      root.querySelector(".pg-auth-login-cta")?.remove();
      note.textContent =
        "Sign-in is not configured on this deployment. Set GOOGLE_OAUTH_* and restart.";
    }
  } catch {
    /* network hiccup — leave the button; clicking surfaces the real error */
  }
  return { destroy() {} };
}
