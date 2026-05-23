// Profile page — the user's account surface. First fill: render
// identity from the session (avatar + name + handle, mirrored in the
// account section). Editable fields and the rest land here next.

import { mountTopbar } from "/scripts/topbar.js";

export default function profile(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "profile", session });

  const name     = (session?.display_name || session?.username || "—").trim();
  const username = session?.username || "—";
  const initials = name && name !== "—"
    ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "··";

  const set = (sel, text) => {
    const el = app.querySelector(sel);
    if (el) el.textContent = text;
  };
  set("#rp-profile-avatar",   initials);
  set("#rp-profile-name",     name);
  set("#rp-profile-handle",   "@" + username);
  set("#rp-profile-display",  name);
  set("#rp-profile-username", username);
}
