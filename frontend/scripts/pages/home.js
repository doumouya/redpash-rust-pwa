// Home page — frontend-reset scaffold.
//
// A blank canvas. The real home surface is rebuilt from the red-front
// prototype as decomposed atoms. For now it just names the signed-in
// user and offers a sign-out.

import { api } from "/scripts/api.js";

export default function home(app, { session }) {
  const who = app.querySelector("#rp-home-who");
  if (who) who.textContent = session?.display_name || session?.username || "—";

  app.querySelector("#rp-home-signout")?.addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });
}
