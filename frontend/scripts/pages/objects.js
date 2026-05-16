// Objects page — the single browse surface for every object type.
//
// One redtable, six tabs: Projects · Files · Reports · Dashboards ·
// Companies · Users. Replaces the old Home steps 2–5 (four separate
// scroll-snap redtables) and the standalone /reports + /dashboards
// routes. Home keeps only its dashboard step; this page is where you
// browse / search / manage.
//
// Architecture — lifted near-verbatim from the old home.js redtable
// machinery, which was already schema-driven and `kind`-keyed:
//   • SCHEMAS    — one entry per kind: columns, fetch, rowHref,
//                  delete capability. (Search is generic — see
//                  `_objMatchesSearch` — it scans every column.)
//   • STATE      — per-kind cache of rows / search / page / mode / sel.
//   • currentKind — which tab is showing; the obj* handlers are
//                  kind-implicit (they read currentKind) so the single
//                  toolbar doesn't need the kind baked into every
//                  inline onclick.
//   • loadTable / renderTable / _renderObjSelChip — generic, keyed by kind.
//
// What's new vs. the old home version:
//   • Tab switching (objActivateTab) — one panel, swap the kind.
//   • files schema now has working delete + rename (the DELETE / PATCH
//     /api/files/:rid endpoints exist as of the overview work).
//   • reports / dashboards rows no longer navigate — their standalone
//     detail routes are gone; a viewer lands in a later slice.

import { api }       from "/scripts/api.js";
import { toast }     from "/scripts/ui/toast.js";
import { openModal } from "/scripts/ui/modal.js";
import { OBJECT_TAB_CATALOG, OBJECT_TAB_KEYS, normalizeObjectTabs }
  from "/scripts/objects-catalog.js";

// Project stage / status → a colored `.rp-badge` chip (library
// badge.css). Stage = pipeline (import → clean → report → publish);
// status = lifecycle (draft → active → archived). All seven keys are
// distinct so one map covers both columns; an unknown value falls back
// to a muted badge showing the raw string.
const _OBJ_BADGE = {
  import:    { cls: "rp-badge--accent", label: "Import"    },
  clean:     { cls: "rp-badge--yellow", label: "Clean"     },
  report:    { cls: "rp-badge--purple", label: "Report"    },
  publish:   { cls: "rp-badge--green",  label: "Publish"   },
  draft:     { cls: "rp-badge--yellow", label: "Draft"     },
  active:    { cls: "rp-badge--green",  label: "Active"    },
  archived:  { cls: "rp-badge--muted",  label: "Archived"  },
  published: { cls: "rp-badge--accent", label: "Published" }, // project status overlay — has a public dashboard
};
function _objBadge(value) {
  const cfg = _OBJ_BADGE[String(value ?? "").toLowerCase()]
    ?? { cls: "rp-badge--muted", label: value ?? "—" };
  return `<span class="rp-badge ${cfg.cls}">${esc(cfg.label)}</span>`;
}

// Boolean → a `true` / `false` badge that mirrors the stored DB value,
// so a real `false` is distinguishable from a null / missing value.
function _objBoolBadge(value) {
  return value
    ? `<span class="rp-badge rp-badge--green">true</span>`
    : `<span class="rp-badge rp-badge--muted">false</span>`;
}

// Render a nullable value, surfacing SQL NULL explicitly as a muted
// `null` badge so it can't be mistaken for an empty string or a
// boolean false. Non-null values render through `esc`.
function _objNullable(value) {
  return value == null
    ? `<span class="rp-badge rp-badge--muted">null</span>`
    : esc(value);
}

// Map a CSV delimiter byte to a human-readable cell label. Mirrors the
// four options the `delimiter` column's `enum` edit-cell offers (same
// four `parse_text`'s heuristic actually considers). Tab can't render
// as itself; null stays a null badge; anything else (a custom delim a
// user set via the API) renders escaped.
const _OBJ_DELIM_LABELS = { ",": "Comma (,)", ";": "Semicolon (;)", "\t": "Tab", "|": "Pipe (|)" };
function _objDelimLabel(value) {
  if (value == null) return _objNullable(null);
  return _OBJ_DELIM_LABELS[value] ?? esc(value);
}

// Star toggle for is_favorite cells (reports / dashboards). One-click
// toggle (vs the bool-edit double-click + Yes/No select pattern that
// every other bool field uses). Always-clickable, no mode required.
// Renders bi-star-fill in gold when on, bi-star (outline) in muted
// when off — same gold the reports-builder header star uses.
function _objStarBtn(rid, field, on) {
  return `<button type="button" class="obj-star-toggle ${on ? "is-on" : ""}"
    onclick="objToggleStar('${esc(rid)}', '${esc(field)}')"
    aria-label="${on ? "Unfavorite" : "Favorite"}"
    title="${on ? "Unfavorite" : "Favorite"}">
    <i class="bi ${on ? "bi-star-fill" : "bi-star"}"></i>
  </button>`;
}

// Stage ordering — used by _objRowOpenButtons to gate the
// New-report / New-dashboard affordances on the row's pipeline
// position. Higher rank = further along. Unknown stages rank 0
// so a missing/garbled value falls back to "only cleaner".
const _OBJ_STAGE_RANK = { import: 0, clean: 1, report: 2, publish: 3, published: 3 };
const _objStageRank = (s) => _OBJ_STAGE_RANK[String(s ?? "").toLowerCase()] ?? 0;

// Trailing per-row action cluster — up to three icon buttons in a
// fixed visual order: 🪄 cleaner · 📊 report · 📐 dashboard. The
// semantic of each button is kind-aware (open this row vs. open
// related data vs. create-next), but the icon-order is constant so the
// user learns where to look:
//
//   Files       cleaner(file)         report-new(source=file)   dash-new(project)
//   Projects    cleaner(project)      report-new                dash-new(project)
//   Reports     cleaner(source_file)  report-open(this)         dash-new(project)
//   Dashboards  cleaner(project)      report-new(project)       dash-open(this)
//
// Files / Projects gate the report+dashboard buttons by `stage` (no
// "new dashboard" on a row that hasn't even been cleaned). Reports +
// Dashboards rows always show the full triplet — they're already past
// the report stage by definition.
//
// All buttons open in a new tab so the Objects-page context stays put.
function _objRowOpenButtons(kind, row /*, schemaHref unused — built per-kind */) {
  const A = (href, title, icon) =>
    `<a class="rp-rt-action rp-rt-action--icon" href="${esc(href)}"
        target="_blank" rel="noopener" title="${esc(title)}">
       <i class="bi ${icon}"></i></a>`;

  const fid = row.redpash_id;
  const pid = row.project_redpash_id ?? (kind === "projects" ? row.redpash_id : null);
  const sfid = row.source_file_id;
  const rank = _objStageRank(row.stage);

  const btns = [];

  // ── 🪄 cleaner ────────────────────────────────────────────────────
  if (kind === "files") {
    btns.push(A(`#/cleaner?file=${encodeURIComponent(fid)}`,
                "Open in cleaner", "bi-magic"));
  } else if (kind === "projects") {
    btns.push(A(`#/cleaner?project=${encodeURIComponent(fid)}`,
                "Open project in cleaner", "bi-magic"));
  } else if (kind === "reports" && sfid) {
    btns.push(A(`#/cleaner?file=${encodeURIComponent(sfid)}`,
                "Open source file in cleaner", "bi-magic"));
  } else if (kind === "dashboards" && pid) {
    btns.push(A(`#/cleaner?project=${encodeURIComponent(pid)}`,
                "Open project in cleaner", "bi-magic"));
  }

  // ── 📊 report ─────────────────────────────────────────────────────
  if (kind === "reports") {
    // Open this report.
    btns.push(A(`#/reports?id=${encodeURIComponent(fid)}`,
                "Open this report", "bi-bar-chart-fill"));
  } else if (kind === "files" && rank >= 1) {
    btns.push(A(`#/reports?new=1&source=${encodeURIComponent(fid)}`,
                "New report from this file", "bi-bar-chart-fill"));
  } else if (kind === "projects" && rank >= 1) {
    btns.push(A(`#/reports?new=1`,
                "New report in this project", "bi-bar-chart-fill"));
  } else if (kind === "dashboards") {
    btns.push(A(`#/reports?new=1`,
                "New report for this project", "bi-bar-chart-fill"));
  }

  // ── 📐 dashboard ──────────────────────────────────────────────────
  if (kind === "dashboards") {
    btns.push(A(`#/dashboards?id=${encodeURIComponent(fid)}`,
                "Open this dashboard", "bi-grid-1x2-fill"));
  } else if (pid && ((kind === "files" || kind === "projects") ? rank >= 2 : true)) {
    btns.push(A(`#/dashboards?new=1&project=${encodeURIComponent(pid)}`,
                "New dashboard for this project", "bi-grid-1x2-fill"));
  }

  return btns.join("");
}

// ── Schema registry ────────────────────────────────────────────────
const SCHEMAS = {
  projects: {
    label:    "Projects",
    title:    "My Projects",
    icon:     "bi-folder2-open",
    fetch:    () => api.get("/projects"),
    columns:  [
      // name + description are inline-editable (type:"text" → PATCH
      // /api/projects/:rid via the schema saveEdit below).
      // Name renders as an anchor to the project's cleaner — matches
      // `rowHref` so a click here lands in the same place a row click
      // does, plus the user gets browser "open in new tab" via the
      // anchor semantics that pure-JS row clicks don't give them.
      { key: "name",        label: "Name",
        render: (r) => `<a class="obj-cell-link" href="#/cleaner?project=${esc(r.redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.name)}</a>`,
        edit: { type: "text", field: "name" } },
      { key: "file_count",  label: "Files",       render: (r) => `${r.file_count ?? 0}` },
      // stage is computed (the furthest stage of any file in the
      // project) — read-only badge, no edit. status is the stored
      // column (inline-editable via type:"enum"); the backend overlays
      // a read-only "published" value when the project has a public
      // dashboard, which the badge map renders but the edit list omits.
      { key: "stage",       label: "Stage",       render: (r) => _objBadge(r.stage) },
      { key: "status",      label: "Status",      render: (r) => _objBadge(r.status),
        edit: { type: "enum", field: "status",
                options: [["draft","Draft"],["active","Active"],["archived","Archived"]] } },
      { key: "updated_at",  label: "Modified",    render: (r) => fmtDate(r.updated_at) },
      // Available-but-hidden by default — toggle on via the Columns
      // dropdown.
      { key: "description",        label: "Description", hidden: true,
        render: (r) => _objNullable(r.description),
        edit: { type: "text", field: "description" } },
      // Project ID — hidden by default; when toggled on it renders
      // as a monospaced anchor to the cleaner (same destination as
      // the Name link + rowHref) so the user can copy the rid or
      // open the project in a new tab from this cell directly.
      { key: "redpash_id",         label: "Project ID",  hidden: true,
        render: (r) => `<a class="obj-cell-link obj-cell-id" href="#/cleaner?project=${esc(r.redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.redpash_id)}</a>` },
      { key: "owner_display_name", label: "Owner",       hidden: true,
        render: (r) => esc(r.owner_display_name ?? "—"),
        edit: { type: "select", field: "owner_id" } },
      { key: "owner_username",     label: "Username",    hidden: true,
        render: (r) => esc(r.owner_username ?? "—"),
        edit: { type: "select", field: "owner_id" } },
      { key: "is_default",         label: "Default",     hidden: true,
        render: (r) => _objBoolBadge(r.is_default),
        edit: { type: "bool", field: "is_default" } },
    ],
    rowHref:   (r) => `#/cleaner?project=${encodeURIComponent(r.redpash_id)}`,
    canDelete: true,
    // The default project can't be deleted — every user keeps exactly
    // one default workspace. `canDeleteRow` disables the trash button
    // for it; the backend enforces the same rule (400 `is_default`).
    canDeleteRow: (r) => !r.is_default,
    deleteOne: (rid) => api.delete(`/projects/${rid}`),
    // Inline edit commits name / description (text), is_default (bool
    // toggle), owner_id (user-picker select) and status (enum select)
    // via a sparse PATCH. stage is computed — not editable.
    saveEdit:  (rid, field, value) => api.patch(`/projects/${rid}`, { [field]: value }),
  },
  files: {
    label:    "Files",
    title:    "My Files",
    icon:     "bi-file-earmark-text",
    fetch:    () => api.get("/files"),
    columns:  [
      // edit:text — dblclick the File cell in edit mode → inline rename
      // (PATCH display_name via the schema's saveEdit below).
      { key: "filename",   label: "File",     render: (r) => esc(r.display_name ?? r.filename),
        edit: { type: "text", field: "display_name" } },
      // Project — edit:select (source:"projects") moves the file to
      // another of the owner's projects (PATCH project_redpash_id).
      { key: "project",    label: "Project",  render: (r) => esc(projectName(r.project_redpash_id)),
        edit: { type: "select", field: "project_redpash_id", source: "projects" } },
      // stage is computed (import → clean → report → publish, derived
      // from steps / reports / dashboards) — read-only badge, no edit.
      { key: "stage",      label: "Stage",    render: (r) => _objBadge(r.stage) },
      { key: "row_count",  label: "Rows",     render: (r) => (r.row_count ?? 0).toLocaleString() },
      { key: "col_count",  label: "Cols",     render: (r) => `${r.col_count ?? 0}` },
      { key: "cleanness",  label: "Clean",    render: (r) => r.cleanness_pct != null ? `${Math.round(r.cleanness_pct)}%` : _objNullable(null) },
      { key: "file_size",  label: "Size",     render: (r) => fmtBytes(r.file_size_bytes) },
      { key: "updated_at", label: "Modified", render: (r) => fmtDate(r.updated_at) },
      // Available-but-hidden by default — toggle on via the Columns dropdown.
      { key: "file_type",          label: "Type",       hidden: true, render: (r) => esc(r.file_type) },
      // encoding — edit:text (PATCH), validated server-side via
      // encoding_rs. Null shows a `null` badge.
      { key: "encoding",           label: "Encoding",   hidden: true, render: (r) => _objNullable(r.encoding),
        edit: { type: "text", field: "encoding" } },
      // delimiter — curated enum dropdown of the four common CSV
      // delimiters (the same four parse_text's heuristic considers).
      // Render rewrites `\t` as `Tab` so the cell is readable; null
      // shows a `null` badge.
      { key: "delimiter",          label: "Delimiter",  hidden: true, render: (r) => _objDelimLabel(r.delimiter),
        edit: { type: "enum", field: "delimiter",
                options: [[",", "Comma (,)"], [";", "Semicolon (;)"], ["\t", "Tab"], ["|", "Pipe (|)"]] } },
      { key: "created_at",         label: "Created",    hidden: true, render: (r) => fmtDate(r.created_at) },
      { key: "project_redpash_id", label: "Project ID", hidden: true, render: (r) => esc(r.project_redpash_id) },
      { key: "redpash_id",         label: "File ID",    hidden: true, render: (r) => esc(r.redpash_id) },
    ],
    rowHref:   (r) => `#/cleaner?file=${encodeURIComponent(r.redpash_id)}`,
    canDelete: true,
    deleteOne: (rid) => api.delete(`/files/${rid}`),
    // Inline cell edit — objCellEdit calls this to commit an edit:text
    // column's new value as a typed PATCH.
    saveEdit:  (rid, field, value) => api.patch(`/files/${rid}`, { [field]: value }),
  },
  reports: {
    label:    "Reports",
    title:    "My Reports",
    icon:     "bi-bar-chart-fill",
    fetch:    () => api.get("/reports"),
    columns:  [
      // edit:open — dblclick the Title cell in edit mode opens the
      // report builder (full spec editing lives there).
      { key: "title",       label: "Title",    render: (r) => esc(r.title),
        edit: { type: "open" } },
      { key: "folder",      label: "Folder",   render: (r) => esc(r.folder ?? "—") },
      // is_favorite / is_public — bool toggles in edit mode (PATCH the
      // boolean), matching projects' is_default treatment.
      { key: "is_favorite", label: "★",        render: (r) => _objStarBtn(r.redpash_id, "is_favorite", r.is_favorite) },
      { key: "is_public",   label: "Public",   render: (r) => _objBoolBadge(r.is_public),
        edit: { type: "bool", field: "is_public" } },
      { key: "updated_at",  label: "Modified", render: (r) => fmtDate(r.updated_at) },
      // Available-but-hidden by default — toggle on via the Columns dropdown.
      // description — inline-editable text via PATCH; null shows a `null` badge.
      { key: "description",        label: "Description", hidden: true,
        render: (r) => _objNullable(r.description),
        edit: { type: "text", field: "description" } },
      { key: "created_at",         label: "Created",     hidden: true, render: (r) => fmtDate(r.created_at) },
      { key: "source_file_id",     label: "Source file", hidden: true, render: (r) => esc(r.source_file_id) },
      { key: "project_redpash_id", label: "Project ID",  hidden: true, render: (r) => esc(r.project_redpash_id) },
      { key: "redpash_id",         label: "Report ID",   hidden: true, render: (r) => esc(r.redpash_id) },
      // Owner — joined via projects.owner_id → users. Read-only on the
      // Reports tab (reassignment lives on the parent project).
      { key: "owner_display_name", label: "Owner",       hidden: true,
        render: (r) => esc(r.owner_display_name ?? "—") },
      { key: "owner_username",     label: "Username",    hidden: true,
        render: (r) => esc(r.owner_username ?? "—") },
    ],
    // The /reports route is hidden from the nav but still hosts the
    // report builder — rows open it (click) and edit:open opens it too.
    rowHref:   (r) => `#/reports?id=${encodeURIComponent(r.redpash_id)}`,
    canDelete: true,
    deleteOne: (rid) => api.delete(`/reports/${rid}`),
    openEditor: (rid) => { location.hash = `#/reports?id=${encodeURIComponent(rid)}`; },
    addHref:   "#/reports?new=1",
    // Inline cell edit — objCellEdit calls this to commit the
    // description / is_favorite / is_public PATCH. Backend has a sparse
    // PatchReportBody — see api/routes/reports.rs.
    saveEdit:  (rid, field, value) => api.patch(`/reports/${rid}`, { [field]: value }),
  },
  dashboards: {
    label:    "Dashboards",
    title:    "My Dashboards",
    icon:     "bi-grid-1x2-fill",
    fetch:    () => api.get("/dashboards"),
    columns:  [
      // edit:open — dblclick the Title cell opens the dashboard builder
      // (full template + widget editing lives there).
      { key: "title",       label: "Title",    render: (r) => esc(r.title),
        edit: { type: "open" } },
      { key: "folder",      label: "Folder",   render: (r) => esc(r.folder ?? "—") },
      // is_favorite / is_public — bool toggles in edit mode (PATCH the
      // boolean), matching the Reports tab's treatment.
      { key: "is_favorite", label: "★",        render: (r) => _objStarBtn(r.redpash_id, "is_favorite", r.is_favorite) },
      { key: "is_public",   label: "Public",   render: (r) => _objBoolBadge(r.is_public),
        edit: { type: "bool", field: "is_public" } },
      { key: "updated_at",  label: "Modified", render: (r) => fmtDate(r.updated_at) },
      // Available-but-hidden by default — toggle on via the Columns dropdown.
      // description — inline-editable text via PATCH; null shows a `null` badge.
      { key: "description",        label: "Description",  hidden: true,
        render: (r) => _objNullable(r.description),
        edit: { type: "text", field: "description" } },
      { key: "created_at",         label: "Created",      hidden: true, render: (r) => fmtDate(r.created_at) },
      { key: "project_redpash_id", label: "Project ID",   hidden: true, render: (r) => esc(r.project_redpash_id) },
      { key: "redpash_id",         label: "Dashboard ID", hidden: true, render: (r) => esc(r.redpash_id) },
      // Owner — joined via projects.owner_id → users. Read-only on the
      // Dashboards tab (reassignment lives on the parent project).
      { key: "owner_display_name", label: "Owner",        hidden: true,
        render: (r) => esc(r.owner_display_name ?? "—") },
      { key: "owner_username",     label: "Username",     hidden: true,
        render: (r) => esc(r.owner_username ?? "—") },
    ],
    rowHref:   (r) => `#/dashboards?id=${encodeURIComponent(r.redpash_id)}`,
    canDelete: true,
    deleteOne: (rid) => api.delete(`/dashboards/${rid}`),
    openEditor: (rid) => { location.hash = `#/dashboards?id=${encodeURIComponent(rid)}`; },
    addHref:   "#/dashboards?new=1",
    // Inline cell edit — objCellEdit calls this to commit the
    // description / is_favorite / is_public PATCH. Backend has a sparse
    // PatchDashboardBody — see api/routes/dashboards.rs.
    saveEdit:  (rid, field, value) => api.patch(`/dashboards/${rid}`, { [field]: value }),
  },
  companies: {
    label:    "Companies",
    title:    "Companies",
    icon:     "bi-building",
    fetch:    () => api.get("/companies"),
    columns:  [
      // CompanySummary flattens the company record, so name / slug /
      // timestamps sit alongside member_count + my_role. name / slug /
      // avatar_url are inline-editable via PATCH /api/companies/:rid.
      { key: "name",         label: "Name",    render: (r) => esc(r.name),
        edit: { type: "text", field: "name" } },
      { key: "my_role",      label: "My role", render: (r) => esc(r.my_role ?? "—") },
      { key: "member_count", label: "Members", render: (r) => `${r.member_count ?? 0}` },
      { key: "created_at",   label: "Created", render: (r) => fmtDate(r.created_at) },
      // Available-but-hidden by default — toggle on via the Columns dropdown.
      // slug is normalised server-side and UNIQUE; collisions surface as a 409.
      { key: "slug",       label: "Slug",       hidden: true, render: (r) => esc(r.slug),
        edit: { type: "text", field: "slug" } },
      { key: "updated_at", label: "Modified",   hidden: true, render: (r) => fmtDate(r.updated_at) },
      { key: "avatar_url", label: "Avatar URL", hidden: true,
        render: (r) => _objNullable(r.avatar_url),
        edit: { type: "text", field: "avatar_url" } },
      { key: "redpash_id", label: "Company ID", hidden: true, render: (r) => esc(r.redpash_id) },
    ],
    // No company detail / viewer page yet — rows don't navigate.
    canDelete: true, // DELETE /api/companies/:rid
    deleteOne: (rid) => api.delete(`/companies/${rid}`),
    // Inline cell edit — PATCHes the sparse PatchCompanyBody.
    saveEdit:  (rid, field, value) => api.patch(`/companies/${rid}`, { [field]: value }),
    // `+` button on the Companies tab — there's no builder route, so
    // POST /api/companies with a prompt-collected name (the caller is
    // auto-seeded as owner by create_company). Returns truthy iff the
    // create went through, so objAdd can refresh the list.
    addAction: async () => {
      const name = window.prompt("Company name:");
      if (!name?.trim()) return false;
      await api.post("/companies", { name: name.trim() });
      return true;
    },
  },
  users: {
    label:    "Users",
    title:    "Users",
    icon:     "bi-people-fill",
    fetch:    () => api.get("/users"),
    columns:  [
      // display_name / username / email / plan are inline-editable via
      // PATCH /api/users/:rid (sparse). username carries a UNIQUE
      // constraint — collisions surface as a 409 with kind:"username_taken".
      { key: "display_name", label: "Name",     render: (r) => esc(r.display_name),
        edit: { type: "text", field: "display_name" } },
      { key: "username",     label: "Username", render: (r) => esc(r.username),
        edit: { type: "text", field: "username" } },
      { key: "email",        label: "Email",    render: (r) => _objNullable(r.email),
        edit: { type: "text", field: "email" } },
      { key: "plan",         label: "Plan",     render: (r) => esc(r.plan ?? "—"),
        edit: { type: "text", field: "plan" } },
      // Roles — comma-joined company memberships ("RedPash:owner, Globex:admin").
      // Read-only; editing roles lives in the per-company members UI.
      { key: "memberships",  label: "Roles",
        render: (r) => esc((r.memberships ?? []).length
          ? r.memberships.map((m) => `${m.company_name}:${m.role}`).join(", ")
          : "—") },
      // Available-but-hidden by default — toggle on via the Columns dropdown.
      { key: "job_title",    label: "Job title",    hidden: true,
        render: (r) => _objNullable(r.job_title),
        edit: { type: "text", field: "job_title" } },
      { key: "organisation", label: "Organisation", hidden: true,
        render: (r) => _objNullable(r.organisation),
        edit: { type: "text", field: "organisation" } },
      { key: "use_case",     label: "Use case",     hidden: true,
        render: (r) => _objNullable(r.use_case),
        edit: { type: "text", field: "use_case" } },
      { key: "locale",       label: "Locale",       hidden: true, render: (r) => esc(r.locale ?? "—"),
        edit: { type: "text", field: "locale" } },
      { key: "avatar_url",   label: "Avatar URL",   hidden: true,
        render: (r) => _objNullable(r.avatar_url),
        edit: { type: "text", field: "avatar_url" } },
      { key: "redpash_id",   label: "User ID",      hidden: true, render: (r) => esc(r.redpash_id) },
    ],
    canDelete: true, // DELETE /api/users/:rid (cascades sessions / memberships / owned projects)
    deleteOne: (rid) => api.delete(`/users/${rid}`),
    // + button — minimal prompt-based create (username + display_name).
    addAction: async () => {
      const username = window.prompt("Username (lowercase, unique):");
      if (!username?.trim()) return false;
      const display_name = window.prompt("Display name:");
      if (!display_name?.trim()) return false;
      await api.post("/users", { username: username.trim(), display_name: display_name.trim() });
      return true;
    },
    // Inline cell edit — PATCHes the sparse PatchUserBody.
    saveEdit: (rid, field, value) => api.patch(`/users/${rid}`, { [field]: value }),
  },
};
// Every object type the app knows about (catalog order). `objTabs`
// below is the user's chosen SUBSET — which tabs they actually show.
const KINDS = OBJECT_TAB_KEYS;

// The user's visible tab set — an ordered subset of KINDS, loaded from
// `prefs.objects_tabs` in mount() and persisted via rpSavePref whenever
// they add / remove a tab. Mirrored by the "Object tabs" control in
// profile/settings; both write the same pref so they stay in sync.
let objTabs = [...OBJECT_TAB_KEYS];

// Per-tab state — cached so flipping tabs doesn't lose a tab's rows.
// Toolbar bits (search / page / mode / selected) are reset on every
// tab activation; `rows` persists as a cheap cache.
const STATE = {
  projects:   freshState(),
  files:      freshState(),
  reports:    freshState(),
  dashboards: freshState(),
  companies:  freshState(),
  users:      freshState(),
};
// Allowed rows-per-page values — must mirror the toolbar dropdown in
// objects.html. No "all": rendering every row at once lags large tables,
// so 250 is the ceiling. Used to sanitise a value loaded from a saved
// view (an old view may still carry "all").
const OBJ_ROWS_OPTS = [10, 25, 50, 100, 250];

function freshState() {
  return {
    rows:        [],
    filtered:    [],
    search:      "",
    rowsPerPage: 25,
    page:        1,
    // Chained sort — primary key first, remaining keys break ties.
    // Empty array keeps the schema's natural order. Plain click on a
    // header replaces the chain with that single key; shift-click
    // appends / flips / removes a tie-breaker. Saved view persists it.
    sorts:       [],
    mode:        null,    // null | 'edit' | 'delete' | 'select'
    selected:    new Set(),
    // Column config — per-kind, persists across tab switches. Lazily
    // initialised from the schema on first render (see _ensureColState):
    //   colOrder    — ordered array of column keys (drag-to-reorder)
    //   visibleCols — Set of keys currently shown (the Columns dropdown)
    //   colWidths   — { colKey: px } user-resized widths, applied as
    //                 inline style on the <th>. The drag handle inside
    //                 each data-col th (see .rp-rt-col-resize) updates
    //                 this map on mouseup; renderTable re-applies it
    //                 on every paint so widths survive search / page
    //                 changes. (Per-session for now; a future Save view
    //                 cycle can persist via prefs.objects_views.)
    colOrder:    null,
    visibleCols: null,
    colWidths:   {},
  };
}

// Which tab is showing. The obj* toolbar handlers are kind-implicit —
// they read this rather than taking a `kind` argument, so the single
// shared toolbar markup doesn't need the kind baked into every onclick.
let currentKind = "projects";
let _root = null;

// Date-format for date columns — the live setting (mirrors the demo's
// _s2DateFmt). objSetDateFmt changes it; fmtDate() reads it. Module-
// wide by default, but a tab's saved view (objSave) pins its own value,
// which objActivateTab re-applies. One of: "relative" | "date" | "datetime".
let dateFmt = "datetime";
const _DATE_FMT_LABEL = { relative: "Relative", date: "Date", datetime: "Date & time" };

// Row-number column + favorites filter — toolbar toggles. objFavOnly
// resets on every tab switch (a kind with no is_favorite field would
// otherwise filter to nothing); objShowRowNums resets too, unless the
// tab has a saved view pinning it (objActivateTab).
let objShowRowNums = false;
let objFavOnly     = false;
// Global pref — show/hide the leading .obj-row-open-cell column on
// every tab. Default ON. Off doesn't re-render the body; it just
// toggles a panel class that CSS-hides the cells. Persisted to
// prefs.objects_show_row_open (set once, applies to every tab).
let objShowRowOpen = true;

// Saved per-tab view config — columns / column order / rows-per-page /
// predicate filter, keyed by kind. Loaded from `prefs.objects_views`
// in mount(), read by `_ensureColState` + `objActivateTab`, written by
// `objSave` via rpSavePref. `{}` when the user has never saved a view.
let objViews = {};

// kind → singular noun, for the header meta line ("1 project" vs
// "3 projects").
const _SINGULAR = {
  projects: "project", files: "file", reports: "report",
  dashboards: "dashboard", companies: "company", users: "user",
};

// ── Header chrome — Save view / Export ─────────────────────────────
// Objects is a browse surface, so the redtable's editor chrome
// (undo / redo, status, cleanness) was dropped from the markup. The
// two that DO apply:
//   • Save view — snapshot the current tab's columns / order /
//     rows-per-page / row-numbers / date-format into `objViews` and
//     persist via rpSavePref. objActivateTab + _ensureColState
//     re-apply it. The predicate filter is deliberately NOT included —
//     the filter panel has its own save (floppy) button; folding it in
//     here too would just be a confusing second control for the same
//     thing.
//   • Export — download the current filtered view as a CSV.
window.objSave = () => {
  const kind = currentKind;
  const st   = STATE[kind];
  _ensureColState(kind);
  objViews[kind] = {
    colOrder:    [...st.colOrder],
    visibleCols: [...st.visibleCols],
    rowsPerPage: st.rowsPerPage,
    showRowNums: objShowRowNums,
    dateFmt:     dateFmt,
    sorts:       Array.isArray(st.sorts) && st.sorts.length
                   ? st.sorts.map((k) => ({ col: k.col, dir: k.dir }))
                   : null,
  };
  window.rpSavePref?.("objects_views", objViews);
  toast.success(`${SCHEMAS[kind].title} view saved.`);
  _objFlashSaved();
};

// Brief accent glow on the exact toolbar controls Save view captured —
// Columns + Column-order dropdowns, the Rows-per-page + Date-format
// pills, and the row-numbers toggle — so a click on "Save view" shows
// the user *what* was saved, not just a toast. Re-adding the class
// after a forced reflow restarts the one-shot animation on repeat saves.
function _objFlashSaved() {
  const targets = [
    ..._root.querySelectorAll(".rp-rt-cols-wrap > .rp-rt-icon-btn"),
    _root.querySelector("[data-rt-rows-label]")?.closest(".rp-rt-pill-btn"),
    _root.querySelector("[data-rt-datefmt-label]")?.closest(".rp-rt-pill-btn"),
    _root.querySelector("#obj-rownum-btn"),
  ].filter(Boolean);
  for (const el of targets) {
    el.classList.remove("obj-saved-glow");
    void el.offsetWidth;            // reflow → restart the animation
    el.classList.add("obj-saved-glow");
  }
}

window.objExport = () => {
  const kind = currentKind;
  const rows = STATE[kind].filtered;          // current view, all pages
  if (!rows.length) { toast.info("Nothing to export."); return; }
  const cols = _visibleOrderedCols(kind);
  // RFC-4180-ish: quote any cell containing a comma / quote / newline.
  const cell = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    cols.map((c) => cell(c.label)).join(","),
    ...rows.map((r) => cols.map((c) => cell(_objColValue(kind, c.key, r))).join(",")),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a   = document.createElement("a");
  a.href = url;
  a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${rows.length} ${rows.length === 1 ? _SINGULAR[kind] : kind}.`);
};

// Lazily initialise a kind's column config. A saved view (objViews)
// wins when present — but re-validated against the live schema so a
// renamed / removed column in an old saved view can't break the page:
// unknown keys are dropped, and schema columns the saved order is
// missing (added since the save) are appended. Falls back to the
// schema's declared order + non-`hidden` columns when nothing's saved.
function _ensureColState(kind) {
  const st = STATE[kind];
  if (st.colOrder && st.visibleCols) return;
  const cols      = SCHEMAS[kind].columns;
  const validKeys = new Set(cols.map((c) => c.key));
  const saved     = objViews[kind];
  if (saved && Array.isArray(saved.colOrder) && saved.colOrder.length) {
    st.colOrder = saved.colOrder.filter((k) => validKeys.has(k));
    // Columns added to the schema *since* this view was saved aren't in
    // the saved colOrder at all — append them, and seed any non-`hidden`
    // newcomer into visibleCols so a new default column (e.g. files'
    // Stage) flows into existing saved views instead of staying hidden.
    // A column the user explicitly hid is still in the saved colOrder,
    // just not in visibleCols — so this can't un-hide a deliberate choice.
    const fresh = [];
    for (const c of cols) {
      if (!st.colOrder.includes(c.key)) {
        st.colOrder.push(c.key);
        if (!c.hidden) fresh.push(c.key);
      }
    }
    const savedVis = Array.isArray(saved.visibleCols)
      ? saved.visibleCols.filter((k) => validKeys.has(k)) : [];
    st.visibleCols = savedVis.length
      ? new Set([...savedVis, ...fresh])
      : new Set(cols.filter((c) => !c.hidden).map((c) => c.key));
  } else {
    st.colOrder    = cols.map((c) => c.key);
    st.visibleCols = new Set(cols.filter((c) => !c.hidden).map((c) => c.key));
  }
}

// The active, ordered, visible column objects for a kind — what
// renderTable actually paints. Honours colOrder + visibleCols.
function _visibleOrderedCols(kind) {
  _ensureColState(kind);
  const st    = STATE[kind];
  const byKey = Object.fromEntries(SCHEMAS[kind].columns.map((c) => [c.key, c]));
  return st.colOrder
    .filter((k) => st.visibleCols.has(k))
    .map((k) => byKey[k])
    .filter(Boolean);
}

// ── Columns / Column-order dropdown hover ──────────────────────────
// These two open on hover. Pure CSS `:hover` propagation through the
// wide, absolutely-positioned `.rp-rt-cols-dd` panels is unreliable
// (the narrow pill dropdowns are fine on CSS alone) — so bind the
// redtable demo's explicit pattern: mouseenter adds `.open`, mouseleave
// starts a 180ms grace timer that the panel's own mouseenter cancels,
// so moving the cursor off the trigger and onto the panel keeps it
// open. The `.rp-rt-cols-wrap` elements are static in the partial
// (only their inner lists get rebuilt), so a one-time bind holds;
// the dataset flag guards against a double-bind on router re-mount.
function _bindColsDdHover(root) {
  root.querySelectorAll(".rp-rt-cols-wrap").forEach((wrap) => {
    if (wrap.dataset.ddHoverBound) return;
    wrap.dataset.ddHoverBound = "1";
    const dd = wrap.querySelector(".rp-rt-cols-dd");
    if (!dd) return;
    let closeTimer = null;
    const open  = () => {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      dd.classList.add("open");
    };
    const close = () => {
      closeTimer = setTimeout(() => { dd.classList.remove("open"); closeTimer = null; }, 180);
    };
    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", close);
    dd.addEventListener("mouseenter", open);
    dd.addEventListener("mouseleave", close);
  });
}

// ── Mount ──────────────────────────────────────────────────────────
export default async function mount(root, ctx) {
  _root = root;
  // The user's tab set comes from their account prefs (seeded on the
  // session at boot). normalizeObjectTabs drops unknown keys and falls
  // back to the full catalog when nothing is saved.
  objTabs = normalizeObjectTabs(ctx?.session?.prefs?.objects_tabs);

  // Saved per-tab view configs. A plain object keyed by kind — drop
  // anything that isn't shaped like one so a corrupt pref can't break
  // the page (`_ensureColState` re-validates per-kind anyway).
  const savedViews = ctx?.session?.prefs?.objects_views;
  objViews = (savedViews && typeof savedViews === "object" && !Array.isArray(savedViews))
    ? savedViews : {};

  // Row-open visibility — defaults to ON; only flip when the user
  // explicitly set `false` via the toolbar toggle (an absent pref
  // means "never asked").
  objShowRowOpen = ctx?.session?.prefs?.objects_show_row_open !== false;

  _wireGlobals(root);
  _bindColsDdHover(root);
  _renderTabs(root);

  // Deep-link support: #/objects?tab=files lands directly on that tab.
  // Home's stat buttons + minitables link in with this query. If the
  // requested tab isn't in the user's set, fall back to their first.
  const q   = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const tab = q.get("tab");
  const start = objTabs.includes(tab) ? tab : objTabs[0];

  // Projects must load first — the files schema looks up project names
  // from STATE.projects.rows. Prefetch projects even if we're landing
  // on a different tab so the Project column resolves. (Skipped when
  // the user has removed the Projects tab — the column falls back to a
  // RID slice, which is acceptable.)
  if (start !== "projects" && objTabs.includes("projects")) {
    try {
      const res = await SCHEMAS.projects.fetch();
      STATE.projects.rows = res.items ?? [];
    } catch { /* non-fatal — the column falls back to a RID slice */ }
  }
  await objActivateTab(start);
}

// ── Tabs ───────────────────────────────────────────────────────────
// Rendered from `objTabs` (the user's chosen set), not the full catalog.
// Each tab carries a remove (×); a trailing "+" opens a dropdown of the
// object types not currently shown. Add / remove persist to the account
// via rpSavePref — see objAddTab / objRemoveTab.
function _renderTabs(root) {
  const list = root.querySelector("#obj-tabs");
  if (!list) return;

  // Min-1: the last remaining tab can't be removed (you always keep at
  // least one object type visible), so its × is omitted entirely.
  const canRemove = objTabs.length > 1;
  const tabsHtml = objTabs.map((k) => {
    const s = SCHEMAS[k];
    if (!s) return "";
    const x = canRemove
      ? `<button class="obj-tab-x" title="Remove tab"
                 aria-label="Remove ${esc(s.label)} tab"
                 onclick="event.stopPropagation();objRemoveTab('${k}')"><i class="bi bi-x"></i></button>`
      : "";
    // Tabs are draggable so the user can reorder them in place;
    // dropping one on another inserts the source BEFORE the target.
    // Persists via rpSavePref("objects_tabs", ...) so the new order
    // shows up immediately in Profile's Settings panel too. Mirrors
    // ovColDrag* / cleanerColDrag* but mutates objTabs.
    return `<div class="obj-tab" data-kind="${k}" draggable="true"
                 onclick="objActivateTab('${k}')"
                 ondragstart="objTabDragStart(event)"
                 ondragover="objTabDragOver(event)"
                 ondragleave="objTabDragLeave(event)"
                 ondrop="objTabDrop(event)"
                 ondragend="objTabDragEnd(event)">
      <i class="bi ${s.icon}"></i><span>${esc(s.label)}</span>${x}
    </div>`;
  }).join("");

  // "+" add-tab control — a dropdown of catalog types not yet shown.
  const hidden = OBJECT_TAB_CATALOG.filter((c) => !objTabs.includes(c.key));
  const menuHtml = hidden.length
    ? hidden.map((c) =>
        `<button class="obj-add-item" onclick="objAddTab('${c.key}')">
           <i class="bi ${c.icon}"></i><span>${esc(c.label)}</span></button>`).join("")
    : `<div class="obj-add-empty">All object types are shown.</div>`;
  const addHtml = `<div class="obj-tab-add-wrap">
    <button class="obj-tab-add" title="Add a tab" aria-label="Add a tab"${
      hidden.length ? ` onclick="objToggleAddMenu(this)"` : " disabled"
    }><i class="bi bi-plus-lg"></i></button>
    <div class="obj-tab-add-menu" hidden>${menuHtml}</div>
  </div>`;

  list.innerHTML = tabsHtml + addHtml;
  // The innerHTML rebuild drops the active class — re-apply it.
  list.querySelectorAll(".obj-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.kind === currentKind);
  });
}

// ── Inline-onclick globals ─────────────────────────────────────────
function _wireGlobals(root) {
  // Tab switch. Resets the tab's toolbar state (search / page / mode /
  // selection) but keeps its `rows` cache; then re-fetches fresh data.
  window.objActivateTab = async (kind) => {
    // Only activate a tab the user actually shows. An unknown / hidden
    // kind falls back to their first tab (handles a stale deep-link or
    // a tab that was removed in another session).
    if (!objTabs.includes(kind)) kind = objTabs[0];
    if (!kind) return;
    currentKind = kind;

    // Re-render the strip from objTabs — this also moves the active
    // highlight (it reads currentKind) AND picks up any add/remove the
    // caller just made to objTabs, so objAddTab / objRemoveTab can
    // delegate here without separately re-rendering.
    _renderTabs(root);
    // Keep the URL shareable / reload-stable without a router re-mount.
    try { history.replaceState(null, "", `#/objects?tab=${kind}`); } catch {}

    // Reset this tab's toolbar state. rowsPerPage comes from the saved
    // view when the user has one (objSave), else the 25 default.
    const st = STATE[kind];
    st.search = ""; st.page = 1; st.mode = null;
    // Sanitise the saved-view value against the allowed set — an older
    // saved view may still carry "all" (or a now-removed size).
    st.rowsPerPage = OBJ_ROWS_OPTS.includes(objViews[kind]?.rowsPerPage)
      ? objViews[kind].rowsPerPage : 25;
    // Saved sort chain wins on tab activation; absence leaves the
    // schema's natural order. We accept both the new `sorts` array and
    // the legacy `sort` object so older saved views keep working. Each
    // entry's dir must be asc|desc, else the entry is dropped — better
    // to lose one bad key than risk a bad comparator.
    const view = objViews[kind] || {};
    const sanitize = (arr) => (Array.isArray(arr) ? arr : [])
      .filter((k) => k && typeof k.col === "string" &&
                     (k.dir === "asc" || k.dir === "desc"))
      .map((k) => ({ col: k.col, dir: k.dir }));
    const fromChain  = sanitize(view.sorts);
    const fromLegacy = view.sort && typeof view.sort.col === "string"
                       ? sanitize([view.sort]) : [];
    st.sorts = fromChain.length ? fromChain : fromLegacy;
    st.selected.clear();

    // Reset the toolbar DOM to defaults.
    const panel = root.querySelector(".rp-rt-panel");
    if (panel) {
      panel.dataset.rt = kind;
      const ttl = panel.querySelector("[data-rt-title]");
      if (ttl) ttl.textContent = SCHEMAS[kind].title;
      const search = panel.querySelector(".rp-rt-search");
      if (search) { search.value = ""; search.placeholder = `Search ${kind}…`; }
      // Reset the inline modes — drop the active class + aria-pressed on
      // every mode icon button AND drop the panel's mode class (CSS
      // source of truth).
      panel.querySelectorAll(".rp-rt-icon-btn[data-rt-mode]").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
      panel.classList.remove("rp-rt-mode-edit", "rp-rt-mode-select", "rp-rt-mode-delete");
      const rowsLbl = panel.querySelector("[data-rt-rows-label]");
      if (rowsLbl) {
        // Reflect st.rowsPerPage (saved-view value or the 25 default).
        rowsLbl.textContent = String(st.rowsPerPage);
        // Scope this to the ROWS dropdown only — the date-format
        // dropdown also has .rp-rt-dd-item children (synced below).
        // Exact-match the item text: `startsWith` would tick both
        // "25 rows" and "250 rows" when rowsPerPage is 25.
        rowsLbl.closest(".rp-rt-dd-wrap")
          ?.querySelectorAll(".rp-rt-dd-item")
          .forEach((i) => i.classList.toggle("rp-rt-dd-selected",
            i.textContent.trim() === `${st.rowsPerPage} rows`));
      }
      // Date format — `dateFmt` is the live setting; a tab's saved view
      // pins its own value, so re-apply it here. No saved value → leave
      // `dateFmt` as-is (its last module-wide value carries over).
      const savedFmt = objViews[kind]?.dateFmt;
      if (savedFmt && _DATE_FMT_LABEL[savedFmt]) dateFmt = savedFmt;
      const dfLabel = panel.querySelector("[data-rt-datefmt-label]");
      if (dfLabel) {
        dfLabel.textContent = _DATE_FMT_LABEL[dateFmt];
        dfLabel.closest(".rp-rt-dd-wrap")
          ?.querySelectorAll(".rp-rt-dd-item")
          .forEach((i) => i.classList.toggle("rp-rt-dd-selected",
            i.textContent.trim() === _DATE_FMT_LABEL[dateFmt]));
      }
      // The "add" affordance — every kind has one (projects / files
      // route to Home's upload zone; reports / dashboards open their
      // builder's new mode; companies / users open a prompt). objAdd
      // reads currentKind.
      const add = panel.querySelector("[data-rt-add]");
      if (add) {
        add.style.display = "";
        add.title = kind === "reports"    ? "New report"
                  : kind === "dashboards" ? "New dashboard"
                  : kind === "files"      ? "Upload a file"
                  : kind === "companies"  ? "New company"
                  : kind === "users"      ? "New user"
                  :                         "New project";
      }

      // Row numbers — restored from the tab's saved view, else off.
      // Favorites always resets: objFavOnly MUST be false on entry, or a
      // kind with no is_favorite field would filter down to nothing; the
      // button itself is shown only on reports / dashboards.
      objShowRowNums = objViews[kind]?.showRowNums === true;
      objFavOnly = false;
      const rnBtn = panel.querySelector("#obj-rownum-btn");
      if (rnBtn) rnBtn.classList.toggle("rp-rt-rownum-active", objShowRowNums);
      // Row-open icons — global pref, applied to the panel by toggling
      // `obj-hide-row-open` so CSS hides the cells without a body re-render.
      panel.classList.toggle("obj-hide-row-open", !objShowRowOpen);
      const roBtn = panel.querySelector("#obj-rowopen-btn");
      if (roBtn) {
        roBtn.classList.toggle("is-active", objShowRowOpen);
        roBtn.setAttribute("aria-pressed", objShowRowOpen ? "true" : "false");
      }
      const favBtn = panel.querySelector("#obj-fav-btn");
      if (favBtn) {
        favBtn.classList.remove("rp-rt-fav-active");
        favBtn.style.display = (kind === "reports" || kind === "dashboards") ? "" : "none";
      }
      const scoreBtn = panel.querySelector("#obj-score-btn");
      if (scoreBtn) {
        scoreBtn.classList.remove("is-spinning");
        scoreBtn.style.display = (kind === "files") ? "" : "none";
      }
      const clearScoreBtn = panel.querySelector("#obj-clear-score-btn");
      if (clearScoreBtn) {
        clearScoreBtn.classList.remove("is-spinning");
        clearScoreBtn.style.display = (kind === "files") ? "" : "none";
      }
    }

    // Columns differ per kind — rebuild the Columns checkbox list and
    // the Column-order drag list to reflect this tab's column config.
    window.objBuildColsDropdown(kind);
    window.objBuildColOrderList(kind);

    // Reset the predicate filter — columns differ per kind, so stale
    // predicate rows would reference columns this tab doesn't have. The
    // filter isn't part of a saved view; the filter panel's own save
    // button is where filter persistence lives.
    objResetFilter();

    await loadTable(kind);
  };

  // Toolbar handlers — all kind-implicit (read currentKind).
  // Filter side-panel — slide it open / closed + light the funnel
  // button. Lazily seeds one empty predicate row on first open.
  window.objToggleFilter = (btn) => {
    const panel = root.querySelector("#obj-filter-panel");
    if (!panel) return;
    panel.classList.toggle("open");
    const on = panel.classList.contains("open");
    if (btn) btn.classList.toggle("rp-rt-filter-active", on);
    if (on) _objEnsureFilterRow();
    // The fb dropdown menus are position:fixed — they'd hang in space
    // when the panel slides shut, so close them with it.
    else _objCloseFbMenus();
  };
  // Row numbers — toggles a leading "#" index column in renderTable.
  window.objToggleRowNums = (btn) => {
    objShowRowNums = !objShowRowNums;
    if (btn) btn.classList.toggle("rp-rt-rownum-active", objShowRowNums);
    renderTable(currentKind);
  };
  // Row-open icons — toggles the leading .obj-row-open-cell column
  // via a panel class (CSS handles the display: none). No body
  // re-render needed since the cells are always emitted. Pref is
  // global (not per-tab), persisted to prefs.objects_show_row_open.
  window.objToggleRowOpen = (btn) => {
    objShowRowOpen = !objShowRowOpen;
    if (btn) {
      btn.classList.toggle("is-active", objShowRowOpen);
      btn.setAttribute("aria-pressed", objShowRowOpen ? "true" : "false");
    }
    _root.querySelector(".rp-rt-panel")
         ?.classList.toggle("obj-hide-row-open", !objShowRowOpen);
    window.rpSavePref?.("objects_show_row_open", objShowRowOpen);
  };
  // Favorites-only filter — keeps rows flagged is_favorite. The button
  // is only shown on reports / dashboards tabs (objActivateTab).
  window.objToggleFav = (btn) => {
    objFavOnly = !objFavOnly;
    if (btn) btn.classList.toggle("rp-rt-fav-active", objFavOnly);
    STATE[currentKind].page = 1;
    renderTable(currentKind);
  };
  window.objSearch = (inp) => {
    STATE[currentKind].search = inp.value.toLowerCase().trim();
    STATE[currentKind].page = 1;
    renderTable(currentKind);
  };
  // Column-header click → mutate the sort chain.
  //   • plain click  → replace chain with [{col, asc}], or flip dir
  //                    when col is already the sole sort key.
  //   • shift-click  → append to chain at asc; if col is already in
  //                    the chain, flip its dir; alt+shift-click drops
  //                    it. Lets the user build "Stage asc, Modified
  //                    desc, Name asc" tie-breakers.
  // Always returns to page 1 so the user lands at the new top.
  window.objSortBy = (col, ev) => {
    const st = STATE[currentKind];
    if (!Array.isArray(st.sorts)) st.sorts = [];
    const shift = !!(ev && ev.shiftKey);
    const alt   = !!(ev && ev.altKey);
    const idx   = st.sorts.findIndex((k) => k.col === col);
    if (shift) {
      if (idx >= 0) {
        if (alt) st.sorts.splice(idx, 1);                                  // remove
        else     st.sorts[idx].dir = st.sorts[idx].dir === "asc" ? "desc" : "asc";
      } else {
        st.sorts.push({ col, dir: "asc" });                                // append
      }
    } else {
      if (st.sorts.length === 1 && st.sorts[0].col === col) {
        st.sorts[0].dir = st.sorts[0].dir === "asc" ? "desc" : "asc";      // flip sole key
      } else {
        st.sorts = [{ col, dir: "asc" }];                                  // replace chain
      }
    }
    st.page = 1;
    renderTable(currentKind);
  };

  // Column drag-to-reorder — grab any header, drop on another →
  // re-arrange. Mirrors cleaner.js ovColDrag* + cleanerColDrag*.
  // Mutates STATE[kind].colOrder in place; the Save view button is
  // what persists to prefs.objects_views (consistent with the way the
  // Columns + Column-order dropdowns already work). Drop on a column
  // = "insert source before target" (Mac Finder / Excel convention).
  let _objDragCol = null;
  window.objColDragStart = (e) => {
    const th = e.currentTarget;
    _objDragCol = th?.dataset?.rtCol || null;
    if (_objDragCol) {
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to fire dragover unless some data is set.
      try { e.dataTransfer.setData("text/plain", _objDragCol); } catch {}
      th.classList.add("rp-rt-th-drag");
    }
  };
  window.objColDragOver = (e) => {
    if (!_objDragCol) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const th = e.currentTarget;
    if (th && th.dataset.rtCol !== _objDragCol) th.classList.add("rp-rt-th-drop");
  };
  window.objColDragLeave = (e) => {
    e.currentTarget?.classList.remove("rp-rt-th-drop");
  };
  window.objColDragEnd = () => {
    _root.querySelectorAll("thead th.rp-rt-th-drag, thead th.rp-rt-th-drop")
      .forEach((t) => t.classList.remove("rp-rt-th-drag", "rp-rt-th-drop"));
    _objDragCol = null;
  };
  window.objColDrop = (e) => {
    e.preventDefault();
    const targetTh = e.currentTarget;
    const target   = targetTh?.dataset?.rtCol;
    const source   = _objDragCol;
    window.objColDragEnd();
    if (!source || !target || source === target) return;
    _ensureColState(currentKind);
    const st = STATE[currentKind];
    const from = st.colOrder.indexOf(source);
    if (from < 0) return;
    st.colOrder.splice(from, 1);
    const insertAt = st.colOrder.indexOf(target);
    if (insertAt < 0) return;
    st.colOrder.splice(insertAt, 0, source);
    renderTable(currentKind);
    // Refresh the Column-order dropdown (if open) so it reflects the
    // new order — both UIs read the same state. Needs the kind arg
    // since the helper takes a single tab key, not currentKind.
    window.objBuildColOrderList?.(currentKind);
  };

  // Three mutually-exclusive inline modes (edit / select / delete) —
  // ported from the Cleaner. Flips a `rp-rt-mode-<mode>` class on the
  // panel; the CSS surfaces / hides the always-emitted leading checkbox
  // + trailing trash columns and the edit hover cue, so toggling a mode
  // never re-renders the table body.
  window.objToggleMode = (btn, mode) => {
    const panel = root.querySelector(".rp-rt-panel");
    if (!panel) return;
    const wasActive = btn.classList.contains("is-active");
    const nowActive = !wasActive;
    // One mode at a time — clear sibling mode buttons.
    btn.closest(".rp-rt-toolbar")
      ?.querySelectorAll(".rp-rt-icon-btn[data-rt-mode]")
      .forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
    if (nowActive) {
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
    }
    panel.classList.remove("rp-rt-mode-edit", "rp-rt-mode-select", "rp-rt-mode-delete");
    if (nowActive) panel.classList.add(`rp-rt-mode-${mode}`);
    STATE[currentKind].mode = nowActive ? mode : null;
    // Any mode change clears the selection — objClearSelection syncs the
    // DOM (uncheck boxes, drop tints) without a full body re-render.
    window.objClearSelection();
  };
  // Recompute cleanness for every file in the current Files-tab list.
  // Iterates serially (POST /files/:rid/cleanness — same as the cleaner
  // overview's ovScoreFiles), replaces each row in STATE.files.rows in
  // place, and re-renders after every file so the user sees live
  // progress (a 17-file project takes tens of seconds; without this
  // the table was visually stuck until the last call landed and the
  // spinner looked like it hung). try/finally guarantees the spinner
  // clears even if an exception escapes — and we re-find the button by
  // id so a stale `btn` ref (e.g. tab switch during the loop) can't
  // leave a ghost spinner on the toolbar.
  window.objScoreFiles = async (btn) => {
    const rows = (STATE.files?.rows ?? []).slice();   // snapshot — loop body mutates STATE.files.rows
    if (!rows.length) { toast.info("No files to score."); return; }
    const setSpin = (on) => {
      const b = _root?.querySelector("#obj-score-btn");
      if (!b) return;
      b.disabled = on;
      b.classList.toggle("is-spinning", on);
    };
    setSpin(true);
    let done = 0, failed = null;
    try {
      for (const f of rows) {
        try {
          const summary = await api.post(`/files/${encodeURIComponent(f.redpash_id)}/cleanness`, {});
          const idx = STATE.files.rows.findIndex((x) => x.redpash_id === f.redpash_id);
          if (idx >= 0) STATE.files.rows[idx] = summary;
          done++;
          // Live progress: each completed file repaints the row.
          renderTable("files");
        } catch (err) {
          failed = err;
          break;
        }
      }
    } finally {
      setSpin(false);
      renderTable("files");
    }
    if (failed) {
      toast.error(`Stopped after ${done} — ${failed.body?.error ?? failed.message}`);
    } else {
      toast.success(`Scored ${done} file${done !== 1 ? "s" : ""}`);
    }
  };

  // Inverse of objScoreFiles — DELETEs /files/:rid/cleanness for every
  // file so the user can re-run scoring and watch it land. Dev/test
  // affordance; same serial loop + live re-render + try/finally spinner
  // discipline as scoring.
  window.objClearFileScores = async () => {
    const rows = (STATE.files?.rows ?? []).slice();
    if (!rows.length) { toast.info("No files to clear."); return; }
    const setSpin = (on) => {
      const b = _root?.querySelector("#obj-clear-score-btn");
      if (!b) return;
      b.disabled = on;
      b.classList.toggle("is-spinning", on);
    };
    setSpin(true);
    let done = 0, failed = null;
    try {
      for (const f of rows) {
        try {
          const summary = await api.delete(`/files/${encodeURIComponent(f.redpash_id)}/cleanness`);
          const idx = STATE.files.rows.findIndex((x) => x.redpash_id === f.redpash_id);
          if (idx >= 0 && summary) STATE.files.rows[idx] = summary;
          done++;
          renderTable("files");
        } catch (err) {
          failed = err;
          break;
        }
      }
    } finally {
      setSpin(false);
      renderTable("files");
    }
    if (failed) {
      toast.error(`Stopped after ${done} — ${failed.body?.error ?? failed.message}`);
    } else {
      toast.success(`Cleared ${done} file${done !== 1 ? "s" : ""}`);
    }
  };

  // Single-click favorite toggle for reports / dashboards rows. Reuses
  // the schema's saveEdit (same PATCH path as inline bool edits) with
  // an optimistic local flip so the star turns gold immediately.
  // Rolls the local state back if the PATCH fails.
  window.objToggleStar = async (rid, field) => {
    const kind   = currentKind;
    const schema = SCHEMAS[kind];
    const row    = STATE[kind]?.rows?.find((r) => r.redpash_id === rid);
    if (!row || !schema?.saveEdit) return;
    const prev = !!row[field];
    row[field] = !prev;
    renderTable(kind);
    try {
      await schema.saveEdit(rid, field, !prev);
    } catch (err) {
      row[field] = prev;
      renderTable(kind);
      toast.error(`Couldn't update: ${err.body?.error ?? err.message}`);
    }
  };

  window.objRefresh = async (btn) => {
    // One-shot 360° spin on the icon — mirrors the redtable demo's
    // s2Refresh. The library's `.rp-rt-refreshing` class spins
    // `infinite` only while it's applied, but loadTable round-trips the
    // local backend in a few ms, so that spin never visibly starts. A
    // fixed 0.6s rotate completes regardless of how fast the load is.
    const icon = btn?.querySelector("i.bi");
    if (icon) {
      icon.style.transition = "transform 0.6s";
      icon.style.transform  = "rotate(360deg)";
    }
    try { await loadTable(currentKind); } catch { /* loadTable surfaces its own errors */ }
    setTimeout(() => {
      if (icon) { icon.style.transition = ""; icon.style.transform = ""; }
    }, 700);
  };
  // Toggle a toolbar dropdown — works for both the pill dropdowns
  // (rows / date format) and the cols dropdowns (columns / column
  // order); the trigger button's next sibling is the dropdown panel
  // in every case. Closes any other open dropdown first.
  window.objToggleDd = (btn) => {
    const dd = btn.nextElementSibling;
    if (!dd) return;
    const wasOpen = dd.classList.contains("open");
    document.querySelectorAll(".rp-rt-pill-dd.open, .rp-rt-cols-dd.open")
      .forEach((o) => o.classList.remove("open"));
    if (!wasOpen) dd.classList.add("open");
  };
  window.objSetRows = (item, n) => {
    STATE[currentKind].rowsPerPage = n;
    STATE[currentKind].page = 1;
    const dd = item.parentElement;
    dd?.querySelectorAll(".rp-rt-dd-item").forEach((i) => i.classList.remove("rp-rt-dd-selected"));
    item.classList.add("rp-rt-dd-selected");
    const panel = root.querySelector(".rp-rt-panel");
    const label = panel?.querySelector("[data-rt-rows-label]");
    if (label) label.textContent = String(n);
    dd?.classList.remove("open");
    renderTable(currentKind);
  };

  // ── Date format ───────────────────────────────────────────────────
  // Updates the live `dateFmt`, the toolbar label, marks the selected
  // item, re-renders the active tab. `objSave` snapshots `dateFmt` into
  // the tab's view; `objActivateTab` re-applies a saved one.
  window.objSetDateFmt = (item, fmt) => {
    if (!_DATE_FMT_LABEL[fmt]) return;
    dateFmt = fmt;
    const dd = item.parentElement;
    dd?.querySelectorAll(".rp-rt-dd-item").forEach((i) => i.classList.remove("rp-rt-dd-selected"));
    item.classList.add("rp-rt-dd-selected");
    const label = root.querySelector("[data-rt-datefmt-label]");
    if (label) label.textContent = _DATE_FMT_LABEL[fmt];
    dd?.classList.remove("open");
    renderTable(currentKind);
  };

  // ── Columns (show / hide) ─────────────────────────────────────────
  // Rebuilt on every tab switch — columns differ per kind. Each
  // checkbox toggles a key in STATE[kind].visibleCols; unchecking the
  // last visible column is refused (a table needs at least one).
  window.objBuildColsDropdown = (kind) => {
    const dd = root.querySelector("#obj-cols-dd");
    if (!dd) return;
    _ensureColState(kind);
    const st = STATE[kind];
    const byKey = Object.fromEntries(SCHEMAS[kind].columns.map((c) => [c.key, c]));
    dd.innerHTML = st.colOrder.map((k) => {
      const col = byKey[k];
      if (!col) return "";
      const checked = st.visibleCols.has(k) ? " checked" : "";
      return `<label class="rp-rt-col-item">
        <input type="checkbox" data-col-toggle="${esc(k)}"${checked} />
        ${esc(col.label)}
      </label>`;
    }).join("");
    dd.querySelectorAll("input[data-col-toggle]").forEach((cb) => {
      cb.addEventListener("change", () => window.objToggleCol(cb));
    });
  };
  window.objToggleCol = (cb) => {
    const kind = currentKind;
    const st   = STATE[kind];
    const key  = cb.dataset.colToggle;
    if (cb.checked) {
      st.visibleCols.add(key);
    } else {
      if (st.visibleCols.size <= 1) {       // min-1 — keep at least one column
        cb.checked = true;
        toast.info("Keep at least one column visible.");
        return;
      }
      st.visibleCols.delete(key);
    }
    renderTable(kind);
    window.objBuildColOrderList(kind);      // col-order list only shows visible cols
  };

  // ── Column order (drag to reorder) ────────────────────────────────
  // The list shows only the currently-visible columns; dragging
  // reorders STATE[kind].colOrder. Rebuilt on tab switch + on any
  // visibility change.
  let _colDragKey = null;
  window.objBuildColOrderList = (kind) => {
    const list = root.querySelector("#obj-col-order-list");
    if (!list) return;
    _ensureColState(kind);
    const st    = STATE[kind];
    const byKey = Object.fromEntries(SCHEMAS[kind].columns.map((c) => [c.key, c]));
    const visible = st.colOrder.filter((k) => st.visibleCols.has(k));
    list.innerHTML = visible.map((k) =>
      `<div class="rp-coi" draggable="true" data-col="${esc(k)}">
        <i class="bi bi-grip-vertical rp-coi-grip"></i> ${esc(byKey[k]?.label ?? k)}
      </div>`).join("");
    list.querySelectorAll(".rp-coi").forEach((el) => {
      el.addEventListener("dragstart", (e) => {
        _colDragKey = el.dataset.col;
        el.classList.add("rp-coi-dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        _colDragKey = null;
        list.querySelectorAll(".rp-coi").forEach((i) =>
          i.classList.remove("rp-coi-dragging", "rp-coi-over"));
      });
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        list.querySelectorAll(".rp-coi").forEach((i) => i.classList.remove("rp-coi-over"));
        el.classList.add("rp-coi-over");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetKey = el.dataset.col;
        if (!_colDragKey || _colDragKey === targetKey) return;
        const order = STATE[currentKind].colOrder;
        const from  = order.indexOf(_colDragKey);
        const to    = order.indexOf(targetKey);
        if (from === -1 || to === -1) return;
        order.splice(from, 1);
        order.splice(to, 0, _colDragKey);
        window.objBuildColOrderList(currentKind);
        renderTable(currentKind);
      });
    });
  };
  // ── Select mode — per-row checkboxes + master + toolbar chip ──────
  // Selection is keyed by redpash_id (stable, unlike the Cleaner's
  // page-relative indices). Handlers sync the DOM directly — no body
  // re-render — and refresh the toolbar chip.
  window.objRowSelect = (chk) => {
    const rid = chk.dataset.rid;
    const st  = STATE[currentKind];
    if (chk.checked) st.selected.add(rid);
    else             st.selected.delete(rid);
    chk.closest("tr")?.classList.toggle("rp-rt-row-sel", chk.checked);
    _renderObjSelChip();
  };
  window.objSelectAll = (on) => {
    const st = STATE[currentKind];
    st.selected.clear();
    root.querySelectorAll(".rp-rt-panel tbody .obj-row-chk").forEach((cb) => {
      cb.checked = on;
      cb.closest("tr")?.classList.toggle("rp-rt-row-sel", on);
      if (on) st.selected.add(cb.dataset.rid);
    });
    _renderObjSelChip();
  };
  window.objClearSelection = () => {
    STATE[currentKind].selected.clear();
    root.querySelectorAll(".rp-rt-panel tbody .obj-row-chk").forEach((cb) => {
      cb.checked = false;
      cb.closest("tr")?.classList.remove("rp-rt-row-sel");
    });
    const head = root.querySelector("#obj-sel-all");
    if (head) { head.checked = false; head.indeterminate = false; }
    _renderObjSelChip();
  };

  // ── Delete mode — per-row trash + bulk delete (from the chip) ─────
  window.objRowDelete = async (rid) => {
    const kind = currentKind, schema = SCHEMAS[kind];
    if (!schema.canDelete) { toast.info(`Delete isn't supported on ${kind} yet.`); return; }
    const row   = STATE[kind].rows.find((r) => r.redpash_id === rid);
    if (schema.canDeleteRow && row && !schema.canDeleteRow(row)) {
      toast.info("Set another project as Default before deleting this one.");
      return;
    }
    const label = row?.name ?? row?.title ?? row?.display_name ?? row?.filename ?? rid;
    if (!confirm(`Delete "${label}"?`)) return;
    try {
      await schema.deleteOne(rid);
      toast.success("Deleted.");
      await loadTable(kind);
    } catch (err) {
      toast.error(`Delete failed: ${err.body?.error ?? err.message}`);
    }
  };
  // Bulk score / clear-score — same per-file POST or DELETE loop as the
  // toolbar Score / Clear buttons, but scoped to the ticked rows. Files
  // tab only (UI gated via _renderObjSelChip). `verb` is "POST" or
  // "DELETE"; `label` is for the toast wording.
  async function _objBulkCleanness(verb, label, btnId) {
    if (currentKind !== "files") return;
    const ids = [...STATE.files.selected];
    if (!ids.length) return;
    const setSpin = (on) => {
      const b = _root?.querySelector(`#${btnId}`);
      if (!b) return;
      b.disabled = on;
      b.classList.toggle("is-spinning", on);
    };
    setSpin(true);
    let done = 0, failed = null;
    try {
      for (const rid of ids) {
        try {
          const summary = verb === "POST"
            ? await api.post(`/files/${encodeURIComponent(rid)}/cleanness`, {})
            : await api.delete(`/files/${encodeURIComponent(rid)}/cleanness`);
          const idx = STATE.files.rows.findIndex((x) => x.redpash_id === rid);
          if (idx >= 0 && summary) STATE.files.rows[idx] = summary;
          done++;
          renderTable("files");
        } catch (err) {
          failed = err;
          break;
        }
      }
    } finally {
      setSpin(false);
      renderTable("files");
    }
    if (failed) {
      toast.error(`Stopped after ${done} — ${failed.body?.error ?? failed.message}`);
    } else {
      toast.success(`${label} ${done} file${done !== 1 ? "s" : ""}`);
    }
  }
  window.objBulkScore       = () => _objBulkCleanness("POST",   "Scored",  "obj-bulk-score-btn");
  window.objBulkClearScores = () => _objBulkCleanness("DELETE", "Cleared", "obj-bulk-clear-score-btn");

  window.objBulkDelete = async () => {
    const kind = currentKind, schema = SCHEMAS[kind];
    if (!schema.canDelete) { toast.info(`Bulk delete isn't supported on ${kind} yet.`); return; }
    let ids = [...STATE[kind].selected];
    if (!ids.length) return;
    // Drop rows the schema won't delete (e.g. the default project) so
    // the confirm count and the toast both reflect what'll actually go.
    let skipped = 0;
    if (schema.canDeleteRow) {
      const before = ids.length;
      ids = ids.filter((rid) => {
        const row = STATE[kind].rows.find((r) => r.redpash_id === rid);
        return !row || schema.canDeleteRow(row);
      });
      skipped = before - ids.length;
    }
    if (!ids.length) {
      toast.info("Nothing to delete — the default project can't be removed.");
      return;
    }
    const noun = kind === "files" ? "file" : kind.slice(0, -1);
    if (!confirm(`Delete ${ids.length} ${noun}${ids.length !== 1 ? "s" : ""}?`)) return;
    let ok = 0, fail = 0;
    for (const rid of ids) {
      try { await schema.deleteOne(rid); ok++; } catch { fail++; }
    }
    STATE[kind].selected.clear();
    await loadTable(kind);
    toast.success(`Deleted ${ok}`
      + (fail ? ` (${fail} failed)` : "")
      + (skipped ? ` — ${skipped} skipped (default project)` : "")
      + ".");
  };

  // ── Edit mode — dblclick an editable cell ─────────────────────────
  // Per-column `edit` spec drives this:
  //   type:"text"   — swaps the cell for an inline text input.
  //   type:"bool"   — swaps the cell for a Yes/No <select>.
  //   type:"enum"   — swaps the cell for a <select> of fixed
  //                   `edit.options` ([value, label] pairs) — projects'
  //                   stage / status.
  //   type:"select" — swaps the cell for an entity picker; `edit.source`
  //                   ("users" | "projects") picks the option list
  //                   (owner reassignment / file → project move).
  //   type:"open"   — hands off to the kind's builder (reports / dashboards).
  // text / bool / enum / select all commit through schema.saveEdit → PATCH.
  window.objCellEdit = (td) => {
    const panel = root.querySelector(".rp-rt-panel");
    if (!panel?.classList.contains("rp-rt-mode-edit")) return;
    const kind = currentKind, schema = SCHEMAS[kind];
    const rid  = td.dataset.rid;
    const type = td.dataset.editType;

    if (type === "open") { schema.openEditor?.(rid); return; }
    if (td.querySelector("input, select")) return;   // already editing
    const field = td.dataset.editField;

    if (type === "select") { _objOpenSelectEdit(td, kind, schema, rid, field); return; }

    if (type === "bool") {
      const oldVal = td.textContent.trim() === "Yes";
      const sel = document.createElement("select");
      sel.className = "rp-rt-cell-input";
      sel.innerHTML = `<option value="true">Yes</option><option value="false">No</option>`;
      sel.value = oldVal ? "true" : "false";
      td.textContent = "";
      td.appendChild(sel);
      sel.focus();
      let done = false;
      const restore = () => { renderTable(kind); };
      const commit  = async () => {
        if (done) return;
        done = true;
        const newVal = sel.value === "true";
        if (newVal === oldVal) { restore(); return; }
        try {
          await schema.saveEdit(rid, field, newVal);
          toast.success("Saved.");
          await loadTable(kind);
        } catch (err) {
          restore();
          toast.error(`Save failed: ${err.body?.error ?? err.message}`);
        }
      };
      sel.addEventListener("change", commit);
      sel.addEventListener("blur", commit);
      sel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { done = true; restore(); }
      });
      return;
    }

    if (type === "enum") {
      // Fixed-option <select> — options come from the column's
      // `edit.options`; the current value from the row (the cell shows
      // a badge, not the raw value).
      const col  = schema.columns.find((c) => c.edit?.field === field);
      const opts = col?.edit?.options ?? [];
      const row  = STATE[kind].rows.find((r) => r.redpash_id === rid);
      const oldVal = row?.[field];
      const sel = document.createElement("select");
      sel.className = "rp-rt-cell-input";
      sel.innerHTML = opts.map(([v, l]) =>
        `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      sel.value = oldVal;
      td.textContent = "";
      td.appendChild(sel);
      sel.focus();
      let done = false;
      const restore = () => { renderTable(kind); };
      const commit  = async () => {
        if (done) return;
        done = true;
        const newVal = sel.value;
        if (!newVal || newVal === oldVal) { restore(); return; }
        try {
          await schema.saveEdit(rid, field, newVal);
          toast.success("Saved.");
          await loadTable(kind);
        } catch (err) {
          restore();
          toast.error(`Save failed: ${err.body?.error ?? err.message}`);
        }
      };
      sel.addEventListener("change", commit);
      sel.addEventListener("blur", commit);
      sel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { done = true; restore(); }
      });
      return;
    }

    if (type !== "text") return;

    // Read the current value from the row, not the cell text — a cell
    // rendered as a badge (e.g. a `null` Encoding) has textContent
    // "null", which must not pre-fill the input.
    const row    = STATE[kind].rows.find((r) => r.redpash_id === rid);
    const oldVal = row && row[field] != null ? String(row[field]) : "";
    const inp = document.createElement("input");
    inp.className = "rp-rt-cell-input";
    inp.value = oldVal;
    inp.autocomplete = "off";
    inp.spellcheck   = false;
    td.textContent = "";
    td.appendChild(inp);
    inp.focus();
    inp.select();

    let done = false;
    // restore / commit both re-render the table — cheap, and it puts
    // the cell back through its schema render() so the markup is right.
    const restore = () => { renderTable(kind); };
    const commit  = async () => {
      if (done) return;
      done = true;
      const newVal = inp.value.trim();
      if (!newVal || newVal === oldVal) { restore(); return; }
      try {
        await schema.saveEdit(rid, field, newVal);
        toast.success("Saved.");
        await loadTable(kind);
      } catch (err) {
        restore();
        toast.error(`Save failed: ${err.body?.error ?? err.message}`);
      }
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { done = true; restore(); }
      if (e.key === "Tab")    { e.preventDefault(); inp.blur(); }
    });
  };

  // "Add" button — kind-aware. reports / dashboards open their
  // builder's "new" mode via the schema's `addHref`; projects / files
  // open the upload modal; companies use `addAction` (prompt + POST);
  // users still hides the button.
  window.objAdd = async () => {
    const schema = SCHEMAS[currentKind];
    if (schema.addAction) {
      try {
        const ok = await schema.addAction();
        if (ok) { toast.success("Created."); await loadTable(currentKind); }
      } catch (err) {
        toast.error(`Create failed: ${err.body?.error ?? err.message}`);
      }
      return;
    }
    if (schema.addHref) { location.hash = schema.addHref; return; }
    _objOpenUploadModal();
  };

  // ── Customizable tab strip ────────────────────────────────────────
  // Add / remove tabs from the user's set. Both persist the new set to
  // the account via rpSavePref("objects_tabs", …) — which also updates
  // the in-memory session, so the Settings control reflects the change
  // next time profile mounts. localStorage is NOT touched (objects_tabs
  // isn't in main.js's PREFS_LS_MAP — it's an array, not a scalar).
  const _persistObjTabs = () => {
    window.rpSavePref?.("objects_tabs", [...objTabs]);
  };

  // Remove a tab. Refuses the last one (min-1 — you always keep one
  // object type visible). If the active tab is removed, the nearest
  // neighbour becomes active.
  window.objRemoveTab = (kind) => {
    const idx = objTabs.indexOf(kind);
    if (idx === -1 || objTabs.length <= 1) return;
    objTabs.splice(idx, 1);
    _persistObjTabs();
    if (currentKind === kind) {
      // objActivateTab re-renders the strip; just pick a neighbour.
      window.objActivateTab(objTabs[Math.min(idx, objTabs.length - 1)]);
    } else {
      _renderTabs(root);
    }
  };

  // Add a hidden object type back as a tab, and switch to it.
  window.objAddTab = (kind) => {
    if (!KINDS.includes(kind) || objTabs.includes(kind)) return;
    objTabs.push(kind);
    _persistObjTabs();
    _closeAddMenu();
    window.objActivateTab(kind);  // activates + re-renders the strip
  };

  window.objToggleAddMenu = (btn) => {
    const menu = btn.parentElement?.querySelector(".obj-tab-add-menu");
    if (menu) menu.hidden = !menu.hidden;
  };

  // Drag-to-reorder tabs. Same shape as the column-drag pattern:
  // dragstart stamps the source kind, dragover marks the target,
  // drop splices `objTabs` (insert before target). Mutation is
  // persisted to prefs.objects_tabs so the new order shows up in
  // Profile's Settings panel as well.
  let _objTabDragKind = null;
  window.objTabDragStart = (e) => {
    const tab = e.currentTarget;
    _objTabDragKind = tab?.dataset?.kind || null;
    if (_objTabDragKind) {
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", _objTabDragKind); } catch {}
      tab.classList.add("obj-tab-drag");
    }
  };
  window.objTabDragOver = (e) => {
    if (!_objTabDragKind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const tab = e.currentTarget;
    if (tab && tab.dataset.kind !== _objTabDragKind) tab.classList.add("obj-tab-drop");
  };
  window.objTabDragLeave = (e) => {
    e.currentTarget?.classList.remove("obj-tab-drop");
  };
  window.objTabDragEnd = () => {
    _root.querySelectorAll(".obj-tab.obj-tab-drag, .obj-tab.obj-tab-drop")
      .forEach((t) => t.classList.remove("obj-tab-drag", "obj-tab-drop"));
    _objTabDragKind = null;
  };
  window.objTabDrop = (e) => {
    e.preventDefault();
    const targetTab = e.currentTarget;
    const target = targetTab?.dataset?.kind;
    const source = _objTabDragKind;
    window.objTabDragEnd();
    if (!source || !target || source === target) return;
    const from = objTabs.indexOf(source);
    if (from < 0) return;
    objTabs.splice(from, 1);
    const insertAt = objTabs.indexOf(target);
    if (insertAt < 0) return;
    objTabs.splice(insertAt, 0, source);
    _persistObjTabs();
    _renderTabs(_root);
  };
  const _closeAddMenu = () => {
    root.querySelector("#obj-tabs .obj-tab-add-menu")
      ?.setAttribute("hidden", "");
  };

  // Close toolbar dropdowns (pill + cols), the filter dropdowns, and
  // the add-tab menu on outside click. Guarded so re-mounts don't
  // stack listeners.
  if (!window._objDdWired) {
    window._objDdWired = true;
    document.addEventListener("click", (e) => {
      // The cols dropdowns hold checkboxes / a drag list the user
      // interacts with, so only close when the click is fully outside
      // both the trigger and the panel.
      if (!e.target.closest(".rp-rt-pill-btn,.rp-rt-pill-dd,.rp-rt-cols-wrap")) {
        document.querySelectorAll(".rp-rt-pill-dd.open, .rp-rt-cols-dd.open")
          .forEach((o) => o.classList.remove("open"));
      }
      // The filter dropdowns — close when the click is outside both the
      // column / op dropdowns (.rp-rt-fb-dd) and the value input + its
      // suggestion menu (.rp-rt-fb-val-wrap).
      if (!e.target.closest(".rp-rt-fb-dd, .rp-rt-fb-val-wrap")) _objCloseFbMenus();
      if (!e.target.closest(".obj-tab-add-wrap")) {
        document.querySelectorAll(".obj-tab-add-menu:not([hidden])")
          .forEach((m) => m.setAttribute("hidden", ""));
      }
    });
  }

  // The filter dropdown menus are position:fixed — scrolling the
  // predicate list would leave them stranded, so close them on scroll.
  // Bound per mount (the partial's .rp-rt-filter-inner is re-injected).
  root.querySelector(".rp-rt-filter-inner")
    ?.addEventListener("scroll", _objCloseFbMenus);
}

// ── Per-tab fetch ──────────────────────────────────────────────────
async function loadTable(kind) {
  const schema = SCHEMAS[kind];
  const tbody  = _root.querySelector(".rp-rt-panel [data-rt-tbody]");
  if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;color:var(--muted);padding:1rem">Loading…</td></tr>`;
  try {
    const res = await schema.fetch();
    STATE[kind].rows = res.items ?? [];
  } catch (err) {
    STATE[kind].rows = [];
    if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;color:var(--red);padding:1rem">${esc(err.body?.error ?? err.message)}</td></tr>`;
    return;
  }
  // Switched tabs mid-fetch? Drop the stale render.
  if (kind !== currentKind) return;
  renderTable(kind);
}

// ── Column resize ─────────────────────────────────────────────────
// Ported from the Django table (app.css `.hp-col-resize` + api.js
// _tblResizeDown/Move/Up). The library already styles the handle —
// `.rp-rt-col-resize` is the absolute-positioned span sitting on each
// data-col <th>'s right edge with an accent line on hover. JS owns
// the drag: mousedown captures start X + start width, mousemove
// pushes a px value into the <th>'s inline style + the state's
// colWidths map (so renderTable re-applies it on every paint, mouseup
// releases the document-level listeners.
let _objColResize = null;   // { th, handle, state, key, startX, startW }

function _objInitColResize(thead, state) {
  thead.querySelectorAll(".rp-rt-col-resize").forEach((h) => {
    h.addEventListener("mousedown", (e) => _objColResizeDown(e, state));
  });
}
function _objColResizeDown(e, state) {
  e.preventDefault();
  const handle = e.currentTarget;
  const th     = handle.closest("th");
  if (!th) return;
  _objColResize = {
    th, handle, state,
    key:    th.dataset.rtCol,
    startX: e.clientX,
    startW: th.offsetWidth,
  };
  handle.classList.add("rp-rt-resizing");
  document.body.classList.add("rp-rt-col-resizing");
  document.addEventListener("mousemove", _objColResizeMove);
  document.addEventListener("mouseup",   _objColResizeUp);
}
function _objColResizeMove(e) {
  if (!_objColResize) return;
  // Min 3rem so columns can't be dragged into oblivion.
  const w = Math.max(48, _objColResize.startW + e.clientX - _objColResize.startX);
  _objColResize.th.style.width    = `${w}px`;
  _objColResize.th.style.minWidth = `${w}px`;
}
function _objColResizeUp() {
  if (_objColResize) {
    // Persist to state.colWidths so the next renderTable keeps it.
    const { th, handle, state, key } = _objColResize;
    if (state && key) {
      state.colWidths = state.colWidths || {};
      state.colWidths[key] = th.offsetWidth;
    }
    handle.classList.remove("rp-rt-resizing");
    _objColResize = null;
  }
  document.body.classList.remove("rp-rt-col-resizing");
  document.removeEventListener("mousemove", _objColResizeMove);
  document.removeEventListener("mouseup",   _objColResizeUp);
}

function renderTable(kind) {
  const schema = SCHEMAS[kind];
  const state  = STATE[kind];
  const panel  = _root.querySelector(".rp-rt-panel");
  if (!panel || kind !== currentKind) return;

  // Filter — toolbar search AND the predicate filter panel. Both must
  // pass; predicates combine among themselves with AND/OR (objCombinator).
  state.filtered = state.rows.filter((r) => {
    if (state.search && !_objMatchesSearch(kind, r, state.search)) return false;
    if (objFavOnly && !r.is_favorite) return false;
    return _objRowMatchesFilter(r, kind);
  });

  // Chained sort — walk the keys in order, first non-zero comparison
  // wins. `_objColValue` covers the files schema's render-only keys.
  // Per-cell-pair comparator: nulls / empty always sink, numeric when
  // both sides parse, locale-string otherwise.
  if (state.sorts?.length) {
    const cmpOne = (a, b, col, dir) => {
      const av = _objColValue(kind, col, a);
      const bv = _objColValue(kind, col, b);
      const an = av == null || av === "";
      const bn = bv == null || bv === "";
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      const mult = dir === "desc" ? -1 : 1;
      const anum = typeof av === "number" ? av : Number(av);
      const bnum = typeof bv === "number" ? bv : Number(bv);
      if (Number.isFinite(anum) && Number.isFinite(bnum)) {
        return (anum - bnum) * mult;
      }
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base", numeric: true }) * mult;
    };
    state.filtered.sort((a, b) => {
      for (const k of state.sorts) {
        const c = cmpOne(a, b, k.col, k.dir);
        if (c !== 0) return c;
      }
      return 0;
    });
  }

  // Paginate. rowsPerPage is always one of OBJ_ROWS_OPTS now — no "all".
  const perPage = state.rowsPerPage;
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / perPage));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * perPage;
  const slice = state.filtered.slice(start, start + perPage);

  // Visible columns, in the user's order — drives both header + body.
  const vCols   = _visibleOrderedCols(kind);
  const withNum = objShowRowNums;   // leading "#" row-number column

  // Header — leading select checkbox + trailing delete columns are
  // ALWAYS emitted (data-mode-col); CSS collapses them unless the panel
  // is in the matching mode. The "#" column is emitted only when row
  // numbers are toggled on.
  const thead = panel.querySelector("[data-rt-thead]");
  if (thead) {
    // Each data-col <th> carries an absolute-positioned resize handle
    // (.rp-rt-col-resize); library CSS handles the cursor + hover-accent
    // border. _objInitColResize wires the drag below. Width comes from
    // state.colWidths (set on mouseup) so user resizes survive every
    // re-render in the session.
    // Build a key→{dir, rank} map for the sort chain so each header can
    // show its rank badge (1, 2, 3…) when more than one key is active.
    const sortRank = new Map(
      (state.sorts || []).map((k, i) => [k.col, { dir: k.dir, rank: i + 1 }]),
    );
    const showRanks = sortRank.size > 1;
    const cols = vCols.map((c) => {
      const w = state.colWidths?.[c.key];
      const wStyle = w ? ` style="width:${w}px;min-width:${w}px"` : "";
      const entry  = sortRank.get(c.key);
      const cls    = `rp-rt-th-sortable${entry ? " rp-rt-sort-th" : ""}`;
      const arrow  = entry
        ? ` <i class="bi bi-arrow-${entry.dir === "desc" ? "down" : "up"} rp-rt-sort-ico rp-rt-sort-active"></i>${showRanks ? `<span class="rp-rt-sort-rank">${entry.rank}</span>` : ""}`
        : ` <i class="bi bi-arrow-down-up rp-rt-sort-ico"></i>`;
      // Inline stopPropagation on the resize grip so clicking it never
      // bubbles up as a sort click (the mousedown handler preventDefaults
      // the drag, but a no-drag click would still fire on the parent th).
      // Pass `event` so objSortBy can read shiftKey for multi-sort.
      // draggable + drag handlers mirror cleaner.js's ovColDrag*: grab
      // any header, drop on another → reorder in place. State lives on
      // `state.colOrder`, persisted to prefs.objects_views via the
      // existing Save view button (no per-drag PATCH — column order
      // is a UI pref, not a data-pipeline step).
      return `<th data-rt-col="${esc(c.key)}" class="${cls}"${wStyle}
                  draggable="true"
                  onclick="objSortBy('${esc(c.key)}', event)"
                  ondragstart="objColDragStart(event)"
                  ondragover="objColDragOver(event)"
                  ondragleave="objColDragLeave(event)"
                  ondrop="objColDrop(event)"
                  ondragend="objColDragEnd(event)">${esc(c.label)}${arrow}<span class="rp-rt-col-resize" onclick="event.stopPropagation()" draggable="false"></span></th>`;
    }).join("");
    thead.innerHTML = `<tr>
      <!-- Open-in-* icon cell is leading now (was trailing). Keeps
           the always-visible row actions on the LEFT, so users land
           on them at the start of the row instead of scanning to the
           end. Mode-gated select / delete columns stay where they
           were (select leading-ish, delete trailing) so toggling a
           mode doesn't re-flow the table. -->
      <th class="obj-row-open-cell" style="width:1px"></th>
      <th data-mode-col="select" style="width:1.5rem">
        <input type="checkbox" id="obj-sel-all" onchange="objSelectAll(this.checked)" />
      </th>
      ${withNum ? `<th class="rp-rt-rownum-th">#</th>` : ""}
      ${cols}
      <th data-mode-col="delete" style="width:1.75rem"></th>
    </tr>`;
    _objInitColResize(thead, state);
  }

  // Body — every row carries the leading checkbox + trailing trash;
  // editable cells (schema `edit` spec) get data-edit-* + an ondblclick
  // hook. The <tr> is always a nav target, but the row-click handler
  // bails when a mode is active.
  const tbody = panel.querySelector("[data-rt-tbody]");
  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="${vCols.length + 3 + (withNum ? 1 : 0)}" style="text-align:center;color:var(--muted);padding:1rem">No ${kind} yet.</td></tr>`;
  } else {
    tbody.innerHTML = slice.map((r, i) => {
      const rid  = esc(r.redpash_id);
      const sel  = state.selected.has(r.redpash_id);
      const href = schema.rowHref ? schema.rowHref(r) : null;
      const cells = vCols.map((c) => {
        if (c.edit) {
          const field = c.edit.field ? ` data-edit-field="${esc(c.edit.field)}"` : "";
          return `<td data-rid="${rid}" data-edit-type="${esc(c.edit.type)}"${field} ondblclick="objCellEdit(this)">${c.render(r)}</td>`;
        }
        return `<td>${c.render(r)}</td>`;
      }).join("");
      // Per-row action cluster — kind-aware (see _objRowOpenButtons
      // for the per-kind 🪄 / 📊 / 📐 matrix and stage gating). Kinds
      // without a meaningful navigation target (companies, users) yield
      // an empty string and just render an empty cell.
      const openBtn = _objRowOpenButtons(kind, r);
      // Trash button — disabled (with an explanatory tooltip) on rows
      // the schema's `canDeleteRow` rejects, e.g. the default project.
      const delBtn = (schema.canDeleteRow && !schema.canDeleteRow(r))
        ? `<button type="button" class="rp-rt-row-del" disabled title="Set another project as Default before deleting this one"><i class="bi bi-trash3"></i></button>`
        : `<button type="button" class="rp-rt-row-del" title="Delete" onclick="objRowDelete('${rid}')"><i class="bi bi-trash3"></i></button>`;
      return `<tr class="${sel ? "rp-rt-row-sel" : ""}">
        <td class="obj-row-open-cell">${openBtn}</td>
        <td data-mode-col="select"><input type="checkbox" class="obj-row-chk" data-rid="${rid}" ${sel ? "checked" : ""} onchange="objRowSelect(this)" /></td>
        ${withNum ? `<td class="rp-rt-rownum-td">${(start + i + 1).toLocaleString()}</td>` : ""}
        ${cells}
        <td data-mode-col="delete">${delBtn}</td>
      </tr>`;
    }).join("");
  }

  // Footer: rows-info + paging.
  const info = panel.querySelector("[data-rt-rows-info]");
  if (info) {
    info.textContent = state.filtered.length
      ? `${start + 1}–${Math.min(start + perPage, state.filtered.length)} of ${state.filtered.length}`
      : "";
  }
  const pages = panel.querySelector("[data-rt-pages]");
  if (pages) {
    if (totalPages <= 1) {
      pages.innerHTML = "";
    } else {
      // Library classes are `.rp-rt-pg` + `.on` (redtable.css) — not
      // `rp-rt-page`/`is-active`, which were unstyled.
      pages.innerHTML = Array.from({ length: totalPages }, (_, i) => i + 1)
        .map((p) => `<button class="rp-rt-pg${p === state.page ? " on" : ""}" data-rt-page="${p}">${p}</button>`)
        .join("");
      pages.querySelectorAll("[data-rt-page]").forEach((b) => {
        b.addEventListener("click", () => { state.page = +b.dataset.rtPage; renderTable(kind); });
      });
    }
  }

  _renderObjSelChip();
  _renderHdrMeta(kind);
}

// Header meta line — live row count for the active tab. Shows the
// plain total ("8 users"), or "shown of total" when a search / filter
// is narrowing the view ("3 of 8 users").
function _renderHdrMeta(kind) {
  const el = _root?.querySelector("#obj-hdr-meta");
  if (!el) return;
  const st    = STATE[kind];
  const total = st.rows.length;
  const shown = st.filtered.length;
  const noun  = total === 1 ? _SINGULAR[kind] : kind;
  el.textContent = shown === total
    ? `${total} ${noun}`
    : `${shown} of ${total} ${kind}`;
}

// Selection chip + bulk-delete button visibility — ported from the
// Cleaner's _renderSelectionChip. The chip + red trash button live in
// the toolbar; CSS gates the chip on the panel being in select-mode
// AND data-has-sel="1". Also syncs the master checkbox (indeterminate
// when the selection is partial).
function _renderObjSelChip() {
  const chip = _root.querySelector("#obj-sel-chip");
  const cnt  = _root.querySelector("#obj-sel-count");
  const del  = _root.querySelector("#obj-bulk-del-btn");
  const n    = STATE[currentKind].selected.size;
  if (chip) chip.dataset.hasSel = n > 0 ? "1" : "0";
  if (cnt)  cnt.textContent = `${n} selected`;
  if (del)  del.style.display = n > 0 ? "inline-flex" : "none";
  // Files-tab-only bulk actions on the selection — score / clear-score.
  const score      = _root.querySelector("#obj-bulk-score-btn");
  const clearScore = _root.querySelector("#obj-bulk-clear-score-btn");
  const show = n > 0 && currentKind === "files";
  if (score)      score.style.display      = show ? "inline-flex" : "none";
  if (clearScore) clearScore.style.display = show ? "inline-flex" : "none";
  const head  = _root.querySelector("#obj-sel-all");
  const total = _root.querySelectorAll(".rp-rt-panel tbody .obj-row-chk").length;
  if (head) {
    head.checked       = total > 0 && n === total;
    head.indeterminate = n > 0 && n < total;
  }
}

// ── Predicate filter panel ─────────────────────────────────────────
// Ported from the redpash-demo redtable prototype, adapted to this
// page's obj* engine. Each row is (column · op · value · ✕); rows
// combine AND/OR per the Match pill. objApplyFilter snapshots the rows
// into objPredicates / objCombinator; renderTable's filter step calls
// _objRowMatchesFilter. The filter resets on every tab switch (columns
// differ per kind). The "Report tools" tab is hidden on this page.
const OBJ_FILTER_OPS = [
  ["eq", "equals"], ["neq", "not equals"], ["contains", "contains"],
  ["starts_with", "starts with"], ["ends_with", "ends with"],
  ["in", "in (comma-list)"], ["not_in", "not in (comma-list)"],
  ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"],
  ["between", "between (lo, hi)"], ["before", "before (YYYY-MM-DD)"],
  ["after", "after (YYYY-MM-DD)"], ["is_null", "is null"], ["not_null", "is not null"],
];
let objPredicates = [];
let objCombinator = "and";

// Raw, filterable value for a column key on a row. Most column keys map
// straight to a row field; the files schema has a few render-only
// columns whose key ≠ field — handled explicitly here so SCHEMAS stays
// untouched.
function _objColValue(kind, key, row) {
  if (kind === "files") {
    if (key === "filename")  return row.display_name ?? row.filename;
    if (key === "project")   return projectName(row.project_redpash_id);
    if (key === "cleanness") return row.cleanness_pct;
    if (key === "file_size") return row.file_size_bytes;
  }
  return row[key];
}

// Toolbar search — true when ANY of the kind's columns contains `q`
// (already lowercased + trimmed by objSearch). Goes through every
// schema column via _objColValue, so it covers hidden-by-default
// columns too (Project ID, owner fields, …) and self-maintains as
// columns are added — no per-schema search field to keep in sync.
function _objMatchesSearch(kind, row, q) {
  return SCHEMAS[kind].columns.some((c) => {
    const v = _objColValue(kind, c.key, row);
    return v != null && String(v).toLowerCase().includes(q);
  });
}

// One custom dropdown — a button + a div menu + a hidden input holding
// the value. Replaces the native <select> so it matches the toolbar's
// pill dropdowns (a native <select>'s popup can't be styled). The
// hidden `[data-fb-*]` input keeps `.value` reads working unchanged
// across _objFilterRowChanged / objApplyFilter / _objRefreshFilterApply.
function _objFbDropdown(dataAttr, items, selected) {
  const itemHtml = items.map(([val, label]) =>
    `<div class="rp-rt-fb-dd-item${val === selected ? " rp-rt-dd-selected" : ""}"`
    + ` data-val="${esc(val)}" onclick="_objFbDdPick(this)">${esc(label)}</div>`).join("");
  const selLabel = (items.find(([v]) => v === selected) ?? items[0])?.[1] ?? "";
  return `<div class="rp-rt-fb-dd">`
    + `<button type="button" class="rp-rt-fb-dd-btn" onclick="_objFbDdToggle(this)">`
      + `<span class="rp-rt-fb-dd-lbl">${esc(selLabel)}</span>`
      + `<i class="bi bi-chevron-down rp-rt-fb-dd-chev"></i>`
    + `</button>`
    + `<div class="rp-rt-fb-dd-menu">${itemHtml}</div>`
    + `<input type="hidden" ${dataAttr} value="${esc(selected)}" />`
    + `</div>`;
}

// Build one (column · op · value · ✕) predicate row from the active
// kind's columns. Column + op are custom dropdowns (_objFbDropdown);
// the value input has a custom suggestion menu (_objFbValInput) — all
// three match the toolbar pill dropdowns. A native <datalist> would
// have been simpler, but its popup can't be styled to match.
function _objAppendFilterRow() {
  const box = _root?.querySelector("#obj-filter-rows");
  const schema = SCHEMAS[currentKind];
  if (!box || !schema) return;
  const colItems = schema.columns.map((c) => [c.key, c.label]);
  const colDd = _objFbDropdown("data-fb-col", colItems, colItems[0]?.[0]);
  const opDd  = _objFbDropdown("data-fb-op", OBJ_FILTER_OPS, OBJ_FILTER_OPS[0][0]);
  const div = document.createElement("div");
  div.className = "rp-rt-fb-row";
  // Three stacked rows: ✕ (top-right) · the two dropdowns 50/50 · the
  // value field — laid out by .rp-rt-fb-row's flex column.
  div.innerHTML =
    `<button class="rp-rt-fb-rm" onclick="_objFilterRowRemove(this)" title="Remove predicate"><i class="bi bi-x"></i></button>`
    + `<div class="rp-rt-fb-selects">${colDd}${opDd}</div>`
    + `<div class="rp-rt-fb-val-wrap">`
      + `<input class="rp-rt-fb-val" data-fb-val type="text" placeholder="value"`
      + ` oninput="_objFbValInput(this)" onfocus="_objFbValInput(this)" />`
      + `<div class="rp-rt-fb-dd-menu" data-fb-val-menu></div>`
    + `</div>`;
  box.appendChild(div);
  _objRefreshFilterApply();
}

// Keep at least one editable row so the user always has somewhere to start.
function _objEnsureFilterRow() {
  const box = _root?.querySelector("#obj-filter-rows");
  if (box && !box.children.length) _objAppendFilterRow();
}

window.objAddFilterRow = () => _objAppendFilterRow();

// ── Custom filter dropdown — open / close / pick ───────────────────
// position:fixed so the menu escapes the filter panel's overflow-y:auto
// clipping. Only one fb menu open at a time.
function _objCloseFbMenus() {
  _root?.querySelectorAll(".rp-rt-fb-dd-menu.open")
    .forEach((m) => m.classList.remove("open"));
}

// Anchor a fb menu (column / op dropdown OR a value-suggestion menu)
// under `anchorEl` and open it. Shared by _objFbDdToggle and
// _objShowValSuggestions. Park the menu at 0,0, measure where that
// actually lands (`o`), then offset from there — `position: fixed` is
// viewport-relative unless an ancestor has a transform/filter, and this
// works either way. Centered under the anchor (like the toolbar pill
// dropdowns), never past the left edge, flipped above when there's no
// room below. No right-edge clamp — the filter panel is narrow and
// left-anchored, so these menus can't reach the viewport's right side.
function _objFbPositionMenu(menu, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  menu.style.minWidth   = `${r.width}px`;
  menu.style.visibility = "hidden";   // hide the parked frame
  menu.style.left = "0px";
  menu.style.top  = "0px";
  menu.classList.add("open");
  const o  = menu.getBoundingClientRect();
  const mw = o.width, mh = o.height;
  const vx = Math.max(4, r.left + r.width / 2 - mw / 2);
  let   vy = r.bottom + 4;
  if (vy + mh > window.innerHeight && r.top - mh - 4 > 0) vy = r.top - mh - 4;
  menu.style.left = `${vx - o.left}px`;
  menu.style.top  = `${vy - o.top}px`;
  menu.style.visibility = "";
}

window._objFbDdToggle = (btn) => {
  const menu = btn.parentElement.querySelector(".rp-rt-fb-dd-menu");
  const wasOpen = menu.classList.contains("open");
  _objCloseFbMenus();
  if (wasOpen) return;
  _objFbPositionMenu(menu, btn);
};

window._objFbDdPick = (item) => {
  const dd     = item.closest(".rp-rt-fb-dd");
  const hidden = dd.querySelector("input[type=hidden]");
  hidden.value = item.dataset.val;
  dd.querySelector(".rp-rt-fb-dd-lbl").textContent = item.textContent;
  item.parentElement.querySelectorAll(".rp-rt-fb-dd-item")
    .forEach((i) => i.classList.toggle("rp-rt-dd-selected", i === item));
  _objCloseFbMenus();
  _objFilterRowChanged(hidden);
};

// ── Value-field autocomplete ───────────────────────────────────────
// The value input gets a custom suggestion menu (a `.rp-rt-fb-dd-menu`
// styled like the column / op dropdowns) instead of a native
// <datalist> — whose popup can't be styled to match.

// Distinct existing values for `col` across the current rows, sorted,
// capped at 50 so a high-cardinality column doesn't bloat the list.
function _objColDistinctValues(col) {
  const seen = new Set();
  for (const r of STATE[currentKind].rows) {
    const v = _objColValue(currentKind, col, r);
    if (v == null || v === "") continue;
    seen.add(String(v));
    if (seen.size >= 50) break;
  }
  return [...seen].sort();
}

// Show / refresh the value-suggestion menu for a row — distinct values
// of the selected column, filtered by what's typed so far. Reposition
// only when first opening (the input doesn't move while typing).
function _objShowValSuggestions(input) {
  const row  = input.closest(".rp-rt-fb-row");
  const menu = row?.querySelector("[data-fb-val-menu]");
  const col  = row?.querySelector("[data-fb-col]")?.value;
  if (!menu || !col) return;
  const q = input.value.trim().toLowerCase();
  const all = _objColDistinctValues(col);
  const matches = (q ? all.filter((v) => v.toLowerCase().includes(q)) : all);
  if (!matches.length) { menu.classList.remove("open"); return; }
  menu.innerHTML = matches.map((v) =>
    `<div class="rp-rt-fb-dd-item" onmousedown="event.preventDefault();_objFbValPick(this)">`
    + `${esc(v)}</div>`).join("");
  if (!menu.classList.contains("open")) {
    _objCloseFbMenus();                 // close any column / op menu first
    _objFbPositionMenu(menu, input);
  }
}

// The value input's oninput / onfocus — reshape per op, refresh Apply,
// and update the suggestion menu.
window._objFbValInput = (input) => {
  _objFilterRowChanged(input);
  _objShowValSuggestions(input);
};

// Pick a suggestion — fired on mousedown (before blur) with the default
// prevented so the input keeps focus.
window._objFbValPick = (item) => {
  const row   = item.closest(".rp-rt-fb-row");
  const input = row?.querySelector("[data-fb-val]");
  if (!input) return;
  input.value = item.textContent;
  item.closest("[data-fb-val-menu]")?.classList.remove("open");
  _objFilterRowChanged(input);          // refresh the Apply button state
};

// Reshape the value input to match the op (text → number → date →
// hidden), then refresh the Apply button's enabled state.
window._objFilterRowChanged = (el) => {
  const row = el.closest(".rp-rt-fb-row");
  if (!row) return;
  const op  = row.querySelector("[data-fb-op]")?.value;
  const inp = row.querySelector("[data-fb-val]");
  if (op && inp) {
    if (op === "is_null" || op === "not_null") {
      row.classList.add("rp-rt-fb-no-value");
    } else {
      row.classList.remove("rp-rt-fb-no-value");
      const dateOp    = op === "before" || op === "after";
      const numericOp = ["gt", "gte", "lt", "lte"].includes(op);
      inp.type = dateOp ? "date" : numericOp ? "number" : "text";
      inp.placeholder = op === "between" ? "10, 50"
                      : (op === "in" || op === "not_in") ? "France, Italy"
                      : "value";
    }
  }
  _objRefreshFilterApply();
};

window._objFilterRowRemove = (btn) => {
  btn.closest(".rp-rt-fb-row")?.remove();
  _objRefreshFilterApply();
};

// Apply enabled once ≥1 row has column + op + a value (or a value-less op).
function _objRefreshFilterApply() {
  const apply = _root?.querySelector("#obj-filter-apply");
  if (!apply) return;
  let ok = false;
  _root.querySelectorAll("#obj-filter-rows .rp-rt-fb-row").forEach((r) => {
    if (ok) return;
    const op = r.querySelector("[data-fb-op]")?.value;
    if (!op) return;
    if (op === "is_null" || op === "not_null") { ok = true; return; }
    const val = r.querySelector("[data-fb-val]");
    if (val && val.value.trim() !== "") ok = true;
  });
  apply.disabled = !ok;
}

// One-shot animation helper used by the filter-panel buttons. Reflow +
// animationend removal lets repeat clicks re-fire the same keyframes.
function _rpAnimOnce(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true });
}

// Clear-draft (eraser) — wipe rows, leave one empty.
window.objClearFilterDraft = (btn) => {
  _rpAnimOnce(btn ?? _root?.querySelector(".rp-rt-icon-btn[onclick*='objClearFilterDraft']"),
              "rp-rt-anim-wipe");
  const box = _root?.querySelector("#obj-filter-rows");
  if (box) box.innerHTML = "";
  _objEnsureFilterRow();
  _objRefreshFilterApply();
};

// Save filter (floppy) — placeholder for a future named-filter feature.
window.objSaveFilter = (btn) => {
  _rpAnimOnce(btn ?? _root?.querySelector(".rp-rt-icon-btn[onclick*='objSaveFilter']"),
              "rp-rt-anim-glow");
};

// AND/OR pill — flips .is-active; the value is read at apply time.
window.objSetCombo = (btn) => {
  btn.parentElement?.querySelectorAll("button")
     .forEach((b) => b.classList.remove("is-active"));
  btn.classList.add("is-active");
};

// Apply — snapshot every complete predicate row + the combinator, reset
// to page 1, re-render. Half-filled rows are dropped silently.
window.objApplyFilter = (btn) => {
  _rpAnimOnce(btn ?? _root?.querySelector("#obj-filter-apply"), "rp-rt-anim-pulse");
  const box  = _root?.querySelector("#obj-filter-rows");
  const rows = box ? [...box.querySelectorAll(".rp-rt-fb-row")] : [];
  const comboBtn = _root?.querySelector("#obj-fb-combo button.is-active");
  objCombinator = comboBtn ? comboBtn.dataset.combo : "and";
  const preds = [];
  rows.forEach((r) => {
    const column = r.querySelector("[data-fb-col]")?.value;
    const op     = r.querySelector("[data-fb-op]")?.value;
    if (!column || !op) return;
    const pred = { column, op };
    if (op === "is_null" || op === "not_null") { preds.push(pred); return; }
    const raw = r.querySelector("[data-fb-val]")?.value ?? "";
    if (op === "in" || op === "not_in") {
      pred.value = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!pred.value.length) return;
    } else if (op === "between") {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length !== 2) return;
      pred.value = parts.map(Number);
      if (pred.value.some(Number.isNaN)) return;
    } else if (["gt", "gte", "lt", "lte"].includes(op)) {
      const n = Number(raw);
      if (raw === "" || Number.isNaN(n)) return;
      pred.value = n;
    } else {
      if (raw === "") return;
      pred.value = raw;
    }
    preds.push(pred);
  });
  objPredicates = preds;
  STATE[currentKind].page = 1;
  renderTable(currentKind);
};

// Reset the filter — draft rows AND applied state. Called on every tab
// switch: columns differ per kind, so stale predicate rows would point
// at columns the new tab doesn't have. The filter is NOT part of a
// saved view (the filter panel's own save button owns that), so this
// always resets to a single empty row rather than restoring anything.
function objResetFilter() {
  objPredicates = [];
  objCombinator = "and";
  const box = _root?.querySelector("#obj-filter-rows");
  if (box) box.innerHTML = "";
  _objEnsureFilterRow();
  _objRefreshFilterApply();
  const combo = _root?.querySelector("#obj-fb-combo");
  combo?.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.combo === "and"));
}

// Side-panel tab switch (Filters / Report tools). Report tools is
// hidden on the Objects page, so in practice this only ever re-selects
// Filters — kept for structural parity with the Cleaner / Report pages.
window.objSidePane = (btn, paneId) => {
  const pane = _root?.querySelector(`#${paneId}`);
  if (!pane) return;
  const panel = pane.parentElement;
  btn.parentElement?.querySelectorAll(".rp-rt-side-tab")
     .forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  panel.querySelectorAll(".rp-rt-side-pane").forEach((p) => p.classList.remove("active"));
  pane.classList.add("active");
};

// Does `row` satisfy a single predicate?
function _objEvalPredicate(pred, row, kind) {
  const v  = _objColValue(kind, pred.column, row);
  const op = pred.op;
  if (op === "is_null")  return v == null || v === "";
  if (op === "not_null") return !(v == null || v === "");
  const sv = String(v ?? "").toLowerCase();
  if (op === "eq")          return sv === String(pred.value).toLowerCase();
  if (op === "neq")         return sv !== String(pred.value).toLowerCase();
  if (op === "contains")    return sv.includes(String(pred.value).toLowerCase());
  if (op === "starts_with") return sv.startsWith(String(pred.value).toLowerCase());
  if (op === "ends_with")   return sv.endsWith(String(pred.value).toLowerCase());
  if (op === "in")     return pred.value.some((x) => String(x).toLowerCase() === sv);
  if (op === "not_in") return !pred.value.some((x) => String(x).toLowerCase() === sv);
  if (op === "gt")  return Number(v) >  pred.value;
  if (op === "gte") return Number(v) >= pred.value;
  if (op === "lt")  return Number(v) <  pred.value;
  if (op === "lte") return Number(v) <= pred.value;
  if (op === "between") return Number(v) >= pred.value[0] && Number(v) <= pred.value[1];
  if (op === "before") return String(v).slice(0, 10) <  pred.value;
  if (op === "after")  return String(v).slice(0, 10) >  pred.value;
  return true;
}

// Combine all applied predicates for one row (AND/OR). No predicates →
// the row always passes.
function _objRowMatchesFilter(row, kind) {
  if (!objPredicates.length) return true;
  return objCombinator === "or"
    ? objPredicates.some((p) => _objEvalPredicate(p, row, kind))
    : objPredicates.every((p) => _objEvalPredicate(p, row, kind));
}

// ── Async select-edit (owner reassignment) ─────────────────────────
// The projects owner column edits via a <select> of every user —
// fetched once from GET /api/users and cached for the page's lifetime.
let objUsers = null;
async function _objEnsureUsers() {
  if (objUsers) return objUsers;
  const res = await api.get("/users");
  objUsers = res.items ?? [];
  return objUsers;
}

// Swap a cell for an entity picker. The column's `edit.source` selects
// the option list: "users" (default — owner reassignment) or
// "projects" (move a file to another project). Users load async (cell
// shows "…"); projects come from the prefetched `STATE.projects.rows`,
// with a fetch fallback. Commits the chosen redpash_id through
// schema.saveEdit then reloads the tab.
async function _objOpenSelectEdit(td, kind, schema, rid, field) {
  const row = STATE[kind].rows.find((r) => r.redpash_id === rid);
  if (!row) return;
  const oldVal = row[field];
  const source = schema.columns.find((c) => c.edit?.field === field)?.edit?.source ?? "users";

  // [value, label] pairs for the <option> list.
  let options;
  if (source === "projects") {
    let projs = STATE.projects.rows;
    if (!projs.length) {
      td.textContent = "…";
      try {
        projs = (await api.get("/projects")).items ?? [];
      } catch (err) {
        renderTable(kind);
        toast.error(`Couldn't load projects: ${err.body?.error ?? err.message}`);
        return;
      }
      if (kind !== currentKind || !td.isConnected) { renderTable(kind); return; }
    }
    options = projs.map((p) => [p.redpash_id, p.name]);
  } else {
    td.textContent = "…";
    let users;
    try {
      users = await _objEnsureUsers();
    } catch (err) {
      renderTable(kind);
      toast.error(`Couldn't load users: ${err.body?.error ?? err.message}`);
      return;
    }
    // Tab switched / row gone while the fetch was in flight — bail.
    if (kind !== currentKind || !td.isConnected) { renderTable(kind); return; }
    options = users.map((u) => [u.redpash_id, u.display_name]);
  }

  const sel = document.createElement("select");
  sel.className = "rp-rt-cell-input";
  sel.innerHTML = options.map(([v, l]) =>
    `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  sel.value = oldVal;
  td.textContent = "";
  td.appendChild(sel);
  sel.focus();

  let done = false;
  const restore = () => { renderTable(kind); };
  const commit  = async () => {
    if (done) return;
    done = true;
    const newVal = sel.value;
    if (!newVal || newVal === oldVal) { restore(); return; }
    try {
      await schema.saveEdit(rid, field, newVal);
      toast.success("Saved.");
      await loadTable(kind);
    } catch (err) {
      restore();
      toast.error(`Save failed: ${err.body?.error ?? err.message}`);
    }
  };
  sel.addEventListener("change", commit);
  sel.addEventListener("blur", commit);
  sel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { done = true; restore(); }
  });
}

// ── Upload modal ───────────────────────────────────────────────────
// The toolbar "+" on the projects / files tabs. A self-contained modal:
// a dropzone, the picked-file list, and a project field that
// autocompletes against existing project names. Typing a name that
// isn't in the list just creates that project — the backend's
// `ensure_named_project` does the find-or-create on upload. Files POST
// to /api/files/upload with `project_name`.
const _OBJ_UPLOAD_RE = /\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$/i;

function _objOpenUploadModal() {
  let pending = [];   // File[]

  const body = document.createElement("div");
  body.className = "obj-uz";
  body.innerHTML =
    `<div class="rp-muz-dropzone obj-uz-zone" role="button" tabindex="0">`
      + `<div class="rp-upload-ico"><i class="bi bi-cloud-upload-fill"></i></div>`
      + `<div class="rp-upload-h">Drop files or click to browse</div>`
      + `<div class="rp-upload-sub">CSV · TSV · Excel</div>`
    + `</div>`
    + `<input type="file" class="obj-uz-input" multiple`
      + ` accept=".csv,.tsv,.xlsx,.xls,.xlsm,.xlsb,.ods" style="display:none" />`
    + `<div class="obj-uz-files"></div>`
    + `<label class="obj-uz-lbl">Add to project</label>`
    + `<div class="obj-uz-field">`
      + `<input class="rp-rt-fb-val obj-uz-proj" type="text" autocomplete="off"`
        + ` placeholder="Existing project, or a new name…" />`
      + `<div class="rp-rt-fb-dd-menu obj-uz-menu"></div>`
    + `</div>`;

  const zone   = body.querySelector(".obj-uz-zone");
  const input  = body.querySelector(".obj-uz-input");
  const fileEl = body.querySelector(".obj-uz-files");
  const proj   = body.querySelector(".obj-uz-proj");
  const menu   = body.querySelector(".obj-uz-menu");

  // ── picked-file list ──
  const renderFiles = () => {
    fileEl.innerHTML = pending.map((f, i) =>
      `<div class="obj-uz-file"><i class="bi bi-file-earmark-text"></i>`
      + `<span class="obj-uz-file-name">${esc(f.name)}</span>`
      + `<button type="button" class="obj-uz-file-rm" data-i="${i}" title="Remove"><i class="bi bi-x"></i></button>`
      + `</div>`).join("");
  };
  const addFiles = (list) => {
    const arr = [...list];
    const bad = arr.filter((f) => !_OBJ_UPLOAD_RE.test(f.name));
    if (bad.length) toast.error(`Unsupported: ${bad.map((f) => f.name).join(", ")}`);
    for (const f of arr.filter((f) => _OBJ_UPLOAD_RE.test(f.name))) {
      if (!pending.some((p) => p.name === f.name && p.size === f.size)) pending.push(f);
    }
    renderFiles();
  };
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  zone.addEventListener("dragover",  (e) => { e.preventDefault(); zone.classList.add("dz-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dz-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dz-over");
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => {
    if (input.files.length) addFiles(input.files);
    input.value = "";
  });
  fileEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".obj-uz-file-rm");
    if (!btn) return;
    pending.splice(+btn.dataset.i, 1);
    renderFiles();
  });

  // ── project autocomplete — existing project names; a name not in the
  // list is left as-is and creates a new project on upload. ──
  const projNames = [...new Set(STATE.projects.rows.map((p) => p.name).filter(Boolean))].sort();
  const showSuggestions = () => {
    const q = proj.value.trim().toLowerCase();
    const matches = q ? projNames.filter((n) => n.toLowerCase().includes(q)) : projNames;
    if (!matches.length) { menu.innerHTML = ""; menu.classList.remove("open"); return; }
    menu.innerHTML = matches.map((n) =>
      `<div class="rp-rt-fb-dd-item" data-name="${esc(n)}">${esc(n)}</div>`).join("");
    menu.classList.add("open");
  };
  proj.addEventListener("input", showSuggestions);
  proj.addEventListener("focus", showSuggestions);
  menu.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".rp-rt-fb-dd-item");
    if (!item) return;
    e.preventDefault();                       // keep focus on the input
    proj.value = item.dataset.name;
    menu.classList.remove("open");
  });
  body.addEventListener("click", (e) => {
    if (!e.target.closest(".obj-uz-field")) menu.classList.remove("open");
  });

  openModal({
    title: "Upload files",
    body,
    actions: [
      { label: "Cancel", variant: "ghost",   onClick: ({ close }) => close() },
      { label: "Upload", variant: "primary", onClick: ({ close }) => doUpload(close) },
    ],
  });

  async function doUpload(close) {
    if (!pending.length) { toast.error("Add at least one file."); return; }
    const projectName = proj.value.trim();
    if (!projectName) { toast.error("Pick or name a project."); proj.focus(); return; }
    close();
    let ok = 0;
    for (const f of pending) {
      const form = new FormData();
      form.append("file", f);
      form.append("project_name", projectName);
      toast.info(`Uploading ${f.name}…`);
      try {
        await api.post("/files/upload", form);
        ok++;
        toast.success(`${f.name} ready.`);
      } catch (err) {
        toast.error(`Upload failed: ${f.name} — ${err.body?.error ?? err.message}`);
      }
    }
    if (!ok) return;
    // Refresh the projects cache (the files schema resolves project
    // names from it) and re-render the active tab so the new rows show.
    try {
      const res = await SCHEMAS.projects.fetch();
      STATE.projects.rows = res.items ?? [];
    } catch { /* non-fatal — the Project column falls back to a RID slice */ }
    await loadTable(currentKind);
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
// Date renderer — honours the module-wide `dateFmt` toolbar setting.
// Mirrors the demo's s2FmtDate: relative ("3h ago") falls through to a
// full date once the value is more than a week old.
const _MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  if (dateFmt === "relative") {
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 24)  return `${hrs}h ago`;
    if (hrs < 48)  return "Yesterday";
    const days = Math.floor(diff / 86400000);
    if (days < 7)  return `${days}d ago`;
    // older → fall through to a full date
  }
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = _MONTHS[d.getMonth()];
  const yr = d.getFullYear();
  if (dateFmt === "date") return `${dd} ${mo} ${yr}`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dd} ${mo} ${yr}, ${hh}:${mm}`;
}
function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024)         return `${n} B`;
  if (n < 1024 * 1024)  return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
// Files schema renders the parent project's name — looked up from the
// projects cache (prefetched in mount even when landing on another tab).
function projectName(projectRid) {
  if (!projectRid) return "—";
  const p = STATE.projects.rows.find((x) => x.redpash_id === projectRid);
  return p?.name ?? projectRid.slice(0, 8);
}
