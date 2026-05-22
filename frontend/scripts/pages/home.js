// Home page — the project launchpad.
//
// Lists the signed-in user's projects (GET /api/projects) as a board
// of cards. Each card renders the project's place in the four-stage
// pipeline. Project create + click-through to the Workspace land when
// those pieces of the rebuild do.

import { api } from "/scripts/api.js";

const STAGES = ["import", "clean", "report", "publish"];

export default function home(app, { session }) {
  const who = app.querySelector("#rp-home-who");
  if (who) who.textContent = session?.display_name || session?.username || "—";

  app.querySelector("#rp-home-signout")?.addEventListener("click", async () => {
    try { await api.post("/auth/logout"); }
    catch { /* idempotent — clear the client session regardless */ }
    location.hash = "#/login";
    location.reload();
  });

  const board = app.querySelector("#rp-home-board");
  const count = app.querySelector("#rp-home-count");

  loadProjects();

  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      renderBoard(data?.items || []);
    } catch (err) {
      board.setAttribute("aria-busy", "false");
      board.innerHTML = '<p class="rp-home__state">Couldn’t load your projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</p>";
    }
  }

  function renderBoard(items) {
    board.setAttribute("aria-busy", "false");
    if (count) {
      count.textContent = items.length
        ? items.length + (items.length === 1 ? " project" : " projects")
        : "";
    }
    if (!items.length) {
      board.innerHTML = '<p class="rp-home__state">No projects yet — '
        + "upload a CSV to start your first one.</p>";
      return;
    }
    board.innerHTML = items.map(card).join("");
  }

  function card(p) {
    const at = STAGES.indexOf(p.stage);
    const pipe = STAGES.map((s, i) => {
      const cls = i < at ? " is-done" : i === at ? " is-current" : "";
      return '<li class="rp-proj__step' + cls + '">' + cap(s) + "</li>";
    }).join("");
    const meta = [
      p.file_count + (p.file_count === 1 ? " file" : " files"),
      p.cleanness_pct != null ? Math.round(p.cleanness_pct) + "% clean" : null,
      "updated " + fmtDate(p.updated_at),
    ].filter(Boolean).join("  ·  ");
    return '<a class="rp-proj" href="#/workspace">'
      +   '<div class="rp-proj__top">'
      +     '<h2 class="rp-proj__name">' + esc(p.name) + "</h2>"
      +     (p.is_default ? '<span class="rp-proj__tag">default</span>' : "")
      +   "</div>"
      +   '<ol class="rp-proj__pipe">' + pipe + "</ol>"
      +   '<p class="rp-proj__meta">' + meta + "</p>"
      + "</a>";
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
}
