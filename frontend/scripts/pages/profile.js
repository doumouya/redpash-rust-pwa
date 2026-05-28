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
import { mountRailFooterNav } from "/scripts/rail-footer.js";
import { kpiBarH } from "/scripts/echarts-kpi.js";
import { esc } from "/scripts/dom.js";
import { inputRow, mountRow } from "/scripts/page-row.js";

const USE_CASES = ["operational", "research", "reporting", "other"];

// Profile rail tabs — each section renders full-page on tab switch,
// like Home / Monitoring (Em 2026-05-28: consistent behavior across
// pages). The rail tab shows its target [data-prof-tab] panel + hides
// the rest. Default = Personal info. The Usage chart is lazy-rendered
// on first activation (ECharts can't size in a display:none tab).
const PROFILE_SECTIONS = [
  { id: "rp-profile-form", label: "Personal info", icon: "bi-person" },
  { id: "prof-usage",      label: "Usage",         icon: "bi-graph-up" },
  { id: "prof-plan",       label: "Plan",          icon: "bi-stars" },
  { id: "prof-connections",label: "Connections",   icon: "bi-plug" },
];

function mountProfileRail(app) {
  const body   = app.querySelector("#rpProfileNavBody");
  const panels = Array.from(app.querySelectorAll("[data-prof-tab]"));
  let usageLoaded = false;

  function activate(tabId) {
    panels.forEach((p) => { p.hidden = p.id !== tabId; });
    body?.querySelectorAll(".rt-tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.profTarget === tabId));
    // Usage's ECharts bar can't compute size while its tab is hidden —
    // render it the first time the tab actually becomes visible.
    if (tabId === "prof-usage" && !usageLoaded) {
      usageLoaded = true;
      loadUsage(app);
    }
  }

  if (body) {
    body.innerHTML = PROFILE_SECTIONS.map((s) =>
      '<a class="rt-tab" href="#/profile" data-prof-target="' + esc(s.id) + '">'
      +   '<i class="rt-tab-icon bi ' + s.icon + '"></i>'
      +   '<span class="rt-tab-name">' + esc(s.label) + '</span>'
      + '</a>'
    ).join("");
    body.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-prof-target]");
      if (!tab) return;
      e.preventDefault();
      activate(tab.dataset.profTarget);
    });
  }

  // Collapse toggle — same compact-mode affordance as the other rails.
  const rail     = app.querySelector("#rpProfileNav");
  const collapse = app.querySelector("#rpProfileNavCollapse");
  collapse?.addEventListener("click", () => {
    const compact = !rail?.classList.contains("compact");
    rail?.classList.toggle("compact", compact);
    const icon = collapse.querySelector("i");
    icon?.classList.toggle("bi-chevron-double-left", !compact);
    icon?.classList.toggle("bi-chevron-double-right", compact);
    collapse.title = compact ? "Expand" : "Collapse";
  });

  // Default landing tab — Personal info.
  activate(PROFILE_SECTIONS[0].id);
}

const PLAN_LABELS = {
  free:  "Free",
  pro:   "Pro",
  trial: "30-day trial",
};

// Personal-info form rows. inputRow + mountRow cover the 5 standard
// flavors; the Use case (custom button class) + Account ID (input +
// copy button) rows are structurally unique — inlined as raw HTML
// strings rather than over-parameterised into the shared helper.
// `hintClass: "rp-profile__hint"` per call because Settings + Profile
// carry separate hint-class tokens today.
const PROFILE_FORM_ROWS = [
  inputRow({
    label: "Display name",
    id: "rp-profile-display-name",
    name: "display_name",
    autocomplete: "name",
  }),
  inputRow({
    label: "Username",
    hint: "server-assigned, can't be edited",
    hintClass: "rp-profile__hint",
    id: "rp-profile-username",
  }),
  inputRow({
    label: "Email",
    hint: "from your Google account",
    hintClass: "rp-profile__hint",
    id: "rp-profile-email",
    type: "email",
  }),
  inputRow({
    label: "Job title",
    id: "rp-profile-job-title",
    name: "job_title",
    placeholder: "e.g. Data Analyst",
  }),
  mountRow({
    label: "Memberships",
    hint: "your real company affiliations — manage from Home → Companies",
    hintClass: "rp-profile__hint",
    id: "rp-profile-memberships",
    containerClass: "rp-profile__memberships",
    emptyClass: "rp-profile__memberships-empty",
  }),
  // Use case — custom button class (rp-profile__opt, not rt-btn);
  // group lacks data-pref (JS targets by id #rp-profile-use-case).
  '<div class="rp-page__row rp-page__row--col">'
    + '<span class="rp-page__row-label">Use case'
      + ' <small class="rp-profile__hint">helps RedPash tailor suggestions to your context</small>'
    + '</span>'
    + '<div class="rp-profile__opts" id="rp-profile-use-case">'
      + '<button type="button" class="rp-profile__opt" data-value="operational">Operational analysis</button>'
      + '<button type="button" class="rp-profile__opt" data-value="research">Student / Research</button>'
      + '<button type="button" class="rp-profile__opt" data-value="reporting">Business reporting</button>'
      + '<button type="button" class="rp-profile__opt" data-value="other">Other</button>'
    + '</div>'
  + '</div>',
  // Account ID — input + copy button, structurally unique.
  '<div class="rp-page__row">'
    + '<span class="rp-page__row-label">Account ID'
      + ' <small class="rp-profile__hint">reference this when contacting support</small>'
    + '</span>'
    + '<span class="rp-page__row-control rp-profile__rid-wrap">'
      + '<input id="rp-profile-rid" type="text" class="rp-input rp-profile__rid" readonly />'
      + '<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" id="rp-profile-copy" title="Copy ID to clipboard">'
        + '<i class="bi bi-clipboard"></i>'
      + '</button>'
    + '</span>'
  + '</div>',
];

function renderForm(app) {
  const mount = app.querySelector('[data-rp-rows="form"]');
  if (mount) mount.innerHTML = PROFILE_FORM_ROWS.join("");
}

export default async function profile(app, { session }) {
  mountTopbar(app.querySelector("#rp-topbar"), { active: "profile", session });
  mountRailFooterNav(app.querySelector(".rt-nav-foot"), { active: "profile", session });
  mountProfileRail(app);
  renderForm(app);

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
  // loadUsage is no longer called here — the Usage chart lazy-renders
  // on first activation of its tab (mountProfileRail), since ECharts
  // can't size a chart in a display:none panel.

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
    + '<span class="rp-profile__membership-name">' + esc(m.company_name) + '</span>'
    + '<span class="rp-profile__membership-role rp-profile__membership-role--'
    +   esc(m.role) + '">' + esc(m.role) + '</span>'
    + '</a>'
  ).join("");
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
    { name: "Dashboards", value: dash.length, hash: "#/home" },
    { name: "Charts",     value: ch.length,   hash: "#/home?tab=charts"   },
    { name: "Files",      value: fileCount,   hash: "#/home?tab=files"    },
    { name: "Projects",   value: proj.length, hash: "#/home?tab=projects" },
  ]);
}

// Horizontal bar via the shared kpiBarH helper — same renderer as
// the Home + Monitoring chart strips, so Profile inherits theme
// changes + future bar improvements without a separate code path.
// Items carry { name, value, hash }; kpiBarH preserves the hash on
// the series data, the click handler reads params.data.hash for the
// navigation. opts:
//   colorByData     — one palette colour per bar (per-data, not
//                     per-series) so Dashboards / Charts / Files /
//                     Projects each get a distinct hue.
//   showValueLabels — count next to each bar (the headline number).
//   cursor          — pointer; we wire .on("click") below for nav.
function paintUsageChart(el, items) {
  const inst = kpiBarH(el, items, {
    colorByData:     true,
    showValueLabels: true,
    cursor:          "pointer",
    sort:            "label",   // keep the caller-passed order (bottom→top)
  });
  if (!inst) { el.textContent = "Chart unavailable."; return; }
  inst.on("click", (params) => {
    const h = params.data?.hash;
    if (h) location.hash = h;
  });
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
    // The Edit pill carries a text label now (was icon-only) — keep
    // the wording honest when toggled. Icon swaps pencil↔lock to
    // reinforce the state in case the label is clipped on narrow.
    const editLabel = edit.querySelector("span");
    if (editLabel) editLabel.textContent = editing ? "Lock" : "Edit";
    const editIcon = edit.querySelector("i");
    if (editIcon) editIcon.className = editing ? "bi bi-lock" : "bi bi-pencil";
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
