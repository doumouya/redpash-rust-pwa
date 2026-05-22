// Profile — full-bleed page: a shared rp-side-nav rail of section
// anchors + a scrolling pane of account sections. App preferences used
// to live here as an embedded "step 2"; they were lifted out to their
// own /settings page (scripts/pages/settings.js).
//
// Inline-onclick handlers wired here:
//   profilePhotoSelected(input)  avatar upload (stub)
//   profileUpgrade()             billing upgrade (stub)
//   profileDelete()              delete account (stub)
//
// Globals owned by main.js (shell): rpToggleTheme, rpSetTheme,
// openModal, closeModal, installPWA. doLogout is defined on /home,
// re-stubbed here so /profile works on cold-load too.

import { api }   from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";

export default async function mount(root) {
  // ── Scroll-snap nav ─────────────────────────────────────────────
  window.profileGoTo = (step) => {
    const card = root.querySelector(`.hs-card[data-step="${step}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "start", inline: "start" });
  };

  // ── Stubs for bits without backend endpoints yet ────────────────
  window.profilePhotoSelected = (input) => {
    if (input.files?.length) input.value = "";
    toast.info("Avatar upload lands with Phase 6 (Stripe + billing).");
  };
  window.profileUpgrade = () => toast.info("Upgrade flow lands with Phase 6.");
  window.profileDelete  = () => toast.info("Account deletion lands with Phase 4c+.");
  window.profileCopyId  = async () => {
    const rid = root.querySelector("#profile-rid")?.value ?? "";
    if (!rid) return;
    try {
      await navigator.clipboard.writeText(rid);
      toast.success("Account ID copied.");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access.");
    }
  };

  // Edit-mode toggle — the form starts locked. Click the pencil to
  // unlock; Save commits + re-locks; clicking the pencil again
  // discards anything not yet saved.
  window.profileToggleEdit = () => {
    const form = root.querySelector("#profile-form");
    const wasEditing = form.classList.contains("is-editing");
    setEditMode(root, !wasEditing);
  };

  // Defensive doLogout if main.js hasn't registered yet.
  if (!window.doLogout) {
    window.doLogout = async () => {
      try { await api.post("/auth/logout"); } catch {}
      location.hash = "#/landing";
      location.reload();
    };
  }
  if (!window.doContact) {
    window.doContact = () => toast.info("Contact form isn't wired yet — email hello@redpash.com.");
  }

  // ── Step-dot ↔ scroll-snap sync ────────────────────────────────
  const steps = root.querySelector("#profile-steps");
  const dots  = root.querySelectorAll(".rp-page-dot");
  const cards = root.querySelectorAll(".hs-card[data-step]");
  if (steps && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const step = +visible.target.dataset.step;
      dots.forEach((d) => d.classList.toggle("active", +d.dataset.step === step));
    }, { root: steps, threshold: 0.5 });
    cards.forEach((c) => io.observe(c));
  }

  // ── Load /me + populate Step 1 ─────────────────────────────────
  // SWR — paint from cache instantly, then await fresh and re-paint.
  // Cold cache → falls through to the network paint without an empty
  // state flash. PATCH /me invalidates the cache (see save handler
  // below) so coming back to /profile after a save re-fetches.
  const _hydrate = (me) => {
    populateIdentity(root, me);
    populateForm(root, me);
    populateConnections(root, me);
  };
  const { cached, fresh } = api.getCached("/me");
  let me = cached;
  if (me) _hydrate(me);
  try { me = await fresh; _hydrate(me); }
  catch (err) {
    if (!cached) { toast.error("Failed to load profile."); return; }
    // else: keep the cached paint; next mount retries the fetch.
  }

  // Form starts locked — user must click the pencil toggle to edit.
  setEditMode(root, false);

  // ── Use-case option pills ──────────────────────────────────────
  root.querySelectorAll("#profile-use-case .rp-set-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll("#profile-use-case .rp-set-opt").forEach((p) => {
        p.classList.toggle("active", p === btn);
      });
    });
  });

  // ── Save (PATCH /me) ───────────────────────────────────────────
  const form = root.querySelector("#profile-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ucEl = root.querySelector("#profile-use-case .rp-set-opt.active");
    const body = {
      display_name: root.querySelector("#profile-display-name").value.trim() || null,
      first_name:   root.querySelector("#profile-first-name").value.trim()   || null,
      last_name:    root.querySelector("#profile-last-name").value.trim()    || null,
      job_title:    root.querySelector("#profile-job-title").value.trim()    || null,
      organisation: root.querySelector("#profile-organisation").value.trim() || null,
      use_case:     ucEl?.dataset.value ?? null,
    };
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const updated = await api.patch("/me", body);
      // PATCH /me returns UserProfile (no global_sentinels); invalidate
      // so the next loadSession (or /profile mount) re-fetches a full
      // MeResponse rather than serving the stale cache.
      api.invalidateCached("/me");
      // Refresh identity header inline so name changes show without remount.
      root.querySelector("#profile-id-name").textContent  = updated.display_name ?? updated.username ?? "—";
      toast.success("Profile saved.");
      // Re-lock the form on success so the user can see the saved
      // state without accidentally typing into a "live" form.
      setEditMode(root, false);
    } catch (err) {
      toast.error(`Save failed: ${err.body?.error ?? err.message}`);
      btn.disabled = false;
    }
  });

  // ── Usage stats (fire-and-forget) ──────────────────────────────
  loadUsage(root).catch(() => {});

  // Tier 2 E — idle pre-warm. loadUsage already covers projects/
  // reports/dashboards; warm the rest so navigating to Objects /
  // Reports source-picker / Companies feels instant.
  api.prewarm(["/files", "/users", "/companies"]);
}

function populateIdentity(root, me) {
  const av = root.querySelector("#profile-avatar");
  const initials = initialsFrom(me.display_name ?? me.username);
  if (me.avatar_url) {
    // Server-side proxy — Firefox OBR blocks lh3.googleusercontent.com
    // when used as a CSS background-image. /api/me/avatar fetches +
    // caches the bytes server-side, so the browser sees a same-origin
    // image and skips the CORP check.
    av.style.backgroundImage = `url("/api/me/avatar")`;
    av.textContent = "";
  } else {
    av.textContent = initials;
  }
  root.querySelector("#profile-id-name").textContent  = me.display_name ?? me.username ?? "—";
  root.querySelector("#profile-id-email").textContent = me.email ?? "—";
  root.querySelector("#profile-plan-pill").textContent = labelForPlan(me.plan);
  root.querySelector("#profile-plan-name").textContent = labelForPlan(me.plan);
}

function populateForm(root, me) {
  root.querySelector("#profile-display-name").value = me.display_name ?? "";
  root.querySelector("#profile-first-name").value   = me.first_name ?? "";
  root.querySelector("#profile-last-name").value    = me.last_name ?? "";
  root.querySelector("#profile-username").value     = me.username ?? "";
  root.querySelector("#profile-email").value        = me.email ?? "";
  root.querySelector("#profile-job-title").value    = me.job_title ?? "";
  root.querySelector("#profile-organisation").value = me.organisation ?? "";
  root.querySelector("#profile-rid").value          = me.redpash_id ?? "";
  if (me.use_case) {
    root.querySelectorAll("#profile-use-case .rp-set-opt").forEach((p) => {
      p.classList.toggle("active", p.dataset.value === me.use_case);
    });
  }
}

function populateConnections(root, me) {
  const email   = me.email;
  const gEmail  = root.querySelector("#profile-google-email");
  const gState  = root.querySelector("#profile-google-state");
  if (email) {
    gEmail.textContent = email;
    gState.textContent = "Connected";
  } else {
    gEmail.textContent = "Not connected";
    gState.textContent = "Not connected";
    gState.style.cssText = ""; // drop the green styling
  }
  root.querySelector("#profile-billing-email").textContent = email ?? "—";
}

async function loadUsage(root) {
  // SWR (Phase 1 A) — paint usage counts from cache instantly, then
  // correct from fresh. animateNumber is idempotent; running it twice
  // with the same value is a no-op, with different values it animates
  // the delta cleanly so the correction pass feels natural.
  const pCache = api.getCached("/projects");
  const rCache = api.getCached("/reports");
  const dCache = api.getCached("/dashboards");

  const _apply = (projects, reports, dashboards) => {
    const proj  = projects?.items    ?? [];
    const rep   = reports?.items     ?? [];
    const dash  = dashboards?.items  ?? [];
    const fileCount = proj.reduce((s, p) => s + (p.file_count ?? 0), 0);
    animateNumber(root.querySelector("#profile-usage-projects"),   proj.length);
    animateNumber(root.querySelector("#profile-usage-files"),      fileCount);
    animateNumber(root.querySelector("#profile-usage-reports"),    rep.length);
    animateNumber(root.querySelector("#profile-usage-dashboards"), dash.length);
  };

  if (pCache.cached || rCache.cached || dCache.cached) {
    _apply(pCache.cached, rCache.cached, dCache.cached);
  }

  const [projects, reports, dashboards] = await Promise.allSettled([
    pCache.fresh, rCache.fresh, dCache.fresh,
  ]);
  _apply(projects.value, reports.value, dashboards.value);
}

// Lock / unlock the personal-info card.
//   editing = true  → editable inputs lose `readonly`, use-case pills
//                     become interactive, Save button enables, the
//                     toggle button reads "active" (accent fill +
//                     aria-pressed="true").
//   editing = false → reverse. Permanent-readonly inputs (username /
//                     email / redpash_id) are skipped because they
//                     don't have a `name` attribute.
function setEditMode(root, editing) {
  const form   = root.querySelector("#profile-form");
  const toggle = root.querySelector("#profile-edit-toggle");
  const save   = root.querySelector("#profile-save-btn");
  if (!form) return;

  form.classList.toggle("is-editing", editing);
  // Inputs with a `name` are the editable ones; readonly meta inputs
  // (username / email / Account ID) have no name and are skipped.
  form.querySelectorAll("input[name]").forEach((inp) => { inp.readOnly = !editing; });
  // Use-case pill group — disable interaction when locked.
  const grp = form.querySelector("#profile-use-case");
  if (grp) {
    grp.style.pointerEvents = editing ? "" : "none";
    grp.style.opacity       = editing ? "" : "0.55";
  }
  if (toggle) {
    toggle.classList.toggle("is-active", editing);
    toggle.setAttribute("aria-pressed", String(editing));
    toggle.title = editing ? "Lock fields" : "Edit mode";
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
function labelForPlan(plan) {
  return plan === "pro" ? "Pro" : plan === "trial" ? "30-day trial" : "Free";
}
function animateNumber(el, to) {
  if (!el) return;
  const dur = 900;
  const start = performance.now();
  function step(now) {
    const p = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(eased * to).toString();
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
