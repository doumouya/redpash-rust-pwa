// Docs page — documentation. Skeleton.

import { mountTopbar } from "/scripts/topbar.js";

export default function docs(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "docs", session });
}
