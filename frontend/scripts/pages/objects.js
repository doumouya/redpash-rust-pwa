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
import { pagerMarkup } from "/scripts/ui/pager.js";
import { OBJECT_TAB_KEYS, normalizeObjectTabs }
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
    // path is the GET endpoint for SWR (api.getCached). Used by both
    // loadTable + _objLoadAndPaint for cache-then-correct paints, and
    // by the post-mutation prefetch sites which write through .fresh
    // to keep the cache warm. Phase 1 A — docs/frontend/suggestion-localstorage.md.
    path:     "/projects",
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
      // Status is derived: opened in the cleaner = Active, archived =
      // Archived, anything else = Draft. The inline edit collapses to
      // a single archive toggle (Archive / Unarchive) — picking
      // Active or Draft manually would conflict with the derived
      // semantic and confuse the user. "Unarchive" writes the raw
      // status back to "draft" (the neutral baseline), so the
      // derivation re-takes over.
      { key: "status",      label: "Status",      render: (r) => _objBadge(_objDerivedStatus(r)),
        edit: { type: "enum", field: "status",
                options: [["archived","Archive"],["draft","Unarchive"]] } },
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
    path:     "/files",
    columns:  [
      // edit:text — dblclick the File cell in edit mode → inline rename
      // (PATCH display_name via the schema's saveEdit below). Anchor
      // links to the file's cleaner; CSS disables its pointer events
      // when the panel is in rp-rt-mode-edit so dblclick falls through.
      { key: "filename",   label: "File",
        render: (r) => `<a class="obj-cell-link" href="#/cleaner?file=${esc(r.redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.display_name ?? r.filename)}</a>`,
        edit: { type: "text", field: "display_name" } },
      // Project — edit:select (source:"projects") moves the file to
      // another of the owner's projects (PATCH project_redpash_id).
      // Anchor links to that project's cleaner; same edit-mode
      // pointer-events caveat applies.
      { key: "project",    label: "Project",
        render: (r) => `<a class="obj-cell-link" href="#/cleaner?project=${esc(r.project_redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(projectName(r.project_redpash_id))}</a>`,
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
      // IDs render as monospaced anchors (same destinations as Project /
      // File columns above). Hidden by default; opted into via the
      // Columns dropdown.
      { key: "project_redpash_id", label: "Project ID", hidden: true,
        render: (r) => `<a class="obj-cell-link obj-cell-id" href="#/cleaner?project=${esc(r.project_redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.project_redpash_id)}</a>` },
      { key: "redpash_id",         label: "File ID",    hidden: true,
        render: (r) => `<a class="obj-cell-link obj-cell-id" href="#/cleaner?file=${esc(r.redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.redpash_id)}</a>` },
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
    path:     "/reports",
    columns:  [
      // Title renders as an anchor to the report — matches the
      // projects/files `name` pattern. The sandbox row painter wires
      // the <tr> to objectsToggleRowSel (select/delete only — no nav
      // branch), so without an anchor cell the row has nothing to
      // click. target=_blank + stopPropagation mirror the projects
      // Name cell. edit:open still works — dblclick in edit mode opens
      // the builder; the anchor only intercepts single click.
      { key: "title",       label: "Title",
        render: (r) => `<a class="obj-cell-link" href="#/reports?id=${esc(r.redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.title)}</a>`,
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
    path:     "/dashboards",
    columns:  [
      // Title renders as an anchor to the dashboard — same pattern as
      // the Reports tab + the projects/files Name cell. Without the
      // anchor the row has nothing clickable (the sandbox <tr> handler
      // covers select/delete modes only). dblclick still opens the
      // builder via edit:open.
      { key: "title",       label: "Title",
        render: (r) => `<a class="obj-cell-link" href="#/dashboards?id=${esc(r.redpash_id)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(r.title)}</a>`,
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
    path:     "/companies",
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
    path:     "/users",
    columns:  [
      // display_name / username / email / plan are inline-editable via
      // PATCH /api/users/:rid (sparse). username carries a UNIQUE
      // constraint — collisions surface as a 409 with kind:"username_taken".
      { key: "display_name", label: "Name",     render: (r) => esc(r.display_name),
        edit: { type: "text", field: "display_name" } },
      { key: "first_name",   label: "First name", render: (r) => _objNullable(r.first_name),
        edit: { type: "text", field: "first_name" } },
      { key: "last_name",    label: "Last name",  render: (r) => _objNullable(r.last_name),
        edit: { type: "text", field: "last_name" } },
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

// Mirror of prefs.cleaner_open_projects — the user's open project tabs
// in the cleaner. Drives the Projects-tab Status column's derived
// badge ("Active" = open in cleaner, "Draft" = not, "Archived" =
// honored verbatim). Set on mount; refreshed only on next mount /
// page reload (the cleaner is the source of truth for the open set).
let objOpenProjects = new Set();
function _objDerivedStatus(row) {
  // Archived wins — the user just picked Archive in the inline editor;
  // showing "Active" because the project happens to be open in the
  // cleaner would look like the change didn't persist. Raw status
  // (the DB value) is the source of truth when it's archived; "active"
  // is only derived when raw is neither archived nor anything else
  // explicit.
  const raw = String(row?.status ?? "").toLowerCase();
  if (raw === "archived") return "archived";
  if (objOpenProjects.has(row?.redpash_id)) return "active";
  return "draft";
}

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
  // Sandbox path doesn't populate STATE[kind].filtered (that's a legacy
  // renderTable side-effect that runs the search/predicate sort+slice);
  // its initial value from freshState() is `[]` (a truthy-but-empty
  // array), so `??` falls through to it. Pick whichever array has
  // content: filtered when the legacy path filled it, rows otherwise.
  // Sandbox search filter wiring is a future pass.
  const st = STATE[kind] || {};
  const rows = (st.filtered && st.filtered.length)
    ? st.filtered
    : (st.rows || []);
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
  //
  // Computed BEFORE rpInclude so we can seed window.spObjectTabs (the
  // sandbox tab-strip state in controls.js) up front: include.js
  // synchronously calls spInit during the walk, which paints the
  // strip from spObjectTabs. Without the early seed, spInit reads
  // stale localStorage and the user sees a flash of the wrong order
  // before our mount handler overrides it.
  objTabs = normalizeObjectTabs(ctx?.session?.prefs?.objects_tabs);
  window.spObjectTabs = [...objTabs];
  // Tell controls.js the sandbox strip is now prefs-driven so spInit's
  // _spLoadObjectTabs skips its localStorage fallback. Without this
  // flag, the include walk would clobber the seed above with a stale
  // localStorage read before our spActivateObjectType call repaints.
  window.spObjectTabsFromPrefs = true;

  // Prerelease (Phase 1): /partials/objects.html is now a thin shell
  // that data-includes the sandbox subtree at /partials/objects/index.html.
  // The router's partial-swap doesn't recurse into data-include nodes;
  // include.js exposes the walker as window.rpInclude. Without this,
  // the page renders empty (the shell loads but its children never do).
  // Mirrors the same call inside cleaner.js mount().
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[objects] rpInclude failed", err); }
  }

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

  // Mirror cleaner_open_projects so the Projects-tab Status column can
  // derive its badge from "opened in the cleaner" (= Active) rather
  // than the stored draft/active/archived field. Refreshed only at
  // mount — the cleaner page owns this pref's writes.
  const open = ctx?.session?.prefs?.cleaner_open_projects;
  objOpenProjects = new Set(Array.isArray(open) ? open : []);

  // ── Sandbox detection — Phase 2 state wiring ─────────────────────
  // Sandbox partial emits per-type wrappers ([data-object-type]); the
  // legacy partial doesn't. When the sandbox markup is on screen, the
  // legacy renderTable's selectors ([data-rt-tbody], [data-rt-thead])
  // miss → silent no-op + the hardcoded demo rows stay visible. Branch
  // to mountObjectsSandbox before _wireGlobals so we don't install
  // legacy handlers that target dead DOM. See
  // docs/frontend/sandbox-integration.md for the cleaner playbook
  // mirrored here.
  if (root.querySelector("[data-object-type]")) {
    await mountObjectsSandbox(root, ctx);
    return;
  }

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
  // RID slice, which is acceptable.) Uses getCached so cached values
  // satisfy the lookup synchronously while fresh runs in parallel.
  if (start !== "projects" && objTabs.includes("projects")) {
    const { cached, fresh } = api.getCached(SCHEMAS.projects.path);
    if (cached?.items) STATE.projects.rows = cached.items;
    try {
      const res = await fresh;
      STATE.projects.rows = res.items ?? [];
    } catch { /* non-fatal — the column falls back to a RID slice */ }
  }
  await objActivateTab(start);

  // Tier 2 E — pre-warm every OTHER schema's list so switching tabs
  // hits cache instantly. The active tab + the projects fallback both
  // ran above; everything else is fair game.
  const prewarmKinds = Object.keys(SCHEMAS)
    .filter((k) => k !== start && k !== "projects");
  if (prewarmKinds.length) {
    api.prewarm(prewarmKinds.map((k) => SCHEMAS[k].path));
  }
}

// ── Tabs ───────────────────────────────────────────────────────────
// The object-type tab strip is rendered by controls.js (spRenderObjectTabs),
// which writes the sandbox .rp-rt-proj-tab markup. _renderTabs just delegates.
function _renderTabs(root) {
  window.spRenderObjectTabs?.(root);
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

    // Re-render the strip so the active highlight moves to this kind.
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
        if (ok) {
          toast.success("Created.");
          // Refresh via the appropriate path. Sandbox mount uses
          // _objLoadAndPaint (per-type tbody host); legacy uses
          // loadTable (.rp-rt-panel [data-rt-tbody]). Both call into
          // SCHEMAS[kind].path through getCached.fresh, so the cache
          // gets warmed either way.
          if (typeof _objLoadAndPaint === "function") {
            await _objLoadAndPaint(currentKind);
          } else if (typeof loadTable === "function") {
            await loadTable(currentKind);
          }
        }
      } catch (err) {
        toast.error(`Create failed: ${err.body?.error ?? err.message}`);
      }
      return;
    }
    if (schema.addHref) { location.hash = schema.addHref; return; }
    _objOpenUploadModal();
  };

  // Close toolbar dropdowns (pill + cols) and the filter dropdowns on
  // outside click. Guarded so re-mounts don't stack listeners.
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

  // SWR (Phase 1 A) — paint from cache instantly if available, then
  // await fresh for the correction pass. Only show "Loading…" on a
  // cold cache so warm-cache paths don't flash.
  const { cached, fresh } = api.getCached(schema.path);
  if (cached?.items) {
    STATE[kind].rows = cached.items;
    if (kind === currentKind) renderTable(kind);
  } else if (tbody) {
    tbody.innerHTML = `<tr><td style="text-align:center;color:var(--muted);padding:1rem">Loading…</td></tr>`;
  }
  try {
    const res = await fresh;
    STATE[kind].rows = res.items ?? [];
  } catch (err) {
    if (!cached) {
      STATE[kind].rows = [];
      if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;color:var(--red);padding:1rem">${esc(err.body?.error ?? err.message)}</td></tr>`;
      return;
    }
    // else: keep the cached paint; correction will retry on next mount.
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
  // Prerelease (Phase 1): sandbox markup uses per-type table-wraps with
  // plain <tbody> (no data-rt-tbody hook) and sample rows. Live's
  // renderTable can't find its target — bail so the sandbox samples
  // stay visible. Real-data wiring will replace tbody contents per kind
  // via the data-objects-table="<kind>" hook in the table partials.
  if (!tbody) return;
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
//
// Since mig 011, `project_files.filename` already stores the stem (no
// extension); `file_type` owns the extension. No client-side strip
// needed — display sites read display_name / filename as-is.
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
    // Goes through getCached.fresh so the localStorage cache is rewritten
    // — next mount's SWR paint sees the post-mutation state.
    try {
      const res = await api.getCached(SCHEMAS.projects.path).fresh;
      STATE.projects.rows = res.items ?? [];
    } catch { /* non-fatal — the Project column falls back to a RID slice */ }
    // Refresh via the appropriate path. Sandbox mount uses
    // _objLoadAndPaint (per-type tbody host); legacy uses loadTable
    // (.rp-rt-panel [data-rt-tbody]). Previously this only called
    // loadTable, so sandbox users had to manually refresh after
    // uploading.
    if (typeof _objLoadAndPaint === "function") {
      await _objLoadAndPaint(currentKind);
    } else if (typeof loadTable === "function") {
      await loadTable(currentKind);
    }
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

// ── Phase 2 wiring — sandbox markup ↔ real backend ───────────────────
// Mirrors cleaner.js's mountSandbox + _installSandboxLiveHandlers +
// _paintSandboxTable trio. Active when the prerelease objects shell
// (/partials/objects.html → data-include tree under /partials/objects/)
// is on screen. See docs/frontend/sandbox-integration.md for the
// shared discipline (composite onclicks, STATE mirror, dataset-key
// isolation, once-guarded document listeners).
//
// What V0 does:
//   1. Detect currentKind from URL ?tab=, else first user-pref tab.
//   2. spActivateObjectType(kind) — sandbox swaps the visible
//      [data-object-type] wrapper.
//   3. loadTable(kind) — existing legacy fetcher; populates
//      STATE[kind].rows.
//   4. paintObjectsSandboxTable(kind) — writes tbody from STATE rows
//      into [data-objects-table="kind"] (sandbox's per-type render hook).
//   5. Doc listener on .rp-rt-proj-tab clicks → load+paint the new kind
//      (the sandbox's spActivateObjectType swap fires in parallel; live
//      half adds real data once the fetch resolves).
//
// What's deferred to next rounds (mirror the cleaner pass order):
//   - Sort chain, search input, filter panel
//   - Row selection + bulk delete (drop_rows-style endpoint per kind)
//   - Inline edit (dblclick → PATCH)
//   - Tab × close + picker → spAddObjectTab composite
//   - Pagination buttons
async function mountObjectsSandbox(root, ctx) {
  _installObjectsLiveHandlers(root);

  // Bridge Objects → Profile/Settings: when the user drags / removes /
  // adds a tab inside the Objects page strip, controls.js calls
  // _spSaveObjectTabs which routes through rpSavePref (so the change
  // reaches the backend + session.prefs) AND fires this callback so
  // our `objTabs` module reference stays aligned with spObjectTabs.
  // Without the callback, subsequent objTabs.includes(...) checks
  // inside this page would read a stale array.
  //
  // The reverse direction (Settings → Objects strip) is wired earlier
  // in mount() by seeding spObjectTabs from objTabs BEFORE rpInclude
  // runs, since spInit fires inside the include walk.
  window.objOnTabsChanged = (newTabs) => {
    if (!Array.isArray(newTabs)) return;
    objTabs.length = 0;
    objTabs.push(...newTabs);
  };

  // Clear sandbox demo rows from EVERY per-type tbody on mount so the
  // user never sees hardcoded "raw_dossier_500_sentinels.csv" demo data
  // sitting in the table after switching to an un-loaded tab. Replaced
  // by a loading placeholder; paintObjectsSandboxTable fills it in
  // when the kind is activated.
  root.querySelectorAll("[data-objects-table] tbody").forEach((tb) => {
    tb.innerHTML = '<tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic" colspan="99">Loading…</td></tr>';
  });

  // Determine active kind — URL ?tab= wins, else first user-pref tab,
  // else "projects" as a last-ditch fallback.
  const q   = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const tab = q.get("tab");
  const kind = (objTabs.includes(tab) && tab)
    || objTabs[0]
    || "projects";

  // Projects cache is needed by the files schema's Project column.
  // Prefetch it even when we're landing elsewhere — non-fatal on error.
  if (kind !== "projects" && objTabs.includes("projects")) {
    try {
      const res = await SCHEMAS.projects.fetch();
      STATE.projects.rows = res.items ?? [];
    } catch { /* projects column falls back to a rid slice */ }
  }

  // Trigger the sandbox visibility swap (sets `hidden` on every
  // [data-object-type] wrapper except `kind`). Then load+paint.
  if (typeof window.spActivateObjectType === "function") {
    window.spActivateObjectType(kind);
  }
  currentKind = kind;
  try { history.replaceState(null, "", `#/objects?tab=${kind}`); } catch {}
  // Populate the columns picker for the initial kind — objectsActivateKind
  // does this on subsequent switches, but the first mount goes straight
  // to _objLoadAndPaint without firing objectsActivateKind.
  if (typeof window.objectsBuildColsDropdown === "function") {
    window.objectsBuildColsDropdown(kind);
  }
  // Filter panel — paint one empty predicate row with the active
  // kind's column dropdown options. Same reasoning as the cols picker
  // above: first mount skips objectsActivateKind.
  if (typeof window.objectsBuildFilterPanel === "function") {
    window.objectsBuildFilterPanel(kind);
  }
  await _objLoadAndPaint(kind);
}

// Install window.objects* handlers + a doc-level listener for type-tab
// clicks. Once-guarded so re-mount on hash change doesn't stack
// listeners (mountObjectsSandbox runs every time the route fires).
function _installObjectsLiveHandlers(root) {
  // Public handler — drop straight into onclicks once tabs use a
  // composite (spActivateObjectType + objectsActivateKind). Also
  // reusable from the doc listener below.
  window.objectsActivateKind = async (kind) => {
    if (!kind || kind === currentKind) return;
    if (typeof window.spActivateObjectType === "function") {
      window.spActivateObjectType(kind);
    }
    currentKind = kind;
    try { history.replaceState(null, "", `#/objects?tab=${kind}`); } catch {}

    // Tab-isolation reset — the toolbar (search input, mode buttons,
    // selection chip) lives on the shared `.rp-rt-panel`, so without
    // this every tab switch carried the previous tab's state into the
    // new view (edit-mode chrome on every row, stale search value,
    // selection count from another kind). Legacy `objActivateTab`
    // does the equivalent reset at line ~942; this is the sandbox
    // mirror.
    //
    // STATE[kind] keeps its own per-tab slice (rows, sorts, page,
    // pageSize) — we ONLY reset the volatile toolbar bits (search,
    // mode, selection). Saved-view restores happen elsewhere.
    const st = STATE[kind];
    if (st) {
      st.search = "";
      st.mode   = null;
      if (st.selected instanceof Set) st.selected.clear();
    }
    const panel = root.querySelector(".rp-rt-panel");
    if (panel) {
      panel.dataset.rt = kind;
      // Mode classes — sandbox uses `is-mode-*` (controls.js spSetMode),
      // legacy uses `rp-rt-mode-*`. Drop both so neither sticks.
      panel.classList.remove(
        "is-mode-edit", "is-mode-select", "is-mode-delete",
        "rp-rt-mode-edit", "rp-rt-mode-select", "rp-rt-mode-delete",
      );
      panel.querySelectorAll("[data-sp-mode], .rp-rt-icon-btn[data-rt-mode]").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
      const search = panel.querySelector(".rp-rt-search");
      if (search) {
        search.value = "";
        search.placeholder = `Search ${kind}…`;
      }
      const chip = panel.querySelector(".rp-rt-sel-chip");
      if (chip) {
        chip.setAttribute("data-count", "0");
        chip.innerHTML = '<i class="bi bi-check2-square"></i> 0 selected';
      }
      // Rows-per-page — the dropdown label + is-selected item both
      // live on the shared toolbar, so without resetting them every
      // tab switch carried the previous kind's number forward.
      // Saved-view per-kind value wins (objSave persists rowsPerPage
      // per tab); falls back to the 25 default. Sandbox uses
      // [data-sp-rows-label] + .rp-dd-item.is-selected (legacy uses
      // [data-rt-rows-label] + .rp-rt-dd-selected — different
      // conventions, only the sandbox path runs here).
      const rowsLbl = panel.querySelector("[data-sp-rows-label]");
      if (rowsLbl && st) {
        const rpp = OBJ_ROWS_OPTS.includes(objViews[kind]?.rowsPerPage)
          ? objViews[kind].rowsPerPage
          : 25;
        st.rowsPerPage = rpp;
        rowsLbl.textContent = String(rpp);
        rowsLbl.closest(".rp-dd-wrap")
          ?.querySelectorAll(".rp-dd-item")
          .forEach((i) => i.classList.toggle("is-selected",
            i.textContent.trim() === `${rpp} rows`));
      }
      // Date format — saved per-tab via objSave's `dateFmt` field;
      // a saved value wins, else the module-global `dateFmt` (last
      // explicit user choice) carries over. Mirrors the rows-per-
      // page block above for consistency.
      const savedFmt = objViews[kind]?.dateFmt;
      if (savedFmt && _DATE_FMT_LABEL[savedFmt]) dateFmt = savedFmt;
      const dfLabel = panel.querySelector("[data-sp-datefmt-label]");
      if (dfLabel) {
        dfLabel.textContent = _DATE_FMT_LABEL[dateFmt];
        dfLabel.closest(".rp-dd-wrap")
          ?.querySelectorAll(".rp-dd-item")
          .forEach((i) => i.classList.toggle("is-selected",
            i.textContent.trim() === _DATE_FMT_LABEL[dateFmt]));
      }
      // Columns picker — rebuild the dropdown items from the new
      // schema. _ensureColState seeds STATE[kind].colOrder + .visibleCols
      // from objViews if a saved view exists, else from schema defaults.
      // Called eagerly so the next dropdown open reads the right list;
      // also re-fired on every spDdToggle of the Columns button for
      // late-loaded saved views.
      if (typeof window.objectsBuildColsDropdown === "function") {
        window.objectsBuildColsDropdown(kind);
      }
      // Filter — reset on tab switch (columns differ per kind, so
      // stale predicates would point at columns the new tab doesn't
      // have). objectsClearFilter wipes objPredicates + objCombinator
      // AND repaints the panel rows; we built it inside the same
      // path so the dropdown options are kind-correct on entry.
      if (typeof window.objectsClearFilter === "function") {
        window.objectsClearFilter();
      } else if (typeof window.objectsBuildFilterPanel === "function") {
        window.objectsBuildFilterPanel(kind);
      }
    }

    await _objLoadAndPaint(kind);
  };

  // Expose the active kind for inline onclick handlers that need to
  // pass it without re-reading currentKind directly (currentKind is
  // module-private). Used by the toolbar Columns button's composite
  // onclick to rebuild the dropdown on every open.
  window.objectsActiveKind = () => currentKind;

  // ── Filter panel (sandbox) ────────────────────────────────────────
  //
  // Reuses the legacy predicate engine (objPredicates / objCombinator
  // module state, _objRowMatchesFilter / _objEvalPredicate / _objColValue
  // helpers, OBJ_FILTER_OPS catalog). Sandbox-specific bits are the
  // panel selectors ([data-objects-filter-rows], [data-objects-filter-combo])
  // and the repaint target (paintObjectsSandboxTable instead of
  // legacy renderTable).
  //
  // One <select> per dropdown for now — native pulldown, kind-aware
  // options. The legacy panel uses custom button+menu dropdowns
  // (_objFbDropdown) for styling parity with the toolbar pills; the
  // sandbox stays on native selects for simplicity. Same data-fb-*
  // attribute contract so objectsApplyFilter reads identically.

  // Picker for the column / op .rp-dd-wrap dropdowns. Mirrors cleaner's
  // cleanerFbDdPick: writes the picked value to the wrap's data-value,
  // updates the label, marks the chosen item is-selected, closes the
  // menu. objectsApplyFilter reads wrap.dataset.value at apply-time.
  window.objectsFbDdPick = (item) => {
    if (!item) return;
    const wrap = item.closest(".rp-dd-wrap");
    if (!wrap) return;
    const value = item.dataset.value ?? "";
    wrap.dataset.value = value;
    const lbl = wrap.querySelector("[data-dd-lbl]");
    if (lbl) {
      const isCol = wrap.classList.contains("rp-rt-fb-col");
      lbl.textContent = value ? item.textContent.trim() : (isCol ? "Column…" : "Op…");
    }
    wrap.querySelectorAll(".rp-dd-item.is-selected").forEach((it) => it.classList.remove("is-selected"));
    if (value) item.classList.add("is-selected");
    wrap.querySelector(".rp-dd-menu")?.classList.remove("open");
    // If we just picked an op, sync the value input's type / placeholder
    // via the legacy row-changed helper (writes a hidden input on the
    // wrap so _objFilterRowChanged's "find data-fb-op" lookup still works).
    if (wrap.classList.contains("rp-rt-fb-op")) {
      const row = wrap.closest(".rp-rt-fb-row");
      const inp = row?.querySelector("[data-fb-val]");
      if (inp && typeof _objFilterRowChanged === "function") _objFilterRowChanged(inp);
    }
  };

  // Build a single predicate row matching cleaner's sandbox markup —
  // .rp-dd-wrap dropdowns (button + .rp-dd-menu popup) opened via
  // spDdToggle, items emit onclick="objectsFbDdPick(this)". Wraps
  // carry data-fb-col / data-fb-op (the read-by selector) + data-value
  // (the picked value). objectsApplyFilter reads wrap.dataset.value
  // instead of a hidden input.
  //
  // Value input wrapped in .rp-rt-fb-val-wrap with a sibling
  // [data-fb-val-menu] for the per-column distinct-values autocomplete
  // (legacy _objShowValSuggestions handles the menu paint).
  const _objectsFilterRowHtml = (kind, idx) => {
    const cols = SCHEMAS[kind]?.columns ?? [];
    const colItems = cols.map((c) =>
      `<div class="rp-dd-item" data-value="${esc(c.key)}" onclick="objectsFbDdPick(this)">${esc(c.label)}</div>`).join("");
    const opItems = OBJ_FILTER_OPS.map(([v, l]) =>
      `<div class="rp-dd-item" data-value="${esc(v)}" onclick="objectsFbDdPick(this)">${esc(l)}</div>`).join("");
    return `<div class="rp-rt-fb-row" data-objects-filter-idx="${idx}">`
      + `<button class="rp-rt-fb-rm" title="Remove predicate"`
      + ` onclick="event.stopPropagation();objectsRemovePredicate(this)">`
      + `<i class="bi bi-x"></i></button>`
      + `<div class="rp-dd-wrap rp-rt-fb-col" data-fb-col data-value="">`
      +   `<button type="button" class="rp-rt-fb-dd-btn" onclick="spDdToggle(this)">`
      +     `<span data-dd-lbl>Column…</span>`
      +     `<i class="bi bi-chevron-down"></i>`
      +   `</button>`
      +   `<div class="rp-dd-menu" role="menu">${colItems}</div>`
      + `</div>`
      + `<div class="rp-rt-fb-selects">`
      +   `<div class="rp-dd-wrap rp-rt-fb-op" data-fb-op data-value="">`
      +     `<button type="button" class="rp-rt-fb-dd-btn" onclick="spDdToggle(this)">`
      +       `<span data-dd-lbl>Op…</span>`
      +       `<i class="bi bi-chevron-down"></i>`
      +     `</button>`
      +     `<div class="rp-dd-menu" role="menu">${opItems}</div>`
      +   `</div>`
      +   `<div class="rp-rt-fb-val-wrap">`
      +     `<input type="text" class="rp-rt-fb-val" data-fb-val placeholder="value"`
      +     ` oninput="_objFbValInput(this)" onfocus="_objFbValInput(this)" />`
      +     `<div class="rp-rt-fb-dd-menu" data-fb-val-menu></div>`
      +   `</div>`
      + `</div>`
      + `</div>`;
  };

  // Paint a single empty predicate row into the panel — called on
  // initial mount + every tab switch (columns differ per kind, so
  // stale dropdown options would mismatch).
  window.objectsBuildFilterPanel = (kind) => {
    kind = kind || currentKind;
    if (!kind || !SCHEMAS[kind]) return;
    const host = root.querySelector("[data-objects-filter-rows]");
    if (!host) return;
    host.innerHTML = _objectsFilterRowHtml(kind, 0);
  };

  window.objectsAddPredicate = () => {
    const host = root.querySelector("[data-objects-filter-rows]");
    if (!host || !currentKind) return;
    const idx = host.querySelectorAll(".rp-rt-fb-row").length;
    host.insertAdjacentHTML("beforeend", _objectsFilterRowHtml(currentKind, idx));
  };

  window.objectsRemovePredicate = (btn) => {
    const row = btn?.closest(".rp-rt-fb-row");
    if (!row) return;
    row.remove();
    // Keep at least one empty row so the panel never collapses to "no
    // predicates"; the user can clear via the eraser button instead.
    const host = root.querySelector("[data-objects-filter-rows]");
    if (host && !host.querySelector(".rp-rt-fb-row")) {
      host.insertAdjacentHTML("beforeend", _objectsFilterRowHtml(currentKind, 0));
    }
  };

  window.objectsSetFilterCombo = (btn) => {
    const wrap = btn?.closest("[data-objects-filter-combo]");
    if (!wrap) return;
    wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b === btn));
  };

  // Read predicates from the panel + apply. Mirrors legacy objApplyFilter
  // (line ~2525) but reads from the sandbox panel selectors and repaints
  // via paintObjectsSandboxTable. Honours every op in OBJ_FILTER_OPS
  // (eq, neq, contains, in, gt/lte, between, before/after, is_null,
  // not_null, etc.) through the shared _objEvalPredicate helper.
  window.objectsApplyFilter = () => {
    if (!currentKind) return;
    const host = root.querySelector("[data-objects-filter-rows]");
    const rows = host ? [...host.querySelectorAll(".rp-rt-fb-row")] : [];
    const comboBtn = root.querySelector("[data-objects-filter-combo] button.is-active");
    objCombinator = comboBtn?.dataset.combo === "or" ? "or" : "and";
    const preds = [];
    rows.forEach((r) => {
      // .rp-dd-wrap carries the picked value in data-value (cleaner-
      // sandbox convention); fall back to a child input.value for
      // anything that's still a native <select>/<input> (shouldn't
      // happen now but cheap belt-and-suspenders).
      const colWrap = r.querySelector("[data-fb-col]");
      const opWrap  = r.querySelector("[data-fb-op]");
      const column  = colWrap?.dataset?.value ?? colWrap?.value ?? "";
      const op      = opWrap?.dataset?.value  ?? opWrap?.value  ?? "";
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
    paintObjectsSandboxTable(currentKind);
    _paintObjectsSandboxMeta(currentKind);
  };

  // Topbar "Open Cleaner" button — routes to the user's most-recently-
  // updated project so the cleaner mounts on real data instead of a
  // blank "needs ?project=… or ?file=…" toast. Reads STATE.projects.rows
  // (mountObjectsSandbox always prefetches /projects via getCached,
  // so this is populated regardless of which kind-tab is active);
  // falls back to bare #/cleaner if the list is truly empty (new
  // account, no uploads yet).
  //
  // Sort is defensive — backend's list_projects orders by updated_at
  // DESC, but a copy + re-sort is cheap and keeps the right answer if
  // that ever changes.
  window.objectsOpenCleaner = () => {
    const rows = (STATE.projects?.rows || []).slice();
    rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    const top = rows[0];
    if (top?.redpash_id) {
      location.hash = `#/cleaner?project=${encodeURIComponent(top.redpash_id)}`;
    } else {
      location.hash = "#/cleaner";
    }
  };

  // Toolbar refresh button — companion to sandbox spRefresh. spRefresh
  // adds .is-refreshing for a 600ms one-shot spin; this fires the
  // actual /list refetch via getCached.fresh (rewrites the localStorage
  // cache so the next mount paints the post-refresh state) and routes
  // through _objLoadAndPaint so the table repaints. Uses .is-spinning
  // (infinite) for the duration of the work + a 600ms minimum so
  // a snappy localhost fetch still feels like a refresh, not a flash.
  window.objectsRefresh = async (btn) => {
    if (!currentKind) return;
    btn?.classList.add("is-spinning");
    const schema = SCHEMAS[currentKind];
    const minSpin = new Promise((r) => setTimeout(r, 600));
    try {
      // Force a fresh fetch (write-through) + repaint. _objLoadAndPaint
      // reads getCached.fresh internally, which always hits the
      // network, so this is a real round-trip not a cache replay.
      const work = schema?.path
        ? api.getCached(schema.path).fresh.then(() => _objLoadAndPaint(currentKind))
        : _objLoadAndPaint(currentKind);
      await Promise.all([work, minSpin]);
    } catch (err) {
      window.toast?.error?.(`Refresh failed: ${err.body?.error ?? err.message}`);
    } finally {
      btn?.classList.remove("is-spinning");
    }
  };

  // Toolbar search — mirrors the legacy `objSearch` (line ~1125) but
  // repaints via paintObjectsSandboxTable and ALSO paints an
  // autocomplete menu of distinct values from the kind's "primary"
  // column (schema.columns[0]) matching the typed query. Same UX as
  // the predicate value input's suggestion popover.
  //
  // STATE[currentKind].search drives the row filter through
  // _objMatchesSearch (already kind-agnostic). Tab switch clears it
  // via objectsActivateKind (the per-tab reset block above).
  window.objectsSearchInput = (inp) => {
    if (!inp || !currentKind) return;
    const q = String(inp.value || "").toLowerCase().trim();
    const st = STATE[currentKind];
    if (st) st.search = q;
    // Repaint with the new search applied.
    paintObjectsSandboxTable(currentKind);
    _paintObjectsSandboxMeta(currentKind);
    // Suggestion menu — distinct values from the kind's first column
    // (Name / File / Title / etc.) that match the query. Same shape
    // as _objShowValSuggestions for predicate values.
    const menu = root.querySelector("[data-objects-search-menu]");
    if (!menu) return;
    const cols = SCHEMAS[currentKind]?.columns ?? [];
    const primaryKey = cols[0]?.key;
    if (!primaryKey) { menu.classList.remove("open"); return; }
    const seen = new Set();
    for (const r of (st?.rows ?? [])) {
      const v = _objColValue(currentKind, primaryKey, r);
      if (v == null || v === "") continue;
      seen.add(String(v));
      if (seen.size >= 50) break;
    }
    const all = [...seen].sort();
    const matches = q ? all.filter((v) => v.toLowerCase().includes(q)) : all;
    if (!matches.length) { menu.classList.remove("open"); return; }
    menu.innerHTML = matches.map((v) =>
      `<div class="rp-rt-fb-dd-item" onmousedown="event.preventDefault();objectsSearchPick(this)">${esc(v)}</div>`
    ).join("");
    if (!menu.classList.contains("open")) {
      // Position under the input — same approach as _objFbPositionMenu
      // for the value-suggestion menu.
      const r = inp.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left  = `${r.left}px`;
      menu.style.top   = `${r.bottom + 2}px`;
      menu.style.width = `${r.width}px`;
      menu.classList.add("open");
    }
  };

  window.objectsSearchPick = (item) => {
    const search = root.querySelector(".rp-rt-search");
    const menu   = root.querySelector("[data-objects-search-menu]");
    if (!search) return;
    search.value = item.textContent;
    menu?.classList.remove("open");
    // Re-fire the input handler so the row filter applies + STATE.search
    // syncs to the picked value.
    window.objectsSearchInput(search);
  };

  window.objectsClearFilter = () => {
    objPredicates = [];
    objCombinator = "and";
    if (currentKind) window.objectsBuildFilterPanel(currentKind);
    const wrap = root.querySelector("[data-objects-filter-combo]");
    wrap?.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.combo === "and"));
    if (currentKind) {
      paintObjectsSandboxTable(currentKind);
      _paintObjectsSandboxMeta(currentKind);
    }
  };

  // Outside-click dismissal for the value-suggestion menu (the
  // [data-fb-val-menu] inside .rp-rt-fb-val-wrap). The col/op
  // .rp-dd-menu dropdowns are handled by controls.js's generic
  // .rp-dd-menu.open closer (line ~1888); we just need to cover the
  // legacy val-menu which uses its own positioning. Function-property
  // flag prevents stacking on re-mount.
  if (!_installObjectsLiveHandlers._fbOutsideClickWired) {
    _installObjectsLiveHandlers._fbOutsideClickWired = true;
    document.addEventListener("click", (e) => {
      // Value-suggestion menu (predicate row) — close when click leaves
      // its wrap.
      if (!e.target.closest(".rp-rt-fb-val-wrap")) {
        document.querySelectorAll("[data-fb-val-menu].open")
          .forEach((m) => m.classList.remove("open"));
      }
      // Toolbar search suggestion menu — same logic, different wrap.
      if (!e.target.closest(".rp-rt-search-wrap")) {
        document.querySelectorAll("[data-objects-search-menu].open")
          .forEach((m) => m.classList.remove("open"));
      }
    });
  }

  // Sandbox columns picker — paint .rp-dd-checkbox items into the
  // [data-sp-cols-picker] mount point from SCHEMAS[kind].columns,
  // respecting STATE[kind].visibleCols for the initial check state.
  // Called from objectsActivateKind on tab switch + on every dropdown
  // open (handles late-load saved-view rehydration without re-tracking
  // dirty state).
  window.objectsBuildColsDropdown = (kind) => {
    kind = kind || currentKind;
    if (!kind || !SCHEMAS[kind]) return;
    const host = root.querySelector("[data-sp-cols-picker]");
    if (!host) return;
    _ensureColState(kind);
    const st     = STATE[kind];
    const byKey  = Object.fromEntries(SCHEMAS[kind].columns.map((c) => [c.key, c]));
    host.innerHTML = (st.colOrder || []).map((k) => {
      const col = byKey[k];
      if (!col) return "";
      const checked = st.visibleCols.has(k) ? " checked" : "";
      return `<label class="rp-dd-checkbox">`
           +   `<input type="checkbox" data-sp-col-toggle="${esc(k)}"${checked}`
           +   ` onchange="objectsToggleCol(this)" />`
           +   ` ${esc(col.label)}`
           + `</label>`;
    }).join("");
  };

  // Auto-persist the current tab's full view state to objViews so that
  // every toolbar tweak (columns, rows-per-page, date format, sort)
  // survives a page refresh AND shows up on the Profile/Settings
  // "Saved tab views" list without the user having to click an
  // explicit "Save view" button. Snapshot shape matches what
  // window.objSave writes so the two paths stay interchangeable.
  // rpSavePref writes to prefs.objects_views on the account
  // (fire-and-forget; in-memory session.prefs is updated synchronously).
  const _persistObjView = (kind) => {
    if (!kind || !STATE[kind]) return;
    const st = STATE[kind];
    if (!st.colOrder || !st.visibleCols) return;
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
  };

  // Checkbox change — adds / removes a column from STATE[kind].visibleCols
  // and repaints the table. Min-1 guard: refusing the last visible
  // column would collapse the table; revert the checkbox + toast.
  window.objectsToggleCol = (cb) => {
    const kind = currentKind;
    if (!kind || !cb) return;
    const st  = STATE[kind];
    const key = cb.dataset.spColToggle;
    if (!key) return;
    if (cb.checked) {
      st.visibleCols.add(key);
    } else {
      if (st.visibleCols.size <= 1) {
        cb.checked = true;
        window.toast?.info?.("Keep at least one column visible.");
        return;
      }
      st.visibleCols.delete(key);
    }
    _persistObjView(kind);
    paintObjectsSandboxTable(kind);
  };

  // Reset to schema default — all non-hidden columns visible, schema
  // order. Clears any saved-view override of visibleCols/colOrder.
  // Re-paints the dropdown + table.
  window.objectsResetCols = () => {
    const kind = currentKind;
    if (!kind || !SCHEMAS[kind]) return;
    const cols = SCHEMAS[kind].columns;
    const st   = STATE[kind];
    st.colOrder    = cols.map((c) => c.key);
    st.visibleCols = new Set(cols.filter((c) => !c.hidden).map((c) => c.key));
    _persistObjView(kind);
    window.objectsBuildColsDropdown(kind);
    paintObjectsSandboxTable(kind);
  };

  // Row click in sandbox tables — sandbox spToggleRowSel handles the
  // visual flip (CSS .rp-rt-row-sel class) but doesn't touch
  // STATE[kind].selected. Without that, objBulkDelete sees an empty
  // selection and the master/Delete-mode flows look "visually deleted"
  // but never POST. This companion mirrors the legacy row-click into
  // STATE so the live path has the rids it needs.
  //
  // Reads currentKind + the tr's data-rt-rid. After mutation, repaints
  // the toolbar selection chip count. Idempotent — defensive against
  // stale clicks when STATE[kind] hasn't been seeded.
  // Master checkbox companion. spSelectAllRows handles the visual
  // tick-all-rows + class flip; this mirrors that into STATE[kind].selected
  // so bulk delete + the chip count are in sync.
  window.objectsSelectAllRows = (cb) => {
    if (!cb || !currentKind) return;
    const on = !!cb.checked;
    const st = STATE[currentKind];
    if (!st) return;
    if (!(st.selected instanceof Set)) st.selected = new Set();
    st.selected.clear();
    if (on) {
      root.querySelectorAll(`[data-objects-table="${currentKind}"] tbody tr[data-rt-rid]`)
        .forEach((tr) => {
          const rid = tr.dataset.rtRid;
          if (rid) st.selected.add(rid);
        });
    }
    const chip = root.querySelector(".rp-rt-sel-chip");
    if (chip) {
      const n = st.selected.size;
      chip.setAttribute("data-count", String(n));
      chip.innerHTML = `<i class="bi bi-check2-square"></i> ${n} selected`;
    }
  };

  window.objectsToggleRowSel = (tr) => {
    if (!tr || !currentKind) return;
    const rid = tr.dataset.rtRid;
    if (!rid) return;
    const st = STATE[currentKind];
    if (!st) return;
    if (!(st.selected instanceof Set)) st.selected = new Set();

    const panel  = root.querySelector(".rp-rt-panel");
    const schema = SCHEMAS[currentKind];
    // Delete mode + row click → fire the real backend delete. spDeleteRow
    // ran first via the composite onclick (animated the row out + pushed
    // undo); we follow up with /api DELETE so the row stays gone after
    // refresh. Same path as objBulkDelete but for a single rid.
    //
    // Schema-level guards: canDelete (kind supports delete at all),
    // canDeleteRow (default project / read-only rows can't go).
    if (panel?.classList.contains("is-mode-delete") && schema?.canDelete && schema.deleteOne) {
      if (schema.canDeleteRow) {
        const row = (st.rows || []).find((r) => r.redpash_id === rid);
        if (row && !schema.canDeleteRow(row)) {
          window.toast?.info?.("This row can't be deleted.");
          return;
        }
      }
      st.selected.delete(rid);
      schema.deleteOne(rid)
        .then(() => _objLoadAndPaint(currentKind))
        .catch((err) => {
          window.toast?.error?.(`Delete failed: ${err.body?.error ?? err.message}`);
        });
      return;
    }

    // Select-mode default — mirror spToggleRowSel's visual flip into
    // STATE so the chip count + objBulkDelete read the truth.
    if (tr.classList.contains("rp-rt-row-sel")) st.selected.add(rid);
    else                                         st.selected.delete(rid);
    const chip = root.querySelector(".rp-rt-sel-chip");
    if (chip) {
      const n = st.selected.size;
      chip.setAttribute("data-count", String(n));
      chip.innerHTML = `<i class="bi bi-check2-square"></i> ${n} selected`;
    }
  };

  // Delete-mode toolbar button's live companion. spSetMode handles the
  // visual "animate rows out + push undo" path when in delete mode with
  // a selection; this fires the actual DELETE on the backend, which is
  // what the user expected when they reported "delete comes back at
  // refresh" — previously the visual was a lie.
  //
  // Guards against the no-selection case (toolbar Delete with empty
  // selection is a plain mode-toggle, not an action). objBulkDelete
  // reads STATE[kind].selected which objectsToggleRowSel above keeps
  // in sync, so by the time we get here the rids are real.
  window.objectsMaybeBulkDelete = () => {
    const st = STATE[currentKind];
    if (!st || !(st.selected instanceof Set) || st.selected.size === 0) return;
    if (typeof window.objBulkDelete === "function") {
      // Fire-and-forget — objBulkDelete is async + handles its own
      // toast / refresh. Don't await on the click handler.
      window.objBulkDelete();
    }
  };

  // Sandbox-path objBulkDelete — same shape as the legacy copy
  // (_wireGlobals line ~1585) but refreshes via _objLoadAndPaint so
  // the per-type tbody host gets repainted. Sandbox path bypasses
  // _wireGlobals entirely, so without this re-install the live delete
  // is a no-op + the user sees "visual delete, refresh restores it".
  window.objBulkDelete = async () => {
    const kind = currentKind, schema = SCHEMAS[kind];
    if (!schema?.canDelete) { toast.info(`Bulk delete isn't supported on ${kind} yet.`); return; }
    let ids = [...(STATE[kind]?.selected || [])];
    if (!ids.length) return;
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
    // Repaint the chip + clear visible row-sel classes that spSetMode's
    // earlier animation might have left behind.
    const chip = root.querySelector(".rp-rt-sel-chip");
    if (chip) {
      chip.setAttribute("data-count", "0");
      chip.innerHTML = '<i class="bi bi-check2-square"></i> 0 selected';
    }
    await _objLoadAndPaint(kind);
    toast.success(`Deleted ${ok}`
      + (fail ? ` (${fail} failed)` : "")
      + (skipped ? ` — ${skipped} skipped (default project)` : "")
      + ".");
  };

  // Header Add button dispatcher — same body as the legacy _wireGlobals
  // copy (line ~1759). Sandbox path bypasses _wireGlobals so we
  // re-install here. schema.addAction (companies prompt + POST),
  // schema.addHref (reports/dashboards nav to ?new=1), or fall through
  // to the programmatic upload modal (projects/files).
  window.objAdd = async () => {
    const schema = SCHEMAS[currentKind];
    if (schema.addAction) {
      try {
        const ok = await schema.addAction();
        if (ok) {
          toast.success("Created.");
          if (typeof _objLoadAndPaint === "function") {
            await _objLoadAndPaint(currentKind);
          }
        }
      } catch (err) {
        toast.error(`Create failed: ${err.body?.error ?? err.message}`);
      }
      return;
    }
    if (schema.addHref) { location.hash = schema.addHref; return; }
    if (typeof _objOpenUploadModal === "function") _objOpenUploadModal();
  };

  // Sandbox inline cell edit. Port of legacy objCellEdit (line ~1631)
  // with two adaptations: reads is-mode-edit (sandbox) instead of
  // rp-rt-mode-edit (legacy), and refreshes via _objLoadAndPaint
  // (per-type tbody host) instead of loadTable (legacy [data-rt-tbody]).
  //
  // Edit types: text / bool / enum match the legacy version. select +
  // open are deferred — they're entity-picker / handoff flows that
  // pull more sandbox-specific wiring (option lists, modal positioning).
  // Both fall through to a toast for now so the user knows they're not
  // forgotten.
  window.objectsCellEdit = (td) => {
    const panel = root.querySelector(".rp-rt-panel");
    if (!panel?.classList.contains("is-mode-edit")) return;
    if (!td || !currentKind) return;
    const kind   = currentKind;
    const schema = SCHEMAS[kind];
    const rid    = td.dataset.rid;
    const type   = td.dataset.editType;
    const field  = td.dataset.editField;
    if (!rid || !field || !schema?.saveEdit) return;
    if (td.querySelector("input, select")) return; // already editing

    if (type === "text") {
      const oldVal = td.textContent.trim();
      const input  = document.createElement("input");
      input.type  = "text";
      input.className = "rp-rt-cell-input";
      input.value = oldVal;
      td.textContent = "";
      td.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const restore = () => _objLoadAndPaint(kind);
      const commit  = async () => {
        if (done) return;
        done = true;
        const newVal = input.value.trim();
        if (newVal === oldVal) { restore(); return; }
        try {
          await schema.saveEdit(rid, field, newVal);
          // Invalidate the localStorage list cache so the SWR-cached
          // paint inside _objLoadAndPaint can't briefly serve the
          // pre-edit row before fresh resolves. Cache gets rewritten
          // by the fresh fetch that follows, so the next mount also
          // sees the post-edit state.
          api.invalidateCached?.(schema.path);
          // Refresh BEFORE the toast so the SWR cache is overwritten
          // with the fresh value before the user has a chance to refresh
          // and observe stale data.
          await _objLoadAndPaint(kind);
          window.toast?.success?.("Saved.");
        } catch (err) {
          restore();
          window.toast?.error?.(`Save failed: ${err.body?.error ?? err.message}`);
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter")  { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { done = true; restore(); }
      });
      return;
    }

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
      const restore = () => _objLoadAndPaint(kind);
      const commit  = async () => {
        if (done) return;
        done = true;
        const newVal = sel.value === "true";
        if (newVal === oldVal) { restore(); return; }
        try {
          await schema.saveEdit(rid, field, newVal);
          // Invalidate the localStorage list cache so the SWR-cached
          // paint inside _objLoadAndPaint can't briefly serve the
          // pre-edit row before fresh resolves. Cache gets rewritten
          // by the fresh fetch that follows, so the next mount also
          // sees the post-edit state.
          api.invalidateCached?.(schema.path);
          // Refresh BEFORE the toast so the SWR cache is overwritten
          // with the fresh value before the user has a chance to refresh
          // and observe stale data.
          await _objLoadAndPaint(kind);
          window.toast?.success?.("Saved.");
        } catch (err) {
          restore();
          window.toast?.error?.(`Save failed: ${err.body?.error ?? err.message}`);
        }
      };
      sel.addEventListener("change", commit);
      sel.addEventListener("blur",   commit);
      sel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { done = true; restore(); }
      });
      return;
    }

    if (type === "enum") {
      const col  = schema.columns.find((c) => c.edit?.field === field);
      const opts = col?.edit?.options ?? [];
      const row  = STATE[kind].rows.find((r) => r.redpash_id === rid);
      const oldVal = row?.[field];
      const sel = document.createElement("select");
      sel.className = "rp-rt-cell-input";
      sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      sel.value = oldVal;
      td.textContent = "";
      td.appendChild(sel);
      sel.focus();
      let done = false;
      const restore = () => _objLoadAndPaint(kind);
      const commit  = async () => {
        if (done) return;
        done = true;
        const newVal = sel.value;
        if (!newVal || newVal === oldVal) { restore(); return; }
        try {
          await schema.saveEdit(rid, field, newVal);
          // Invalidate the localStorage list cache so the SWR-cached
          // paint inside _objLoadAndPaint can't briefly serve the
          // pre-edit row before fresh resolves. Cache gets rewritten
          // by the fresh fetch that follows, so the next mount also
          // sees the post-edit state.
          api.invalidateCached?.(schema.path);
          // Refresh BEFORE the toast so the SWR cache is overwritten
          // with the fresh value before the user has a chance to refresh
          // and observe stale data.
          await _objLoadAndPaint(kind);
          window.toast?.success?.("Saved.");
        } catch (err) {
          restore();
          window.toast?.error?.(`Save failed: ${err.body?.error ?? err.message}`);
        }
      };
      sel.addEventListener("change", commit);
      sel.addEventListener("blur",   commit);
      sel.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { done = true; restore(); }
      });
      return;
    }

    // select / open — pending sandbox-specific wiring (entity picker
    // modal, builder handoff). Falls through with an informative toast
    // so the user knows the click landed.
    window.toast?.info?.(`Editing ${type} cells isn't wired on this view yet — try the legacy mount.`);
  };

  // Sandbox-aware date-format setter — toolbar.html's dropdown items
  // call this with the format key. Legacy `objSetDateFmt` (line ~1379)
  // targets the legacy markup conventions (.rp-rt-dd-item, [data-rt-
  // datefmt-label]); the sandbox uses .rp-dd-item + [data-sp-datefmt-
  // label], so we need a sandbox companion. Both share the same
  // module-global `dateFmt` + repaint via _objLoadAndPaint /
  // paintObjectsSandboxTable.
  window.objectsSetDateFmt = (item, fmt) => {
    if (!_DATE_FMT_LABEL[fmt]) return;
    dateFmt = fmt;
    const dd = item.closest(".rp-dd-menu");
    dd?.querySelectorAll(".rp-dd-item").forEach((i) => i.classList.remove("is-selected"));
    item.classList.add("is-selected");
    const label = root.querySelector("[data-sp-datefmt-label]");
    if (label) label.textContent = _DATE_FMT_LABEL[fmt];
    dd?.classList.remove("open");
    // Repaint the active tab so date cells re-render with the new format.
    if (typeof paintObjectsSandboxTable === "function" && currentKind) {
      paintObjectsSandboxTable(currentKind);
    }
    // Snapshot the full view so prefs.objects_views reflects the new
    // dateFmt — Profile/Settings reads from there to render the
    // "Saved tab views" summary chips.
    _persistObjView(currentKind);
  };

  // Sandbox companion to spDdSelectRows — controls.js only updates the
  // label + selected class. Wire the actual state mutation + repaint
  // + persist here so picking a new "N rows" entry survives a refresh
  // and shows up on Profile's Saved tab views. Bound from toolbar.html
  // as a composite: onclick="spDdSelectRows(this, N);objectsSetRows(this, N)".
  window.objectsSetRows = (item, n) => {
    if (!currentKind || !STATE[currentKind]) return;
    const num = Number(n);
    if (!OBJ_ROWS_OPTS.includes(num)) return;
    STATE[currentKind].rowsPerPage = num;
    STATE[currentKind].page = 1;
    if (typeof paintObjectsSandboxTable === "function") {
      paintObjectsSandboxTable(currentKind);
    }
    _persistObjView(currentKind);
  };

  // Page navigation — the [data-objects-pages] buttons painted by
  // paintObjectsSandboxTable call this. paintObjectsSandboxTable clamps
  // an out-of-range page, so no bounds check needed here. The page is
  // transient nav state, not a saved-view field — no _persistObjView.
  window.objectsGoPage = (p) => {
    if (!currentKind || !STATE[currentKind]) return;
    STATE[currentKind].page = Number(p) || 1;
    if (typeof paintObjectsSandboxTable === "function") {
      paintObjectsSandboxTable(currentKind);
    }
  };

  if (_installObjectsLiveHandlers._installed) return;
  _installObjectsLiveHandlers._installed = true;

  // Doc-level delegation on the type-tab strip. spRenderObjectTabs
  // emits .rp-rt-proj-tab buttons with data-sp-project-key="<kind>"
  // and inline onclick="spActivateObjectType('kind')" — we hook in
  // via the click event to add load+paint without rewriting the
  // sandbox renderer (avoids modifying controls.js). closest()
  // catches clicks on icon / label children too.
  //
  // NO `#obj-tabs` descendant scope on the selector — spActivateObjectType
  // runs spRenderObjectTabs(document) inline (replaces host.innerHTML),
  // which DETACHES the originally clicked button before our listener
  // sees the click. closest() walks the detached chain, so a
  // descendant-scoped selector ("#obj-tabs ...") never matches.
  // Discriminator vs cleaner project tabs (same class + data attr):
  // the value of data-sp-project-key. Object kinds are in SCHEMAS;
  // cleaner project rids ("PRJ_…") are not.
  document.addEventListener("click", (ev) => {
    const tab = ev.target.closest?.(".rp-rt-proj-tab[data-sp-project-key]");
    if (!tab) return;
    if (ev.target.closest(".rp-rt-proj-tab-x")) return;
    const key = tab.getAttribute("data-sp-project-key");
    if (!key || !SCHEMAS[key]) return;
    window.objectsActivateKind(key);
  });
}

// Fetch + paint helper. loadTable mutates STATE[kind].rows in place;
// paintObjectsSandboxTable reads from there.
//
// SWR (Phase 1 A) — sandbox path mirror of loadTable above. Same
// cache-then-correct shape so tab switches feel instant on warm cache.
async function _objLoadAndPaint(kind) {
  if (!SCHEMAS[kind]) return;
  const schema = SCHEMAS[kind];
  const tbody = _root?.querySelector(`[data-objects-table="${kind}"] tbody`);

  const { cached, fresh } = api.getCached(schema.path);
  if (cached?.items) {
    STATE[kind].rows = cached.items;
    if (kind === currentKind) {
      paintObjectsSandboxTable(kind);
      _paintObjectsSandboxMeta(kind);
    }
  } else if (tbody) {
    tbody.innerHTML = '<tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic" colspan="99">Loading…</td></tr>';
  }
  try {
    const res = await fresh;
    STATE[kind].rows = res.items ?? [];
  } catch (err) {
    if (!cached) {
      STATE[kind].rows = [];
      if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;color:var(--red);padding:1rem" colspan="99">${esc(err.body?.error ?? err.message ?? "load failed")}</td></tr>`;
      return;
    }
    // else: keep the cached paint; correction will retry on next mount.
  }
  // Tab switched while we were fetching — drop the stale paint.
  if (kind !== currentKind) return;
  paintObjectsSandboxTable(kind);
  _paintObjectsSandboxMeta(kind);
}

// Paint per-type tbody from STATE[kind].rows. V0: uses the schema's
// visible (non-hidden) columns as the cell layout — column count may
// not match the partial's hand-tuned thead, browsers handle the
// overflow gracefully (left-aligns under whatever headers exist). V1
// will add per-kind sandboxCols hints + rich badges/bars to match the
// partial visually.
function paintObjectsSandboxTable(kind) {
  const wrap  = _root?.querySelector(`[data-objects-table="${kind}"]`);
  const thead = wrap?.querySelector("thead");
  const tbody = wrap?.querySelector("tbody");
  if (!tbody) return;
  // Apply the toolbar search filter + predicate filter when active.
  // Both run via legacy helpers (_objMatchesSearch / _objRowMatchesFilter)
  // — kind-agnostic, read STATE[kind].search + global objPredicates /
  // objCombinator. No filter → render all rows untouched.
  const allRows = STATE[kind]?.rows ?? [];
  const searchQ = String(STATE[kind]?.search || "").trim().toLowerCase();
  const filtersActive = objPredicates.length && kind === currentKind;
  const rows = (searchQ || filtersActive)
    ? allRows.filter((r) => {
        if (searchQ && !_objMatchesSearch(kind, r, searchQ)) return false;
        if (filtersActive && !_objRowMatchesFilter(r, kind)) return false;
        return true;
      })
    : allRows;

  // Paginate — honour the toolbar's rows-per-page choice + current page
  // (STATE[kind].rowsPerPage / .page). Without this the table painted
  // every filtered row, so the rows-per-page dropdown did nothing.
  const _st        = STATE[kind] ?? {};
  const perPage    = OBJ_ROWS_OPTS.includes(_st.rowsPerPage) ? _st.rowsPerPage : 25;
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const page       = Math.min(Math.max(1, _st.page || 1), totalPages);
  if (STATE[kind]) STATE[kind].page = page;   // clamp back into range
  const pageStart  = (page - 1) * perPage;
  const pageRows   = rows.slice(pageStart, pageStart + perPage);

  // Footer — fill the per-type partial's <div class="rp-rt-pager">:
  // the [data-objects-rows-info] line + the [data-objects-pages] buttons.
  // Scope the lookup to the table-wrap's parent — the pager is its
  // sibling in the table partial. NOT [data-object-type="<kind>"]:
  // that attribute appears twice (header strip + body), so querySelector
  // would hit the header block, which has no pager. [data-objects-table]
  // is unique per kind, so `wrap` is unambiguous.
  const _pagerHost = wrap?.parentElement;
  const _info = _pagerHost?.querySelector("[data-objects-rows-info]");
  if (_info) {
    _info.textContent = rows.length
      ? `Showing ${pageStart + 1}–${Math.min(pageStart + perPage, rows.length)} of ${rows.length} ${kind}`
      : "";
  }
  const _pages = _pagerHost?.querySelector("[data-objects-pages]");
  if (_pages) {
    _pages.innerHTML = pagerMarkup(page, totalPages);
    _pages.querySelectorAll("button[data-pg]").forEach((b) => {
      b.addEventListener("click", () => window.objectsGoPage?.(Number(b.dataset.pg)));
    });
  }

  // Honour the per-tab columns picker — _visibleOrderedCols reads
  // STATE[kind].visibleCols + .colOrder so the table reflects what
  // objectsToggleCol / objectsResetCols just changed. Falls back to
  // the schema's natural !hidden filter when state isn't seeded yet
  // (defensive — _ensureColState should always have run first).
  _ensureColState(kind);
  const cols = _visibleOrderedCols(kind);

  // Dynamic thead — paint headers from the same `cols` list so column
  // count and order ALWAYS match the body. Previously each per-type
  // partial (types/<kind>/table.html) shipped a hand-coded <thead>
  // with the schema's default columns; toggling a column off in the
  // picker shrank the body but left the header stale.
  //
  // Sort chevrons render as decoration only for now — click wiring
  // (objectsSortBy companion to legacy objSortBy) is a separate pass.
  // Mode column (leading checkbox + uncheck/check/trash icons) is
  // emitted always; CSS gates visibility by panel mode class.
  if (thead) {
    const heads = cols.map((c) =>
      `<th data-rt-col="${esc(c.key)}" class="rp-rt-th-sortable">`
      + `${esc(c.label)} <i class="bi bi-arrow-down-up rp-rt-sort-ico"></i>`
      + `</th>`,
    ).join("");
    // Master checkbox composite — spSelectAllRows handles the visual
    // tick-all + class flip on each row; objectsSelectAllRows mirrors
    // into STATE[kind].selected so the live delete has all rids.
    // Master trash composite — spDeleteAllRows animates + undo,
    // objectsMaybeBulkDelete fires the real DELETE for the now-selected
    // rows. (spDeleteAllRows fades all visible regardless of selection;
    // the live delete only acts on what's in STATE[kind].selected, so
    // the master trash is "delete selected after master-check" — the
    // user clicks master-check first to populate selection.)
    thead.innerHTML = `<tr>`
      +   `<th class="rp-rt-th-mode" style="width:1.5rem">`
      +     `<input type="checkbox" onclick="spSelectAllRows(this);objectsSelectAllRows(this)" />`
      +     `<i class="bi bi-circle rp-row-uncheck"></i>`
      +     `<i class="bi bi-check2-circle rp-row-check"></i>`
      +     `<i class="bi bi-trash rp-row-trash rp-master-trash" onclick="spDeleteAllRows(this);objectsMaybeBulkDelete()" title="Delete all selected"></i>`
      +   `</th>`
      +   heads
      + `</tr>`;
  }

  if (!cols.length) {
    // Min-1 guard in objectsToggleCol should prevent this, but be safe.
    tbody.innerHTML = `<tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic" colspan="99">No columns selected.</td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic" colspan="99">No ${esc(kind)}.</td></tr>`;
    return;
  }
  // Mode column (checkbox + icons) matches the cleaner sandbox
  // convention so spSetMode / mode-class CSS in objects-sandbox.css
  // applies the same uncheck / check / trash fade-in behaviour. Per-row
  // onclick="spToggleRowSel(this)" mirrors the partial's hardcoded
  // demo rows so select mode works without per-row wiring this pass.
  tbody.innerHTML = pageRows.map((r) => {
    const rid = esc(r.redpash_id ?? "");
    // Composite onclick — spToggleRowSel handles the visual class flip,
    // objectsToggleRowSel mirrors that into STATE[kind].selected so the
    // backend delete (objBulkDelete) has the rids it needs.
    return ''
      + `<tr data-rt-rid="${rid}" onclick="spToggleRowSel(this);objectsToggleRowSel(this)">`
      +   '<td>'
      +     '<input type="checkbox" />'
      +     '<i class="bi bi-circle rp-row-uncheck"></i>'
      +     '<i class="bi bi-check2-circle rp-row-check"></i>'
      +     '<i class="bi bi-trash rp-row-trash"></i>'
      +   '</td>'
      +   cols.map((c) => {
          // Columns with an `edit` spec get an ondblclick + data attrs
          // so objectsCellEdit (in edit mode) can swap the cell for an
          // input/select and commit via schema.saveEdit. Non-editable
          // cells render as plain <td> — spSetMode skips the
          // contenteditable blanket on Objects panels entirely (it
          // detects the [data-object-type] descendant), so we don't
          // need a per-cell opt-out attribute.
          if (c.edit) {
            return `<td ondblclick="objectsCellEdit(this)"`
              + ` data-rid="${rid}"`
              + ` data-edit-field="${esc(c.edit.field ?? "")}"`
              + ` data-edit-type="${esc(c.edit.type ?? "")}">`
              + `${c.render(r)}</td>`;
          }
          return `<td>${c.render(r)}</td>`;
        }).join("")
      + '</tr>';
  }).join("");
}

// Paint the per-type header's row-count meta line. Hits the
// [data-objects-meta] hook that each per-type header partial exposes
// (e.g. "<div data-objects-meta>6 projects · 16 files total</div>").
function _paintObjectsSandboxMeta(kind) {
  const el = _root?.querySelector(`[data-object-type="${kind}"] [data-objects-meta]`);
  if (!el) return;
  const n = STATE[kind]?.rows?.length ?? 0;
  el.textContent = `${n} ${kind}`;
}
