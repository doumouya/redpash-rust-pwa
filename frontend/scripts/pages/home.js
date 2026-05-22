// Home page — authenticated landing.
//
// A pipeline board: every project as a card in its computed-stage
// column (import → clean → report → publish), above a slim strip with
// the greeting, the Projects/Files/Published counts, and the upload
// entry point. The four browse redtables moved to /objects — the stat
// buttons and the bottom-left float bar link into it.
//
// Real backend wiring (no mock data):
//   • /api/projects                  the board + the Projects/Files counts
//   • /api/reports + /api/dashboards  the "Published" count
//   • /api/files/upload              upload zone
//   • /api/me                        avatar initials
//   • /api/auth/logout               Log out float-btn
//
// Globals exposed for the partial's inline onclick handlers (the
// router can't run <script> in injected partials):
//   homeUpload(file) / homeOpenReview / homeUploadConfirm  — upload flow
//   doLogout()                       POST /api/auth/logout + reload
//   doContact()                      contact-modal stub

import { api }       from "/scripts/api.js";
import { toast }     from "/scripts/ui/toast.js";
import { openModal } from "/scripts/ui/modal.js";

// ── Dashboard data cache ───────────────────────────────────────────
// Home no longer hosts the browse redtables — those moved to the
// dedicated /objects page. It just needs the raw lists to paint the
// recent-projects / latest-files minitables and the stat strip.
const homeData = { projects: [], reports: [], dashboards: [] };

// ── Mount ──────────────────────────────────────────────────────────
export default async function mount(root, ctx) {
  // Stash root for later — handlers below resolve elements relative
  // to it so the page can re-mount without leaking listeners.
  window.__homeRoot = root;
  const session = ctx?.session ?? {};

  // Avatar from /api/me. Photo takes priority over initials when
  // session.avatar_url is set — applied as a CSS background-image so
  // the library's .rp-avatar { background-size: cover; background-
  // position: center } crops to a square inside the circle. Without
  // that, an <img> tag inherits the source resolution and visually
  // "zooms" inside the avatar bounds.
  const avatar = root.querySelector("#home-avatar");
  if (avatar) {
    const label = session.display_name ?? session.username ?? "··";
    const initials = label
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "··";
    if (session.avatar_url) {
      avatar.classList.remove("rp-initials");
      // Server-side proxy — see profile.js for the Firefox OBR rationale.
      avatar.style.backgroundImage = `url("/api/me/avatar")`;
      avatar.textContent = "";
      // Accessibility — keep the human-readable label as aria-label
      // since the photo replaces the visible initials.
      avatar.setAttribute("aria-label", label);
    } else {
      avatar.textContent = initials;
    }
  }

  // ── Inline-onclick globals ──────────────────────────────────────
  // Pending-upload buffer — held between the moment the user picks
  // files in the dropzone and the moment they click "Open in Data
  // Cleaner" in the file-review modal. window.handleFiles (library)
  // doesn't expose what it analysed, so we capture the File objects
  // ourselves here.
  let pendingFiles = [];

  // Single-file direct upload — kept for the Excel short-circuit and as
  // a programmatic entry point. CSV/TSV goes through homeOpenReview →
  // file-review modal → homeUploadConfirm.
  window.homeUpload = async (file) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    toast.info(`Uploading ${file.name}…`);
    try {
      const res = await api.post("/files/upload", form);
      toast.success(`${file.name} ready.`);
      location.hash = `#/cleaner?file=${encodeURIComponent(res.summary.redpash_id)}`;
    } catch (err) {
      toast.error(`Upload failed: ${err.body?.error ?? err.message}`);
    }
  };

  // CSV / TSV → text-based; library file-review.js can analyse client-side.
  // Excel / .xlsx etc → binary; library can't parse, so we skip the modal
  // and direct-upload (the Rust backend converts to CSV during ingest).
  const TEXT_RE  = /\.(csv|tsv)$/i;
  const EXCEL_RE = /\.(xlsx|xls|xlsm|xlsb|ods)$/i;

  // Entry point from the upload dropzone / file input / "+" buttons.
  // Routes CSVs through the file-review preview, Excel files straight
  // through the existing direct-upload path.
  window.homeOpenReview = async (filesList) => {
    const all   = Array.from(filesList);
    const text  = all.filter((f) => TEXT_RE.test(f.name));
    const excel = all.filter((f) => EXCEL_RE.test(f.name));
    const other = all.filter((f) => !TEXT_RE.test(f.name) && !EXCEL_RE.test(f.name));

    if (other.length) {
      toast.error(`Unsupported file${other.length > 1 ? "s" : ""}: ${other.map((f) => f.name).join(", ")}`);
    }

    // Excel files: server converts to CSV during ingest, so skip the
    // client-side analyser (which only reads text bytes) and upload
    // directly. If the user mixed CSV + Excel in the same drop, we
    // upload Excel first, then show the preview for the CSVs.
    for (const f of excel) {
      await window.homeUpload(f);
    }

    if (!text.length) return;
    pendingFiles = text;

    // Reset every dynamic slot in the modal to a placeholder BEFORE the
    // analyser runs. Without this, leftover state from the previous open
    // (e.g. a 5-column file analysed earlier) bleeds into the next render
    // until each region is rewritten — and any silent failure in the
    // library would leave the user looking at the previous file's stats.
    _resetFileReviewModal();

    // Library opens #modal-ul-review and analyses each file. handleFiles
    // picks #ul-review (single) or #ul-review-multi (multi) automatically.
    if (typeof window.handleFiles === "function") {
      window.handleFiles(text);
    } else {
      // file-review.js hasn't loaded yet (offline / cache miss) — fall
      // back to direct upload so the user isn't stuck.
      toast.info("Preview unavailable — uploading directly");
      for (const f of text) await window.homeUpload(f);
    }
  };

  // Wipe the modal back to em-dashes / empty containers. Called between
  // every open so a half-analysed previous file can't ghost into the
  // current one. Mirrors the static placeholders shipped in home.html.
  function _resetFileReviewModal() {
    const overlay = document.getElementById("modal-ul-review");
    if (!overlay) return;
    overlay.querySelectorAll(".rp-fr-fname").forEach((n)  => n.textContent = "—");
    overlay.querySelectorAll(".rp-fr-fmeta").forEach((n)  => n.textContent = "Analysing…");
    overlay.querySelectorAll(".rp-fr-legend").forEach((n) => n.innerHTML   = "");
    overlay.querySelectorAll(".rp-fr-hbars").forEach((n)  => n.innerHTML   = "");
    overlay.querySelectorAll(".rp-fr-issues").forEach((n) => n.innerHTML   = "");
    overlay.querySelectorAll("[data-fr-preview]").forEach((n)        => n.innerHTML   = "");
    overlay.querySelectorAll("[data-fr-preview-meta]").forEach((n)   => n.textContent = "—");
    overlay.querySelectorAll("[data-fr-detected-rows]").forEach((n)  => n.textContent = "—");
    overlay.querySelectorAll("[data-fr-detected-cols]").forEach((n)  => n.textContent = "—");
    overlay.querySelectorAll(".rp-fr-donut-pct").forEach((n) => {
      n.textContent = "—";
      n.style.color = "var(--muted)";
    });
    // Reset both painted circles back to zero-length dasharray so paintDonut()
    // gets a clean slate to draw the new percentage on.
    overlay.querySelectorAll(".rp-fr-donut-center svg circle").forEach((c, i) => {
      if (i === 0) return;                             // background track stays
      c.setAttribute("stroke-dasharray", "0 264");
      c.setAttribute("stroke-dashoffset", "66");
    });
  }

  // CTA from the file-review modal. POSTs each pending file in order,
  // then closes the modal and jumps to the cleaner for the first one
  // (or to /home step 2 — My Projects — when several files landed).
  window.homeUploadConfirm = async () => {
    const files = pendingFiles.slice();
    if (!files.length) { window.closeFileReview?.(); return; }

    // Require a project name (the library marks invalid as red via
    // updateFrNameValidity; we double-check here).
    const single = document.getElementById("fr-project-name");
    const multi  = document.getElementById("fr-mf-project-name");
    const nameInput = files.length === 1 ? single : multi;
    const projectName = (nameInput?.value ?? "").trim();
    if (!projectName) {
      if (nameInput) {
        nameInput.focus();
        nameInput.style.borderColor = "var(--red)";
      }
      toast.error("Please name the project");
      return;
    }

    // Close the modal + clear pending immediately so the UI is free
    // for the user to keep interacting with /home while uploads run.
    window.closeFileReview?.();
    pendingFiles = [];

    // Fire-and-forget: the user shouldn't wait on a multipart upload
    // before the UI responds. The toast surface narrates progress
    // (one info toast per file kick-off, one success/error per finish);
    // when every upload settles we refresh the redtables in place so
    // the new project / files appear in My Projects + My Files
    // without a navigation flash. Single-file uploads still auto-nav
    // to the cleaner — but only after the file row exists, so the
    // jump happens AFTER the backend is ready, not during.
    //
    // Note we deliberately don't await this; homeUploadConfirm returns
    // synchronously after closeFileReview so the click handler doesn't
    // hold the event loop while waiting on a network round-trip.
    //
    // Minimum perceptual delay: the Rust backend frequently round-trips
    // in well under 100ms. Without a floor, the auto-nav to /cleaner
    // fires before the modal has visibly closed and before the user
    // can register the "X ready." toast — feels like a click was lost.
    // 600ms gives the modal close + toast both a beat on screen.
    const MIN_VISIBLE_MS = 600;
    const minVisible = new Promise((r) => setTimeout(r, MIN_VISIBLE_MS));

    (async () => {
      const results = [];
      for (const f of files) {
        const form = new FormData();
        form.append("file", f);
        form.append("project_name", projectName);
        toast.info(`Uploading ${f.name}…`);
        try {
          const res = await api.post("/files/upload", form);
          toast.success(`${f.name} ready.`);
          results.push({ ok: true, rid: res.summary?.redpash_id });
        } catch (err) {
          toast.error(`Upload failed: ${f.name} — ${err.body?.error ?? err.message}`);
          results.push({ ok: false });
        }
      }

      const okList = results.filter((r) => r.ok);
      if (!okList.length) return;

      // Refresh the dashboard so the new project / files show up in the
      // recent-projects minitable + stat strip. We do this even for
      // single-file uploads because the user might cancel the auto-nav
      // (Escape during route change) and land back on /home expecting
      // to see what they just uploaded.
      try {
        // Post-upload refresh — re-fetch through getCached so the
        // localStorage cache is rewritten before the next mount reads it.
        // Without this, the SWR pattern at boot would paint stale
        // counts for one frame before the network correction.
        const proj = await api.getCached("/projects").fresh.catch(() => ({ items: [] }));
        homeData.projects = proj.items ?? [];
        renderBoard();
        renderStats();
      } catch {}

      // Auto-jump to the cleaner only when a single file was uploaded
      // and only AFTER the backend confirmed it. Multi-file stays on
      // /home — the user just minted a project, they probably want to
      // see it sitting in My Projects rather than be teleported into
      // an editor for just one of the files.
      //
      // Pause until BOTH the upload settled AND the visible-floor timer
      // elapsed, so a sub-100ms Rust round-trip doesn't make the modal
      // → cleaner transition feel like a stutter.
      if (files.length === 1 && okList[0].rid) {
        await minVisible;
        location.hash = `#/cleaner?file=${encodeURIComponent(okList[0].rid)}`;
      }
    })();
  };
  window.doLogout = async () => {
    try { await api.post("/auth/logout"); } catch {}
    location.hash = "#/landing";
    location.reload();
  };

  // Dev-only "log in as user" switcher (Home header → Switch user).
  // Lists every user; picking one mints a session as them via
  // POST /api/auth/dev-login, then reloads so the whole app
  // re-resolves to the new identity. Lets us test owner-scoped flows
  // (project reassignment, company membership) without juggling real
  // Google accounts. The endpoint 403s when the backend's
  // REDPASH_DEV_LOGIN flag is off — surfaced as an error toast.
  window.homeQuickLogin = async () => {
    let users;
    try {
      const res = await api.get("/users");
      users = res.items ?? [];
    } catch (err) {
      toast.error(`Couldn't load users: ${err.body?.error ?? err.message}`);
      return;
    }
    const list = document.createElement("div");
    list.className = "home-switch-list";
    list.innerHTML = users.map((u) => `
      <button type="button" class="home-switch-row" data-uid="${esc(u.redpash_id)}">
        <span class="home-switch-name">${esc(u.display_name)}</span>
        <span class="home-switch-sub">${esc(u.username)}${u.email ? " · " + esc(u.email) : ""}</span>
      </button>
    `).join("") || `<div class="rp-minitable-empty">No users.</div>`;

    const modal = openModal({ title: "Log in as user", body: list });

    list.addEventListener("click", async (e) => {
      const row = e.target.closest(".home-switch-row");
      if (!row) return;
      try {
        await api.post("/auth/dev-login", { user_id: row.dataset.uid });
        modal.close();
        location.hash = "#/home";
        location.reload();
      } catch (err) {
        toast.error(`Switch failed: ${err.body?.error ?? err.message}`);
      }
    });
  };

  // Contact form Send button — same stub as landing. Wire to a real
  // /api/contact endpoint when one lands.
  window.doContact = () => {
    toast.info("Contact form isn't wired yet — email hello@redpash.com for now.");
  };

  // ── Initial data load ──────────────────────────────────────────
  // SWR via api.getCached (Phase 1 A): localStorage cache from the
  // last visit paints synchronously while fresh GETs run in parallel.
  // Cold cache → same single-paint shape as before; warm cache →
  // dashboard renders instantly with last-known counts, then a
  // correction pass replaces them.
  //
  // Three lists fetched independently; each falls back to an empty
  // list on network failure so one failure doesn't blank the dashboard.
  const pCache = api.getCached("/projects");
  const rCache = api.getCached("/reports");
  const dCache = api.getCached("/dashboards");

  const _applyLists = (projects, reports, dashboards) => {
    homeData.projects   = projects?.items   ?? [];
    homeData.reports    = reports?.items    ?? [];
    homeData.dashboards = dashboards?.items ?? [];
    renderBoard();
    renderStats();
  };

  // Synchronous first paint from cache — only if at least one slice
  // has a cached value (else falls through to the network paint below
  // without an empty-state flash).
  if (pCache.cached || rCache.cached || dCache.cached) {
    _applyLists(pCache.cached, rCache.cached, dCache.cached);
  }

  // Correction pass — await all three, swallow per-list errors so a
  // single failure doesn't blank the whole dashboard.
  const [projects, reports, dashboards] = await Promise.all([
    pCache.fresh.catch(() => ({ items: [] })),
    rCache.fresh.catch(() => ({ items: [] })),
    dCache.fresh.catch(() => ({ items: [] })),
  ]);
  _applyLists(projects, reports, dashboards);

  // Tier 2 E — idle pre-warm the other pages' list endpoints so the
  // user's next click on Objects / Reports / Dashboards paints
  // instantly from cache. /me is already on a separate cache (Tier 1 B).
  api.prewarm(["/files", "/users", "/companies"]);
}

// ── Pipeline board ────────────────────────────────────────────────
// Four stage columns — import → clean → report → publish. Every
// project is a card in its computed-stage column; a card click jumps
// to the tool for that project's next pipeline step.
const STAGES = [
  { key: "import",  label: "Import",  hint: "Clean it",
    href: (p) => `#/cleaner?project=${encodeURIComponent(p.redpash_id)}` },
  { key: "clean",   label: "Clean",   hint: "Build a report",
    href: (p) => `#/reports?project=${encodeURIComponent(p.redpash_id)}` },
  { key: "report",  label: "Report",  hint: "Build a dashboard",
    href: (p) => `#/dashboards?project=${encodeURIComponent(p.redpash_id)}` },
  { key: "publish", label: "Publish", hint: "View it",
    href: (p) => `#/dashboards?project=${encodeURIComponent(p.redpash_id)}` },
];

// Score → color class. >=90 green · >=60 yellow · <60 red.
function scoreClass(pct) {
  if (pct == null || isNaN(pct)) return "";
  return pct >= 90 ? "score-hi" : pct >= 60 ? "score-mid" : "score-lo";
}
function scoreChip(pct) {
  if (pct == null || isNaN(pct)) return "";
  return `<span class="rp-pipe__score ${scoreClass(pct)}">${Math.round(pct)}%</span>`;
}

// Paint the four-column pipeline board from homeData.projects. Each
// project drops into the column for its computed `stage`; an unknown
// stage falls back to import.
function renderBoard() {
  const root = window.__homeRoot;
  const pipe = root?.querySelector("#home-pipe");
  if (!pipe) return;

  const byStage = { import: [], clean: [], report: [], publish: [] };
  for (const p of homeData.projects) {
    const s = String(p.stage ?? "import").toLowerCase();
    (byStage[s] ?? byStage.import).push(p);
  }

  pipe.innerHTML = STAGES.map((st) => {
    const col = (byStage[st.key] ?? [])
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    const cards = col.length
      ? col.map((p) => `
          <a class="rp-pipe__card" href="${st.href(p)}">
            <span class="rp-pipe__card-name">${esc(p.name)}</span>
            <span class="rp-pipe__card-meta">
              <span class="rp-pipe__card-files"><i class="bi bi-file-earmark-text"></i> ${p.file_count ?? 0}</span>
              ${scoreChip(p.cleanness_pct)}
            </span>
            <span class="rp-pipe__card-go">${esc(st.hint)} <i class="bi bi-arrow-right"></i></span>
          </a>`).join("")
      : `<div class="rp-pipe__empty">Nothing here yet</div>`;
    return `
      <section class="rp-pipe__col rp-pipe__col--${st.key}">
        <header class="rp-pipe__col-hdr">
          <span class="rp-pipe__col-dot"></span>
          <span class="rp-pipe__col-name">${st.label}</span>
          <span class="rp-pipe__col-count">${col.length}</span>
        </header>
        <div class="rp-pipe__col-body">${cards}</div>
      </section>`;
  }).join("");
}

// ── Stat strip ─────────────────────────────────────────────────────
function renderStats() {
  const root      = window.__homeRoot;
  const projects  = homeData.projects;
  const reports   = homeData.reports;
  const dashboards = homeData.dashboards;

  const totalFiles = projects.reduce((sum, p) => sum + (p.file_count ?? 0), 0);
  const published  = reports.filter((r) => r.is_public).length
                   + dashboards.filter((d) => d.is_public).length;

  animateNumber(root.querySelector("#home-stat-projects"),  projects.length);
  animateNumber(root.querySelector("#home-stat-files"),     totalFiles);
  animateNumber(root.querySelector("#home-stat-published"), published);
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

// ── Helpers ────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
