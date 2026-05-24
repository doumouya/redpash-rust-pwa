// Profile page — the user's account surface.
//
// Loads /api/me, paints the identity card + editable fields, and
// fetches usage counters from the existing CRUD lists (/projects,
// /charts, /dashboards). Edit-mode toggles the form between read-
// only and editable; Save fires PATCH /api/me with the changed
// fields and re-locks on success. Ported from main's Step-1 Profile,
// trimmed to the surface backed by existing endpoints.

import { api } from "/scripts/api.js";
import { mountTopbar } from "/scripts/topbar.js";

const USE_CASES = ["operational", "research", "reporting", "other"];

const PLAN_LABELS = {
  free:  "Free",
  pro:   "Pro",
  trial: "30-day trial",
};

export default async function profile(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "profile", session });

  let me;
  try {
    me = await api.get("/me");
  } catch (err) {
    app.querySelector(".rp-profile").innerHTML =
      '<p class="rp-page__placeholder">Couldn’t load profile'
      + (err?.status ? " (" + err.status + ")" : "") + '.</p>';
    return;
  }

  populateIdentity(app, me);
  populateForm(app, me);
  populateMemberships(app, me);
  populateConnections(app, me);
  setEditMode(app, false);
  loadUsage(app);

  // ── Use-case option pills ───────────────────────────────────────
  app.querySelectorAll("#rp-profile-use-case .rp-profile__opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Only respond when in edit mode — the pointer-events:none guard
      // in setEditMode handles the visual lock; this is the data guard.
      if (!app.querySelector("#rp-profile-form").classList.contains("is-editing")) return;
      app.querySelectorAll("#rp-profile-use-case .rp-profile__opt").forEach((p) => {
        p.classList.toggle("is-active", p === btn);
      });
    });
  });

  // ── Edit toggle ─────────────────────────────────────────────────
  app.querySelector("#rp-profile-edit").addEventListener("click", () => {
    const editing = app.querySelector("#rp-profile-form").classList.contains("is-editing");
    setEditMode(app, !editing);
  });

  // ── Save (PATCH /me) ────────────────────────────────────────────
  app.querySelector("#rp-profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ucEl = app.querySelector("#rp-profile-use-case .rp-profile__opt.is-active");
    const body = {
      display_name: app.querySelector("#rp-profile-display-name").value.trim() || null,
      job_title:    app.querySelector("#rp-profile-job-title").value.trim()    || null,
      use_case:     ucEl?.dataset.value ?? null,
    };
    const save = app.querySelector("#rp-profile-save");
    save.disabled = true;
    try {
      const updated = await api.patch("/me", body);
      // Re-paint identity inline so name changes show without remount.
      app.querySelector("#rp-profile-id-name").textContent =
        updated.display_name ?? updated.username ?? "—";
      const av = app.querySelector("#rp-profile-avatar");
      av.textContent = initialsFrom(updated.display_name ?? updated.username);
      setEditMode(app, false);
    } catch (err) {
      save.disabled = false;
      alert("Save failed" + (err?.status ? " (" + err.status + ")" : "") + ".");
    }
  });

  // ── Copy Account ID ─────────────────────────────────────────────
  app.querySelector("#rp-profile-copy").addEventListener("click", async () => {
    const rid = app.querySelector("#rp-profile-rid").value;
    try { await navigator.clipboard.writeText(rid); }
    catch { /* clipboard blocked (no https / no permission) — silent */ }
    const btn  = app.querySelector("#rp-profile-copy");
    const icon = btn.querySelector("i");
    const orig = icon.className;
    icon.className = "bi bi-check-lg";
    setTimeout(() => { icon.className = orig; }, 1200);
  });

}

function populateIdentity(app, me) {
  const av = app.querySelector("#rp-profile-avatar");
  if (me.avatar_url) {
    av.style.backgroundImage = `url("${me.avatar_url}")`;
    av.textContent = "";
  } else {
    av.textContent = initialsFrom(me.display_name ?? me.username);
  }
  app.querySelector("#rp-profile-id-name").textContent  = me.display_name ?? me.username ?? "—";
  app.querySelector("#rp-profile-id-email").textContent = me.email ?? "—";
  const planLabel = PLAN_LABELS[me.plan] ?? me.plan ?? "Free";
  app.querySelector("#rp-profile-plan-pill").textContent = planLabel;
  app.querySelector("#rp-profile-plan-name").textContent = planLabel;
}

function populateForm(app, me) {
  app.querySelector("#rp-profile-display-name").value = me.display_name ?? "";
  app.querySelector("#rp-profile-username").value     = me.username ?? "";
  app.querySelector("#rp-profile-email").value        = me.email ?? "";
  app.querySelector("#rp-profile-job-title").value    = me.job_title ?? "";
  app.querySelector("#rp-profile-rid").value          = me.redpash_id ?? "";
  if (me.use_case && USE_CASES.includes(me.use_case)) {
    app.querySelectorAll("#rp-profile-use-case .rp-profile__opt").forEach((p) => {
      p.classList.toggle("is-active", p.dataset.value === me.use_case);
    });
  }
}

// Real company affiliations from /me.memberships. Read-only here —
// joining / leaving / role changes happen on Home → Companies.
// Distinct from `users.organisation` (a free-text bio field that the
// Users tab on Home already moved away from for the same reason).
function populateMemberships(app, me) {
  const root = app.querySelector("#rp-profile-memberships");
  if (!root) return;
  const memberships = Array.isArray(me.memberships) ? me.memberships : [];
  if (!memberships.length) {
    root.innerHTML =
      '<span class="rp-profile__memberships-empty">'
      + 'Not a member of any company yet. '
      + '<a href="#/home?tab=companies">Open Companies</a> to create or join one.'
      + '</span>';
    return;
  }
  root.innerHTML = memberships.map((m) =>
    '<a class="rp-profile__membership" href="#/home?tab=companies" title="Open Companies">'
    + '<i class="bi bi-building rp-profile__membership-icon"></i>'
    + '<span class="rp-profile__membership-name">' + escHTML(m.company_name) + '</span>'
    + '<span class="rp-profile__membership-role rp-profile__membership-role--'
    +   escHTML(m.role) + '">' + escHTML(m.role) + '</span>'
    + '</a>'
  ).join("");
}

function escHTML(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function populateConnections(app, me) {
  const email   = me.email;
  const gEmail  = app.querySelector("#rp-profile-google-email");
  const gState  = app.querySelector("#rp-profile-google-state");
  if (email) {
    gEmail.textContent = email;
    gState.textContent = "Connected";
    gState.classList.add("is-connected");
  } else {
    gEmail.textContent = "Not connected";
    gState.textContent = "Not connected";
  }
}

// Counts the four entity types the Home page surfaces. Files count is
// summed from project.file_count so we don't need a dedicated endpoint.
// Charts substitutes for "Reports" on prerelease (the object model
// merged charts/reports into chart-typed project_files rows).
async function loadUsage(app) {
  const el = app.querySelector("#rp-profile-usage-chart");
  if (!el) return;
  const [projects, charts, dashboards] = await Promise.allSettled([
    api.get("/projects"),
    api.get("/charts"),
    api.get("/dashboards"),
  ]);
  const proj = projects.value?.items   ?? [];
  const ch   = charts.value?.items     ?? [];
  const dash = dashboards.value?.items ?? [];
  const fileCount = proj.reduce((s, p) => s + (p.file_count ?? 0), 0);
  paintUsageChart(el, [
    { name: "Dashboards", value: dash.length, hash: "#/home",                token: "--rp-ok"       },
    { name: "Charts",     value: ch.length,   hash: "#/home?tab=charts",     token: "--rp-mauve"    },
    { name: "Files",      value: fileCount,   hash: "#/home?tab=files",      token: "--rp-teal"     },
    { name: "Projects",   value: proj.length, hash: "#/home?tab=projects",   token: "--rp-accent-2" },
  ]);
}

// Horizontal bar chart via ECharts (loaded globally in index.html).
// Items are bottom-to-top in the order passed: ECharts paints the
// category axis upward, so we hand it Projects last to put it on top.
// Bars are clickable — each item carries `hash`, dispatched on click.
function paintUsageChart(el, items) {
  if (!window.echarts) {
    el.textContent = "Chart unavailable.";
    return;
  }
  const chart  = window.echarts.init(el);
  const text   = getCSSVar("--rp-text");
  const dim    = getCSSVar("--rp-text-dim");
  const mute   = getCSSVar("--rp-text-mute");
  const grid   = getCSSVar("--rp-border");
  chart.setOption({
    animation: true,
    animationDuration: 700,
    grid: { left: 90, right: 32, top: 8, bottom: 8, containLabel: false },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params) => {
        const p = params[0];
        return `<b>${p.name}</b> · ${p.value}`;
      },
    },
    xAxis: {
      type: "value",
      // Always show a sensible right edge even when every bar is 0.
      min: 0,
      axisLine:  { lineStyle: { color: grid } },
      axisLabel: { color: mute, fontSize: 10 },
      splitLine: { lineStyle: { color: grid, type: "dashed", opacity: 0.4 } },
    },
    yAxis: {
      type: "category",
      data: items.map((i) => i.name),
      axisLine:  { show: false },
      axisTick:  { show: false },
      axisLabel: { color: text, fontSize: 12, fontWeight: 600 },
    },
    series: [{
      type: "bar",
      barWidth: "60%",
      data: items.map((i) => ({
        value: i.value,
        itemStyle: { color: getCSSVar(i.token), borderRadius: [0, 4, 4, 0] },
        hash: i.hash,
      })),
      label: {
        show: true,
        position: "right",
        color: dim,
        fontSize: 12,
        fontWeight: 600,
        formatter: "{c}",
      },
      cursor: "pointer",
      emphasis: { itemStyle: { opacity: 0.85 } },
    }],
  });
  chart.on("click", (params) => {
    const h = params.data?.hash;
    if (h) location.hash = h;
  });
  chart.resize();
}

function getCSSVar(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || "#6c7086";
}

// Lock/unlock the personal-info card.
//   editing=true  → inputs lose `readonly`, use-case pills become
//                   interactive, Save enables, edit button reads
//                   as pressed.
//   editing=false → reverse. Readonly meta inputs (username, email,
//                   account id) have no name and are skipped.
function setEditMode(app, editing) {
  const form = app.querySelector("#rp-profile-form");
  const edit = app.querySelector("#rp-profile-edit");
  const save = app.querySelector("#rp-profile-save");
  if (!form) return;

  form.classList.toggle("is-editing", editing);
  form.querySelectorAll("input[name]").forEach((inp) => { inp.readOnly = !editing; });
  const grp = form.querySelector("#rp-profile-use-case");
  if (grp) {
    grp.style.pointerEvents = editing ? "" : "none";
    grp.style.opacity       = editing ? "" : "0.55";
  }
  if (edit) {
    edit.classList.toggle("is-active", editing);
    edit.setAttribute("aria-pressed", String(editing));
    edit.title = editing ? "Lock fields" : "Edit mode";
  }
  if (save) save.disabled = !editing;
}

function initialsFrom(label) {
  return (label ?? "")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "··";
}
