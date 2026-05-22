// Settings page — app preferences. Skeleton.

import { mountTopbar } from "/scripts/topbar.js";

export default function settings(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "settings", session });
}
