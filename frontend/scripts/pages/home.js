// Home — the org command center.
//
// Shell pattern shared with Workspace: a topbar over a greeting,
// then a rail (.rt-nav, static groups) on the left and a body view
// on the right. The rail tab routes to a per-entity body renderer.
//
// Phase 1 (this build): Projects tab is fully wired against the
// existing GET /api/projects. Other tabs render an honest
// "endpoint pending" stub citing the missing backend route — same
// discipline as the parity inventory's disabled tool buttons. See
// docs/internal/admin-monitoring-surfaces.md for the full IA + the
// wire contract Phase 2 wants from Gus.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

const STAGES = ["import", "clean", "report", "publish"];

// Declarative tab definitions — also drives the rail render. The
// `perm` field is non-load-bearing today (everyone is admin in
// pre-prod / solo-dev); kept so the RBAC switch later is filter,
// not rewrite. `endpoint` is the un-prefixed path (no /api/) — it's
// for the pending-stub display only, not a call site; keeping the
// /api/ prefix out lets the crossing audit not mistake it for one.
const TABS = [
  // ── ORG ────────────────────────────────────────────────────
  { group: "ORG",  key: "users",       label: "Users",       icon: "bi-people",        perm: "admin", endpoint: "/admin/users",       wired: false },
  { group: "ORG",  key: "companies",   label: "Companies",   icon: "bi-building",      perm: "admin", endpoint: "/admin/companies",   wired: false },
  { group: "ORG",  key: "memberships", label: "Memberships", icon: "bi-link-45deg",    perm: "admin", endpoint: "/admin/memberships", wired: false },
  // ── DATA ───────────────────────────────────────────────────
  { group: "DATA", key: "projects",    label: "Projects",    icon: "bi-folder",        perm: "user",  endpoint: "/projects",          wired: true  },
  { group: "DATA", key: "files",       label: "Files",       icon: "bi-file-earmark",  perm: "user",  endpoint: "/admin/files",       wired: false },
  { group: "DATA", key: "charts",      label: "Charts",      icon: "bi-bar-chart",     perm: "user",  endpoint: "/admin/charts",      wired: false },
  { group: "DATA", key: "steps",       label: "Steps",       icon: "bi-wrench",        perm: "admin", endpoint: "/admin/steps",       wired: false },
];

const GROUPS = [
  { name: "ORG",  mark: "OR", color: "mauve" },
  { name: "DATA", mark: "DA", color: "teal"  },
];

const DEFAULT_TAB = "projects";

export default function home(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "home", session });
  renderGreeting(app, session);

  const nav     = app.querySelector("#rpHomeNav");
  const navBody = app.querySelector("#rpHomeNavBody");
  const view    = app.querySelector("#rpHomeView");

  // ─── rail collapse — same affordance as the Workspace rail ───
  app.querySelector("#rpHomeNavCollapse").addEventListener("click", (e) => {
    nav.classList.toggle("compact");
    e.currentTarget.querySelector("i").className = nav.classList.contains("compact")
      ? "bi bi-chevron-double-right" : "bi bi-chevron-double-left";
  });

  // ─── render the rail (static groups → tabs) ──────────────────
  navBody.innerHTML = GROUPS.map(renderGroup).join("");
  // Expand both groups by default — the entity list is short and
  // there's no scroll cost.
  navBody.querySelectorAll(".rt-group").forEach((g) => g.classList.add("expanded"));

  // Active tab — from hash (?tab=<key>) or default.
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantTab = params.get("tab") || DEFAULT_TAB;
  activate(wantTab);

  // ─── rail click delegation ───────────────────────────────────
  navBody.addEventListener("click", (e) => {
    const head = e.target.closest(".rt-group-head");
    if (head) {
      head.closest(".rt-group").classList.toggle("expanded");
      return;
    }
    const tab = e.target.closest(".rt-tab");
    if (tab) {
      activate(tab.dataset.key);
    }
  });

  // ─── rail render helpers ─────────────────────────────────────
  function renderGroup(g) {
    const tabs = TABS.filter((t) => t.group === g.name);
    return ''
      + '<div class="rt-group">'
      +   '<button class="rt-group-head" type="button">'
      +     '<i class="bi bi-chevron-down rt-group-caret"></i>'
      +     '<span class="rt-group-mark" data-c="' + g.color + '">' + g.mark + '</span>'
      +     '<span class="rt-group-name">' + esc(g.name) + '</span>'
      +     '<span class="rt-group-count">' + tabs.length + '</span>'
      +   '</button>'
      +   '<div class="rt-group-body">'
      +     tabs.map(renderTab).join("")
      +   '</div>'
      + '</div>';
  }
  function renderTab(t) {
    const dot = t.wired ? '' : '<span class="rt-tab-dot is-warn" title="endpoint pending"></span>';
    return ''
      + '<button class="rt-tab" type="button" data-key="' + esc(t.key) + '">'
      +   '<i class="' + esc(t.icon) + ' rt-tab-icon"></i>'
      +   '<span class="rt-tab-name">' + esc(t.label) + '</span>'
      +   dot
      + '</button>';
  }

  // ─── tab activation ──────────────────────────────────────────
  function activate(key) {
    const tab = TABS.find((t) => t.key === key) || TABS.find((t) => t.key === DEFAULT_TAB);
    navBody.querySelectorAll(".rt-tab.active").forEach((t) => t.classList.remove("active"));
    const btn = navBody.querySelector('.rt-tab[data-key="' + cssEsc(tab.key) + '"]');
    if (btn) btn.classList.add("active");
    if (tab.wired) renderTabBody(tab);
    else renderPending(tab);
  }

  // ─── per-tab body renderers ──────────────────────────────────
  // Projects — fully wired against /api/projects (Phase 1).
  async function renderTabBody(tab) {
    if (tab.key !== "projects") { renderPending(tab); return; }
    view.innerHTML = ''
      + headHTML("Projects", "")
      + kpiStripHTML([
          { label: "Total",        id: "rp-kpi-projects" },
          { label: "With files",   id: "rp-kpi-with-files" },
          { label: "Avg cleanness", id: "rp-kpi-clean" },
          { label: "Active 7d",    id: "rp-kpi-active" },
        ])
      + '<div class="rp-home__board" id="rp-home-board" aria-busy="true">'
      +   '<p class="rp-home__state">Loading your projects…</p>'
      + '</div>';

    const board = view.querySelector("#rp-home-board");
    try {
      const data  = await api.get("/projects");
      const items = data?.items || [];
      paintProjectKpis(items);
      paintProjectBoard(board, items);
      view.querySelector(".rp-home__head-count").textContent = items.length
        ? items.length + (items.length === 1 ? " project" : " projects") : "";
    } catch (err) {
      board.setAttribute("aria-busy", "false");
      board.innerHTML = '<p class="rp-home__state">Couldn’t load your projects'
        + (err.status ? " (" + err.status + ")" : "") + ".</p>";
    }
  }

  function paintProjectKpis(items) {
    const withFiles = items.filter((p) => (p.file_count || 0) > 0).length;
    const cleans = items.map((p) => p.cleanness_pct).filter((v) => v != null);
    const avgClean = cleans.length
      ? Math.round(cleans.reduce((a, b) => a + b, 0) / cleans.length)
      : null;
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const active7d = items.filter((p) => {
      const t = Date.parse(p.updated_at);
      return Number.isFinite(t) && t >= weekAgo;
    }).length;
    setKpi("rp-kpi-projects", items.length);
    setKpi("rp-kpi-with-files", withFiles);
    setKpi("rp-kpi-clean", avgClean == null ? "—" : avgClean + "%");
    setKpi("rp-kpi-active", active7d);
  }

  function paintProjectBoard(board, items) {
    board.setAttribute("aria-busy", "false");
    if (!items.length) {
      board.innerHTML = '<p class="rp-home__state">No projects yet — '
        + 'scan a CSV from the <a href="#/login">landing page</a> to start.</p>';
      return;
    }
    board.innerHTML = items.map(projectCard).join("");
  }

  function projectCard(p) {
    const at = STAGES.indexOf(p.stage);
    const pipe = STAGES.map((s, i) => {
      const cls = i < at ? " is-done" : i === at ? " is-current" : "";
      return '<li class="rp-proj__step' + cls + '">' + cap(s) + "</li>";
    }).join("");
    const meta = [
      p.file_count + (p.file_count === 1 ? " file" : " files"),
      "updated " + fmtDate(p.updated_at),
    ].join("  ·  ");
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
    if (pct == null) return "";
    const v = Math.max(0, Math.min(100, pct));
    const band = v >= 80 ? "is-ok" : v >= 50 ? "is-warn" : "";
    return '<div class="rp-proj__cleanness">'
      +   '<div class="rp-proj__cleanness-track">'
      +     '<div class="rp-proj__cleanness-fill ' + band + '" style="width:' + v + '%"></div>'
      +   "</div>"
      +   '<span class="rp-proj__cleanness-label">' + Math.round(v) + "% clean</span>"
      + "</div>";
  }

  // Honest stub — what the tab WILL show + the endpoint that blocks it.
  function renderPending(tab) {
    view.innerHTML = ''
      + headHTML(tab.label, "")
      + '<div class="rp-home__pending">'
      +   '<h3 class="rp-home__pending-title">' + esc(tab.label) + ' — coming soon</h3>'
      +   '<p>The redtable for this entity lands when its backend list endpoint is in.</p>'
      +   '<span class="rp-home__pending-endpoint">GET ' + esc(tab.endpoint) + ' (under /api)</span>'
      +   '<p>Tracked in <code>docs/internal/admin-monitoring-surfaces.md</code> §6.</p>'
      + '</div>';
  }

  // ─── small render utilities ──────────────────────────────────
  function headHTML(title, count) {
    return '<header class="rp-home__head">'
      +   '<h2 class="rp-home__head-title">' + esc(title) + '</h2>'
      +   '<span class="rp-home__head-count">' + esc(count) + '</span>'
      + '</header>';
  }
  function kpiStripHTML(tiles) {
    return '<div class="rp-kpi-strip">'
      + tiles.map((t) =>
          '<div class="rp-kpi">'
          + '<span class="rp-kpi-label">' + esc(t.label) + '</span>'
          + '<span class="rp-kpi-value" id="' + esc(t.id) + '">—</span>'
          + '</div>'
        ).join("")
      + '</div>';
  }
  function setKpi(id, val) {
    const el = view.querySelector("#" + id);
    if (el) el.textContent = val;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
}

// Time-of-day salutation + first_name (display_name fallback).
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function cssEsc(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}
