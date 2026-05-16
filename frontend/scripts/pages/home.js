// Home page — authenticated landing.
//
// A single dashboard card: recent-projects / latest-files minitables,
// a stat strip, and the upload zone. The four browse redtables
// (projects / files / reports / dashboards) moved to the dedicated
// /objects page — Home links into it from the stat buttons, the
// bottom-left float bar, and the minitable rows.
//
// Real backend wiring (no mock data):
//   • /api/projects                  recent-projects minitable + stats
//   • /api/projects/:rid/files       latest-files minitable
//   • /api/reports + /api/dashboards  the "Published" stat count
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
      avatar.style.backgroundImage = `url("${session.avatar_url}")`;
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
        const proj = await api.get("/projects").catch(() => ({ items: [] }));
        homeData.projects = proj.items ?? [];
        renderStep1Cards();
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
  // The dashboard needs: projects (recent-projects minitable + the
  // latest-files lookup + the Projects/Files stats) and reports +
  // dashboards (the Published stat). All three fetched in parallel;
  // each falls back to an empty list so one failure doesn't blank
  // the whole dashboard.
  const [projects, reports, dashboards] = await Promise.all([
    api.get("/projects").catch(() => ({ items: [] })),
    api.get("/reports").catch(() => ({ items: [] })),
    api.get("/dashboards").catch(() => ({ items: [] })),
  ]);
  homeData.projects   = projects.items   ?? [];
  homeData.reports    = reports.items    ?? [];
  homeData.dashboards = dashboards.items ?? [];
  renderStep1Cards();
  renderStats();
}

// ── Step 1 cards ───────────────────────────────────────────────────
const RECENT_SLOTS = 5;

// Score → color-class mapping. Mirrors the demo's `scoreClass()`:
//   ≥ 90  → green   (score-hi)
//   ≥ 60  → yellow  (score-mid)
//   <  60 → red     (score-lo)
function scoreClass(pct) {
  if (pct == null || isNaN(pct)) return "";
  return pct >= 90 ? "score-hi" : pct >= 60 ? "score-mid" : "score-lo";
}
function scoreChip(pct) {
  if (pct == null || isNaN(pct)) return "";
  return `<span class="rp-minitable-score ${scoreClass(pct)}">${Math.round(pct)}%</span>`;
}

// Project stage → .rp-badge--* color modifier. Matches demo
// (demos/index.html STAGE_CLR) with the addition of `purple` for
// Report — the demo uses accent for both Import and Report, but our
// home page already paints Step 4 (Report) purple, so we colour the
// badge to echo that.
const PROJECT_STAGE_BADGE = {
  import:  { cls: "rp-badge--accent", label: "Import"  },
  clean:   { cls: "rp-badge--yellow", label: "Clean"   },
  report:  { cls: "rp-badge--purple", label: "Report"  },
  publish: { cls: "rp-badge--green",  label: "Publish" },
};
function stageBadge(stage) {
  const cfg = PROJECT_STAGE_BADGE[(stage ?? "").toLowerCase()]
    ?? { cls: "rp-badge--muted", label: stage ?? "—" };
  return `<span class="rp-badge ${cfg.cls}">${esc(cfg.label)}</span>`;
}

// Project / file status → .rp-tag-* color modifier. Mirrors the demo's
// TAG_CLR table plus the extra in-flight statuses our backend emits.
const STATUS_TAG = {
  active:    "rp-tag-blue",
  published: "rp-tag-green",
  ready:     "rp-tag-green",
  clean:     "rp-tag-green",
  publish:   "rp-tag-green",
  draft:     "rp-tag-grey",
  archived:  "rp-tag-grey",
  analysing: "rp-tag-blue",
  cleaning:  "rp-tag-blue",
  queued:    "rp-tag-blue",
  uploading: "rp-tag-blue",
  error:     "rp-tag-red",
  failed:    "rp-tag-red",
};
function statusTag(status) {
  if (!status) return "";
  const key = String(status).toLowerCase();
  const cls = STATUS_TAG[key] ?? "rp-tag-grey";
  return `<span class="rp-tag ${cls}">${esc(key)}</span>`;
}

// Placeholder padding row — empty greyed-out cells so the table holds
// its 5-row height. Built dynamically so the meta column count matches
// whatever the real rows render.
const PLACEHOLDER_ROW = `
  <div class="rp-minitable-row rp-minitable-row--placeholder" aria-hidden="true">
    <span class="rp-minitable-name">—</span>
    <span class="rp-minitable-meta">
      <span class="rp-minitable-dim">—</span>
      <span class="rp-minitable-dim">—</span>
    </span>
  </div>
`;

function renderStep1Cards() {
  const root = window.__homeRoot;
  const projects = homeData.projects;

  // Recent projects — colorful demo composition: name + score% + file
  // count + stage badge + status tag. Always RECENT_SLOTS rows; padded
  // with placeholders so the mini-table keeps its visual weight.
  const recent = [...projects]
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, RECENT_SLOTS);
  const projList = root.querySelector("#hs1-projects");
  if (projList) {
    const real = recent.map((p) => `
      <a class="rp-minitable-row" href="#/cleaner?project=${encodeURIComponent(p.redpash_id)}">
        <span class="rp-minitable-name">${esc(p.name)}</span>
        <span class="rp-minitable-meta">
          ${scoreChip(p.cleanness_pct)}
          <span class="rp-minitable-dim">${p.file_count ?? 0} ${p.file_count === 1 ? "file" : "files"}</span>
          ${stageBadge(p.stage)}
          ${statusTag(p.status)}
        </span>
      </a>
    `).join("");
    const pad = PLACEHOLDER_ROW.repeat(RECENT_SLOTS - recent.length);
    projList.innerHTML = real + pad;
  }

  // Latest files — files variant from minitable.css docstring:
  // name + score + row count + col count + size + stage badge.
  // Files now carry a computed pipeline stage, same as projects.
  const recentName = root.querySelector("#hs1-recent-name");
  const filesList  = root.querySelector("#hs1-files");
  if (!recent.length) {
    if (recentName) recentName.textContent = "—";
    if (filesList)  filesList.innerHTML = `<div class="rp-minitable-empty">No files yet.</div>`;
    return;
  }
  const top = recent[0];
  if (recentName) recentName.textContent = top.name;
  if (filesList) {
    filesList.innerHTML = `<div class="rp-minitable-empty">Loading…</div>`;
    api.get(`/projects/${encodeURIComponent(top.redpash_id)}/files`)
      .then((res) => {
        const files = (res.items ?? []).slice(0, 5);
        if (!files.length) { filesList.innerHTML = `<div class="rp-minitable-empty">No files in this project yet.</div>`; return; }
        filesList.innerHTML = files.map((f) => `
          <a class="rp-minitable-row" href="#/cleaner?file=${encodeURIComponent(f.redpash_id)}">
            <span class="rp-minitable-name">${esc(f.filename)}</span>
            <span class="rp-minitable-meta">
              ${scoreChip(f.cleanness_pct)}
              <span class="rp-minitable-dim">${(f.row_count ?? 0).toLocaleString()}r</span>
              ${f.col_count != null ? `<span class="rp-minitable-dim">${f.col_count}c</span>` : ""}
              ${f.file_size_bytes != null ? `<span class="rp-minitable-size">${fmtSize(f.file_size_bytes)}</span>` : ""}
              ${stageBadge(f.stage)}
            </span>
          </a>
        `).join("");
      })
      .catch(() => { filesList.innerHTML = `<div class="rp-minitable-empty">Couldn't load files.</div>`; });
  }
}

// Bytes → human-readable. KB / MB / GB with one decimal except for KB.
function fmtSize(bytes) {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024 * 1024)  return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3)    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
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

  animateNumber(root.querySelector("#hs1-stat-projects"),  projects.length);
  animateNumber(root.querySelector("#hs1-stat-files"),     totalFiles);
  animateNumber(root.querySelector("#hs1-stat-published"), published);
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
// Only `esc` survives the redtable extraction — fmtDate / fmtBytes /
// projectName moved to objects.js with the redtable machinery, and
// fmtSize (above) is the dashboard's own byte formatter.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
