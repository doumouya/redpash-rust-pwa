// Profile page — the user's account surface. Skeleton; editable
// fields (name, email, avatar, prefs) land here next.

import { mountTopbar } from "/scripts/topbar.js";

export default function profile(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "profile", session });
  const who = app.querySelector("#rp-profile-who");
  if (who) {
    const name = session?.display_name || session?.username || "—";
    who.textContent = "Signed in as " + name;
  }
}
