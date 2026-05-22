// Login page — frontend-reset scaffold.
//
// The blank sign-in surface. For now the one button hits the dev-login
// endpoint; real auth (Google OAuth) is rebuilt here later. After a
// successful login we full-reload into /home so the router boots with
// a fresh session.

import { api } from "/scripts/api.js";

export default function login(app) {
  const btn = app.querySelector("#rp-login-btn");
  const msg = app.querySelector("#rp-login-msg");

  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    if (msg) msg.textContent = "";
    try {
      await api.post("/auth/dev-login");
      location.hash = "#/home";
      location.reload();
    } catch (err) {
      btn.disabled = false;
      if (msg) {
        msg.textContent = err.status
          ? `Sign-in failed (${err.status}).`
          : "Sign-in failed — is the server running?";
      }
    }
  });
}
