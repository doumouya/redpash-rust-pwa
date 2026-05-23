// Home page — the project launchpad.
//
// Three surfaces: a time-aware greeting (uses session.first_name /
// display_name), a 3-tile stats strip computed from /api/projects,
// and a board of project cards. Each card shows the pipeline stage
// + a cleanness bar coloured by score band.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

const STAGES = ["import", "clean", "report", "publish"];

export default function home(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "home", session });

  renderGreeting(app, session);

  const board = app.querySelector("#rp-home-board");
  const stats = app.querySelector("#rp-home-stats");
  const count = app.querySelector("#rp-home-count");

  loadProjects();

  async function loadProjects() {
    try {
      const data = await api.get("/projects");
      renderStats(data?.items || []);
      renderBoard(data?.items || []);
    } catch (err) {
      stats.setAttribute("aria-busy", "false");
      board.setAttribute("aria-busy", "false");
      board.innerHTML = '<p class="rp-home__state">Couldn’t load your projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</p>";
    }
  }

  function renderStats(items) {
    stats.setAttribute("aria-busy", "false");
    const totalFiles = items.reduce((acc, p) => acc + (p.file_count || 0), 0);
    const cleans = items.map((p) => p.cleanness_pct).filter((v) => v != null);
    const avgClean = cleans.length
      ? Math.round(cleans.reduce((a, b) => a + b, 0) / cleans.length)
      : null;
    app.querySelector("#rp-stat-projects").textContent = items.length;
    app.querySelector("#rp-stat-files").textContent = totalFiles;
    app.querySelector("#rp-stat-cleanness").textContent =
      avgClean == null ? "—" : avgClean + "%";
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
        + 'scan a CSV from the <a href="#/login">landing page</a> to start.</p>';
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
      "updated " + fmtDate(p.updated_at),
    ].filter(Boolean).join("  ·  ");
    return '<a class="rp-proj" href="#/workspace?project=' + encodeURIComponent(p.redpash_id) + '">'
      +   '<div class="rp-proj__top">'
      +     '<h2 class="rp-proj__name">' + esc(p.name) + "</h2>"
      +     (p.is_default ? '<span class="rp-proj__tag">default</span>' : "")
      +   "</div>"
      +   '<ol class="rp-proj__pipe">' + pipe + "</ol>"
      +   '<p class="rp-proj__meta">' + meta + "</p>"
      +   cleannessBar(p.cleanness_pct)
      + "</a>";
  }

  function cleannessBar(pct) {
    if (pct == null) return ""; // no signal — skip rather than mislead
    const v = Math.max(0, Math.min(100, pct));
    const band = v >= 80 ? "is-ok" : v >= 50 ? "is-warn" : "";
    return '<div class="rp-proj__cleanness">'
      +   '<div class="rp-proj__cleanness-track">'
      +     '<div class="rp-proj__cleanness-fill ' + band + '" style="width:' + v + '%"></div>'
      +   "</div>"
      +   '<span class="rp-proj__cleanness-label">' + Math.round(v) + "% clean</span>"
      + "</div>";
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

// Time-of-day salutation + the user's friendly name. first_name when
// available (most personal), display_name otherwise, "there" as a last
// resort so the greeting never reads as broken.
function renderGreeting(app, session) {
  const el = app.querySelector("#rp-home-greeting");
  if (!el) return;
  const hour = new Date().getHours();
  const tod  = hour < 5  ? "Good night"
            : hour < 12 ? "Good morning"
            : hour < 18 ? "Good afternoon"
            : hour < 22 ? "Good evening"
            :             "Good night";
  const name = session?.first_name || session?.display_name || "there";
  el.textContent = tod + ", " + name + ".";
}
