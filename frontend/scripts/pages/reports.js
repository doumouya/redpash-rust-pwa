// Reports page — sandbox port, Phase 1.5 (source-table wiring).
//
// Layout: stacked toolbar + redtable (top pane) + drag handle + chart dock
// (bottom pane). The whole page is sandbox; the old multi-file builder at
// /scripts/reports/index.js is kept on disk for revertability but never
// invoked here (its DOM hooks — #reports-list / #reports-builder — don't
// exist in the new shell).
//
// This pass wires the SOURCE TABLE only, mirroring the cleaner playbook in
// docs/frontend/sandbox-integration.md:
//   • Parse ?file=FIL_… from the URL.
//   • Fetch /api/files → populate the source-file picker dropdown.
//   • Pre-select the URL file (or fall back to the first owned file).
//   • Fetch /api/files/:rid + /:rid/page → paint headers, rows, pagination.
//   • Wire search (debounced), rows-per-page, header-click sort.
//   • Snapshot the chrome to sessionStorage so reload paints fast
//     (cache-then-correct).
//
// Chart-dock sample cards are left untouched on purpose — the +Chart flow
// + chart-render port land in Phase 2.
//
// Conventions enforced (see sandbox-integration.md):
//   • `mountSandbox` runs on every hash change → element bindings are
//     once-guarded; document-level listeners would need
//     _installReportsLiveHandlers._xxxInstalled (none in this pass).
//   • STATE mirror discipline — every value a window.report* handler
//     reads is in STATE before any clickable DOM exists.
//   • api.get / api.post already prefix /api — pass /files, not /api/files.
//   • Rendered cells DO NOT carry data-row-idx + data-col-name — those
//     trigger controls.js's cell-edit dispatcher, which would make
//     read-only source rows accidentally editable.

import { api }   from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";

const DEFAULT_SPLIT = 0.60;   // table 60% / chart dock 40%
const MIN_SPLIT     = 0.20;
const MAX_SPLIT     = 0.85;

const SNAPSHOT_KEY = "rp_reports_mount_snapshot_v1";

// Module-scope STATE — every window.report* handler reads from here.
// Reset shape (no `let STATE = …` reassignment) so other modules holding
// a stale reference don't drift.
const STATE = {
  files:    [],     // FileSummary[] from /api/files
  rid:      null,   // currently-selected file rid (null = none)
  summary:  null,   // FileSummary of the selected file
  columns:  [],     // ColumnMeta[] of the selected file
  page:     1,
  pageSize: 25,
  sorts:    [],     // [{ col, dir: "asc" | "desc" }] — single-key today
  search:   "",
};

export default async function mount(root, ctx) {
  // 1) Sandbox subtree — router only loaded the thin partials/reports.html
  //    shell; include.js's recursive walker pulls in toolbar / table /
  //    chart-dock / modals from partials/reports/. Without this the page
  //    paints empty (mirrors cleaner.js / objects.js mount() pattern).
  if (typeof window.rpInclude === "function") {
    try { await window.rpInclude(root); }
    catch (err) { console.warn("[reports] rpInclude failed", err); }
  }

  // 2) Split-handle restore + wire. Same drag wiring as before; refactored
  //    out so mount() stays a clear bootstrap sequence.
  _applyAndWireSplit(root, ctx);

  // 3) Sandbox wiring — picker, fetch, table paint.
  await mountReportsSandbox(root, ctx);
}

// ─────────────────────────── mountReportsSandbox ──────────────────────

async function mountReportsSandbox(root, ctx) {
  const pickerMenu = root.querySelector("[data-reports-source-picker]");
  const tableWrap  = root.querySelector("[data-reports-table]");
  // Sandbox markup missing → bail. Mirrors the cleaner / objects guard so
  // a fall-through to the legacy layout (none today) wouldn't blow up.
  if (!pickerMenu || !tableWrap) return;

  // Restore prefs FIRST so renderers see them when they paint.
  const prefs = ctx?.session?.prefs ?? {};
  const savedSize = Number(prefs.reports_page_size);
  if (Number.isFinite(savedSize) && [10, 25, 50, 100].includes(savedSize)) {
    STATE.pageSize = savedSize;
  }

  // Install handlers BEFORE any inline onclick (or post-paint binding)
  // can fire. Same ordering rule the cleaner / objects mount uses.
  _installReportsLiveHandlers(root);

  // Sync the rows-per-page pill label to the restored size so the toolbar
  // matches STATE on first paint (the static partial says "25").
  _syncRowsLabel(root);

  // URL → starting report + file. Contract mirrors Cleaner
  // (?project=…&file=…): Reports opens at a report id +, optionally,
  // an explicit source file. `?id=` is accepted as a legacy alias for
  // `?report=`. When a report is named the file is implied by its
  // source_file_id unless `?file=` overrides.
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const initialReportId = q.get("report") || q.get("id") || null;
  const initialFileId   = q.get("file");
  STATE.reportId = initialReportId;   // remembered for URL canonicalisation

  // Mount snapshot — paint cached picker label fast, before the fetch
  // resolves. Table body shows the partial's "Pick a source file…" until
  // the page fetch lands (matches the cleaner discipline).
  _restoreFromSnapshot(root);

  // Fetch the user's files. /api/files returns every file owned by the
  // session user across every project — no per-project hop needed.
  //
  // SWR (Phase 1 A): cache-then-correct. Cached list populates the
  // picker synchronously so the source dropdown is ready before the
  // network round-trip lands. Cold cache → falls through to the
  // network paint without a flicker.
  const { cached, fresh } = api.getCached("/files");
  if (cached?.items) {
    STATE.files = cached.items;
    _renderReportsPicker(root);
  }
  try {
    const res = await fresh;
    STATE.files = res?.items ?? [];
  } catch (err) {
    console.error("[reports] fetch /files failed", err);
    if (!cached) {
      STATE.files = [];
      toast.error(`Couldn't load file list: ${err.body?.error ?? err.message ?? err}`);
    }
    // else: keep the cached paint; correction will retry on next mount.
  }

  _renderReportsPicker(root);

  // When ?report= is set, fetch the report so its source_file_id can
  // drive the active file (and title / spec land on STATE for handlers
  // that need them). A missing / non-owned report degrades quietly to
  // the file-only path below.
  if (initialReportId) {
    try {
      STATE.report = await api.get(`/reports/${encodeURIComponent(initialReportId)}`);
    } catch (err) {
      console.warn("[reports] fetch /reports/:id failed", err);
    }
  }

  // Decide active file. Order of preference:
  //   1. ?file= when it names a file we can see
  //   2. the loaded report's source_file_id (when ?file= is absent)
  //   3. first owned file (blank-landing fallback)
  // A URL file we can't see (deleted / not owned) silently falls
  // through rather than 404-ing — same forgiving behaviour as Cleaner.
  const urlFileValid    = initialFileId && STATE.files.some((f) => f.redpash_id === initialFileId);
  const reportFileId    = STATE.report?.source_file_id;
  const reportFileValid = reportFileId && STATE.files.some((f) => f.redpash_id === reportFileId);
  const activeId = urlFileValid    ? initialFileId
                 : reportFileValid ? reportFileId
                 :                   (STATE.files[0]?.redpash_id ?? null);

  if (!activeId) {
    _renderReportsEmptyState(root, "No files yet — upload one from the Home page.");
    return;
  }

  // STATE mirror — every handler reads from here. Set BEFORE the picker
  // gets a click target.
  STATE.rid     = activeId;
  STATE.summary = STATE.files.find((f) => f.redpash_id === activeId) ?? null;
  STATE.columns = [];   // forces _paintReportsTable to refetch /files/:rid

  _renderReportsPickerLabel(root);
  await _paintReportsTable(root);

  _snapshotForMount();

  // Canonicalise the URL — write back `?report=` (when known) + `?file=`
  // (the active source) so a reload reopens exactly this report+file
  // pair. Skip the write when nothing changed (avoids a redundant
  // history entry on every mount of an already-canonical URL).
  const _params = new URLSearchParams();
  if (initialReportId) _params.set("report", initialReportId);
  if (activeId)        _params.set("file",   activeId);
  const _canonical = `#/reports${_params.toString() ? "?" + _params.toString() : ""}`;
  if (_canonical !== location.hash) {
    history.replaceState(null, "", _canonical);
  }

  // Tier 2 E — Reports already loaded /files; warm the other lists
  // so jumping to Home / Objects / Dashboards from the report builder
  // hits cache.
  api.prewarm(["/projects", "/reports", "/dashboards", "/users", "/companies"]);
}

// ─────────────────────── _installReportsLiveHandlers ──────────────────

function _installReportsLiveHandlers(root) {

  // Shared closure — call after any STATE.rid / .search / .sorts / .page
  // mutation that needs a chrome + table repaint.
  async function _afterFileChange() {
    _renderReportsPickerLabel(root);
    await _paintReportsTable(root);
    _snapshotForMount();
  }

  // Picker → user clicked a file in the source-file dropdown. Closes the
  // menu, swaps STATE.rid, resets paging / sort / search, repaints, pushes
  // the URL so a reload reopens the new file.
  window.reportSelectFile = async (fileId) => {
    if (!fileId || fileId === STATE.rid) return;
    if (!STATE.files.some((f) => f.redpash_id === fileId)) {
      console.warn("[reports] unknown file id", fileId);
      return;
    }
    STATE.rid     = fileId;
    STATE.summary = STATE.files.find((f) => f.redpash_id === fileId) ?? null;
    STATE.columns = [];
    STATE.page    = 1;
    STATE.search  = "";
    STATE.sorts   = [];
    const searchInput = root.querySelector("[data-reports-search]");
    if (searchInput) searchInput.value = "";
    // Mark the selected item in the dropdown so re-open shows the chosen
    // file with .is-selected without a full re-render.
    root.querySelectorAll("[data-reports-source-picker] .rp-dd-item").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.fileId === fileId);
    });
    // Preserve ?report= across a source-file swap so a reload keeps
    // the report context. STATE.reportId is set at mount when the URL
    // carried a report.
    const _p = new URLSearchParams();
    if (STATE.reportId) _p.set("report", STATE.reportId);
    _p.set("file", fileId);
    history.replaceState(null, "", `#/reports?${_p.toString()}`);
    await _afterFileChange();
  };

  window.reportSetPage = async (page) => {
    if (!STATE.rid) return;
    const n = Number(page);
    if (!Number.isFinite(n) || n < 1 || n === STATE.page) return;
    STATE.page = n;
    await _paintReportsTable(root);
  };

  window.reportSetPageSize = async (size) => {
    const n = Number(size);
    if (!Number.isFinite(n) || n === STATE.pageSize) return;
    STATE.pageSize = n;
    STATE.page = 1;
    window.rpSavePref?.("reports_page_size", n);
    _syncRowsLabel(root);
    if (STATE.rid) await _paintReportsTable(root);
  };

  window.reportSortBy = async (col) => {
    if (!STATE.rid || !col) return;
    const cur = STATE.sorts[0];
    if (cur && cur.col === col) {
      // asc → desc → none cycle, mirrors the cleaner's column-sort UX.
      if (cur.dir === "asc")  { cur.dir = "desc"; }
      else                    { STATE.sorts = []; }
    } else {
      STATE.sorts = [{ col, dir: "asc" }];
    }
    STATE.page = 1;
    await _paintReportsTable(root);
  };

  window.reportRefresh = async () => {
    if (!STATE.rid) return;
    // Force a column re-fetch so a stale columns_meta from an underlying
    // step change repaints the headers too.
    STATE.columns = [];
    const start = performance.now();
    await _paintReportsTable(root);
    // 600ms minimum spin — same floor the cleaner uses so the icon
    // animation doesn't flash invisibly for cached fetches.
    const elapsed = performance.now() - start;
    if (elapsed < 600) await new Promise((r) => setTimeout(r, 600 - elapsed));
  };

  // Search — debounced 250ms. Bound once per element; the partial is
  // mounted by include.js into the same DOM node across re-mounts, so the
  // __rpReportsBound flag survives unless the partial is fully torn down.
  const searchInput = root.querySelector("[data-reports-search]");
  if (searchInput && !searchInput.__rpReportsBound) {
    searchInput.__rpReportsBound = true;
    let t = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const v = searchInput.value.trim();
        if (v === STATE.search) return;
        STATE.search = v;
        STATE.page = 1;
        if (STATE.rid) await _paintReportsTable(root);
      }, 250);
    });
  }

  // Rows-per-page menu items in the toolbar are hardcoded with
  // `onclick="spDdSelectRows(this, N)"` — that updates the pill label.
  // Hook the same item clicks (in capture phase so we run alongside the
  // sandbox handler, not after a class flip we'd have to read back) to
  // also push the new size into STATE via reportSetPageSize. Once-guarded.
  const rowsWrap = root.querySelector("[data-sp-rows-label]")?.closest(".rp-dd-wrap");
  if (rowsWrap && !rowsWrap.__rpReportsBound) {
    rowsWrap.__rpReportsBound = true;
    rowsWrap.addEventListener("click", (ev) => {
      const item = ev.target.closest(".rp-dd-item");
      if (!item) return;
      // The inline onclick already extracts N from the label number;
      // we re-read for safety in case the partial markup drifts.
      const n = parseInt(item.textContent, 10);
      if (Number.isFinite(n)) window.reportSetPageSize?.(n);
    });
  }
}

// ─────────────────────────── paint pipeline ───────────────────────────

async function _paintReportsTable(root) {
  if (!STATE.rid) {
    _renderReportsEmptyState(root, "Pick a source file from the toolbar.");
    return;
  }

  const tableWrap = root.querySelector("[data-reports-table]");
  if (tableWrap) tableWrap.setAttribute("aria-busy", "true");

  // First paint per file → also fetch /files/:rid to harvest columns +
  // refreshed summary. Subsequent paints (sort / page / search) only need
  // /page. STATE.columns being empty is the cache-miss signal.
  const needColumns = STATE.columns.length === 0;
  const qs = new URLSearchParams();
  qs.set("page", String(STATE.page));
  qs.set("size", String(STATE.pageSize));
  if (STATE.search)        qs.set("q",     STATE.search);
  if (STATE.sorts.length)  qs.set("sorts", JSON.stringify(STATE.sorts));

  let envRes, pageRes;
  try {
    const pagePromise = api.get(`/files/${encodeURIComponent(STATE.rid)}/page?${qs}`);
    if (needColumns) {
      [envRes, pageRes] = await Promise.all([
        api.get(`/files/${encodeURIComponent(STATE.rid)}`),
        pagePromise,
      ]);
    } else {
      pageRes = await pagePromise;
    }
  } catch (err) {
    console.error("[reports] page fetch failed", err);
    _renderReportsEmptyState(root, `Couldn't load rows: ${err.body?.error ?? err.message ?? err}`);
    return;
  } finally {
    if (tableWrap) tableWrap.removeAttribute("aria-busy");
  }

  if (envRes) {
    STATE.columns = envRes.columns ?? [];
    // Mirror summary in BOTH STATE.summary AND the matching STATE.files[i]
    // — drift between the two has burnt the cleaner more than once (see
    // sandbox-integration.md "STATE.summary and STATE.files[idx] can
    // drift").
    if (envRes.summary) {
      STATE.summary = envRes.summary;
      const idx = STATE.files.findIndex((f) => f.redpash_id === STATE.rid);
      if (idx >= 0) STATE.files[idx] = envRes.summary;
    }
    _renderReportsPickerLabel(root);
    _renderReportsColumnsPicker(root);
  }

  _renderReportsRows(root, pageRes);
  _renderReportsPaging(root, pageRes);
}

// ─────────────────────────── renderers ────────────────────────────────

function _renderReportsPicker(root) {
  const menu = root.querySelector("[data-reports-source-picker]");
  if (!menu) return;
  if (!STATE.files.length) {
    menu.innerHTML = `<div class="rp-dd-item is-disabled">No files yet</div>`;
    return;
  }
  // Build items with data-attrs only — listener attached below so file IDs
  // can never poison an inline onclick.
  menu.innerHTML = STATE.files.map((f) => {
    const id   = f.redpash_id;
    const name = f.display_name || f.filename;
    const sel  = (id === STATE.rid) ? " is-selected" : "";
    return `<div class="rp-dd-item${sel}" role="menuitem" data-file-id="${_attrEsc(id)}">${_htmlEsc(name)}</div>`;
  }).join("");

  // Delegated click — closes the menu and dispatches to the live handler.
  // Once-guarded so re-render doesn't stack listeners.
  if (!menu.__rpReportsBound) {
    menu.__rpReportsBound = true;
    menu.addEventListener("click", (ev) => {
      const item = ev.target.closest("[data-file-id]");
      if (!item) return;
      menu.classList.remove("open");
      window.reportSelectFile?.(item.dataset.fileId);
    });
  }
}

function _renderReportsPickerLabel(root) {
  const lbl = root.querySelector("[data-reports-source-label]");
  if (!lbl) return;
  lbl.textContent = STATE.summary?.display_name
                 || STATE.summary?.filename
                 || (STATE.rid ?? "No file");
}

function _renderReportsRows(root, page) {
  const tableWrap = root.querySelector("[data-reports-table]");
  if (!tableWrap) return;

  const colNames = STATE.columns.map((c) => c.name);
  if (!colNames.length) {
    tableWrap.innerHTML = `
      <table class="rp-rt-table">
        <thead><tr><th></th></tr></thead>
        <tbody><tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">No columns to display.</td></tr></tbody>
      </table>`;
    return;
  }

  const sortBy = STATE.sorts[0];
  const thead = `<thead><tr>${colNames.map((c) => {
    const active = sortBy && sortBy.col === c;
    const ico = active
      ? (sortBy.dir === "desc"
          ? '<i class="bi bi-arrow-down rp-rt-sort-ico is-on"></i>'
          : '<i class="bi bi-arrow-up rp-rt-sort-ico is-on"></i>')
      : '<i class="bi bi-arrow-down-up rp-rt-sort-ico"></i>';
    // data-col carries the raw name; click handler attached below — keeps
    // headers with quotes / specials from breaking an inline onclick.
    return `<th class="rp-rt-th-sortable" data-col="${_attrEsc(c)}">${_htmlEsc(c)} ${ico}</th>`;
  }).join("")}</tr></thead>`;

  const rows = page?.rows ?? [];
  const tbody = rows.length === 0
    ? `<tbody><tr><td colspan="${colNames.length}" style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">No rows match.</td></tr></tbody>`
    : `<tbody>${rows.map((r) => `<tr>${
        r.map((v) => v == null
          ? `<td><span class="rp-rt-null">—</span></td>`
          : `<td>${_htmlEsc(String(v))}</td>`
        ).join("")
      }</tr>`).join("")}</tbody>`;

  tableWrap.innerHTML = `<table class="rp-rt-table">${thead}${tbody}</table>`;

  // Wire header clicks for sort. Listeners die with the innerHTML on next
  // paint, so no once-guard needed.
  tableWrap.querySelectorAll("th[data-col]").forEach((th) => {
    th.addEventListener("click", () => window.reportSortBy?.(th.dataset.col));
  });
}

function _renderReportsPaging(root, page) {
  const rowsInfo = root.querySelector("[data-reports-rows-info]");
  const pages    = root.querySelector("[data-reports-pages]");

  if (!page) {
    if (rowsInfo) rowsInfo.textContent = "—";
    if (pages)    pages.innerHTML = "";
    return;
  }

  if (rowsInfo) {
    const start = page.total === 0 ? 0 : ((page.page - 1) * page.size) + 1;
    const end   = Math.min(page.page * page.size, page.total);
    const filt  = (page.all_count != null && page.total !== page.all_count)
      ? ` (filtered from ${page.all_count.toLocaleString()})`
      : "";
    rowsInfo.textContent = `${start.toLocaleString()}–${end.toLocaleString()} of ${page.total.toLocaleString()}${filt}`;
  }

  if (pages) {
    const cur   = page.page;
    const total = page.pages || 1;
    // Class names match library + cleaner convention (.rp-rt-pg / .on /
     // .rp-rt-pg-gap) so the library's redtable.css pagination styles
     // apply here too. Previously rp-rt-page-btn / is-active /
     // rp-rt-page-ellipsis — nothing in the library matched, so reports
     // pagination rendered as unstyled UA buttons.
    const btn = (label, p, disabled, active) =>
      `<button type="button" class="rp-rt-pg${active ? ' on' : ''}"${disabled ? ' disabled' : ''} data-page="${p}">${label}</button>`;
    const parts = [];
    parts.push(btn("‹", Math.max(1, cur - 1), cur <= 1, false));

    // Compact pager: 1 … cur-1 cur cur+1 … last.
    const seen = new Set();
    const push = (p) => {
      if (p < 1 || p > total || seen.has(p)) return;
      seen.add(p);
      parts.push(btn(String(p), p, false, p === cur));
    };
    push(1);
    if (cur - 2 > 2)         parts.push(`<span class="rp-rt-pg rp-rt-pg-gap">…</span>`);
    push(cur - 1); push(cur); push(cur + 1);
    if (cur + 2 < total - 1) parts.push(`<span class="rp-rt-pg rp-rt-pg-gap">…</span>`);
    push(total);

    parts.push(btn("›", Math.min(total, cur + 1), cur >= total, false));
    pages.innerHTML = parts.join("");

    pages.querySelectorAll("button[data-page]").forEach((b) => {
      b.addEventListener("click", () => window.reportSetPage?.(b.dataset.page));
    });
  }
}

function _renderReportsColumnsPicker(root) {
  const picker = root.querySelector("[data-reports-cols-picker]");
  if (!picker) return;
  const cols = STATE.columns;
  if (!cols.length) return;   // leave the static "No columns." placeholder

  picker.innerHTML = `
    <button type="button" class="rp-dd-reset" title="Restore all columns" onclick="spColsReset(this)">
      <i class="bi bi-arrow-counterclockwise"></i> Reset
    </button>
    ${cols.map((c) => `
      <label class="rp-dd-check">
        <input type="checkbox" checked data-col="${_attrEsc(c.name)}" />
        ${_htmlEsc(c.name)}
      </label>
    `).join("")}`;
  // Column-visibility wiring (route the checkbox state through
  // PageQuery.cols, repaint) is deferred — keeps this pass focused on
  // "source data lands in the table." The checkboxes paint and toggle
  // visually via the existing sandbox handlers.
}

function _renderReportsEmptyState(root, message) {
  const tableWrap = root.querySelector("[data-reports-table]");
  if (tableWrap) {
    tableWrap.innerHTML = `
      <table class="rp-rt-table">
        <thead><tr><th></th></tr></thead>
        <tbody><tr><td style="text-align:center;color:var(--muted);padding:1rem;font-style:italic">${_htmlEsc(message)}</td></tr></tbody>
      </table>`;
  }
  const rowsInfo = root.querySelector("[data-reports-rows-info]");
  if (rowsInfo) rowsInfo.textContent = "—";
  const pages = root.querySelector("[data-reports-pages]");
  if (pages) pages.innerHTML = "";
}

function _syncRowsLabel(root) {
  const lbl = root.querySelector("[data-sp-rows-label]");
  if (!lbl) return;
  lbl.textContent = String(STATE.pageSize);
  // Mark the matching menu item .is-selected so spDdSelectRows's
  // exclusive-selection paint stays in sync on first mount.
  const menu = lbl.closest(".rp-dd-wrap")?.querySelector(".rp-dd-menu");
  if (!menu) return;
  menu.querySelectorAll(".rp-dd-item").forEach((item) => {
    const n = parseInt(item.textContent, 10);
    item.classList.toggle("is-selected", n === STATE.pageSize);
  });
}

// ─────────────────────── mount-snapshot helpers ───────────────────────
// Same recipe as cleaner: snapshot the picker chrome to sessionStorage so
// reload paints the picker label instantly while fetches catch up. Table
// rows aren't snapshotted (too big to serialize, and they go stale fast —
// the partial's "Pick a source file…" placeholder shows until paint).

function _snapshotForMount() {
  try {
    const snap = {
      hashUrl: location.hash,
      rid:     STATE.rid,
      summary: STATE.summary
        ? {
            redpash_id:   STATE.summary.redpash_id,
            filename:     STATE.summary.filename,
            display_name: STATE.summary.display_name,
          }
        : null,
      pageSize: STATE.pageSize,
    };
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* sessionStorage full / disabled — non-fatal */ }
}

function _restoreFromSnapshot(root) {
  let snap;
  try { snap = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) || "null"); }
  catch { return; }
  // URL guard — restore only when the user landed back on the same hash
  // (same file). Different URL = different file → don't paint stale.
  if (!snap || snap.hashUrl !== location.hash) return;

  const lbl = root.querySelector("[data-reports-source-label]");
  if (lbl && snap.summary) {
    lbl.textContent = snap.summary.display_name || snap.summary.filename;
  }
  if (Number.isFinite(snap.pageSize)) {
    STATE.pageSize = snap.pageSize;
    _syncRowsLabel(root);
  }
}

// ─────────────────────────── split-handle ─────────────────────────────

function _applyAndWireSplit(root, ctx) {
  const savedSplit = Number(ctx?.session?.prefs?.reports_split);
  const split = Number.isFinite(savedSplit) && savedSplit >= MIN_SPLIT && savedSplit <= MAX_SPLIT
    ? savedSplit
    : DEFAULT_SPLIT;
  _applySplit(root, split);

  const handle = root.querySelector("[data-reports-split-handle]");
  if (!handle || handle.__rpReportsBound) return;
  handle.__rpReportsBound = true;

  let dragging = false;
  let bodyEl   = null;

  const startDrag = (ev) => {
    bodyEl = root.querySelector(".rp-rt-body");
    if (!bodyEl) return;
    dragging = true;
    handle.classList.add("is-dragging");
    handle.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  };
  const moveDrag = (ev) => {
    if (!dragging || !bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
    const y    = (ev.clientY ?? ev.touches?.[0]?.clientY ?? 0) - rect.top;
    let frac = y / rect.height;
    if (frac < MIN_SPLIT) frac = MIN_SPLIT;
    if (frac > MAX_SPLIT) frac = MAX_SPLIT;
    _applySplit(root, frac);
  };
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("is-dragging");
    handle.releasePointerCapture?.(ev.pointerId);
    const tablePane = root.querySelector("[data-reports-table-pane]");
    const pct = parseFloat(tablePane?.style.height || "");
    if (Number.isFinite(pct) && pct >= 1) {
      window.rpSavePref?.("reports_split", pct / 100);
    }
  };
  handle.addEventListener("pointerdown",   startDrag);
  handle.addEventListener("pointermove",   moveDrag);
  handle.addEventListener("pointerup",     endDrag);
  handle.addEventListener("pointercancel", endDrag);

  // Keyboard accessibility — arrow keys nudge the split by 2% steps.
  handle.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    const tablePane = root.querySelector("[data-reports-table-pane]");
    const cur = parseFloat(tablePane?.style.height || "") / 100;
    if (!Number.isFinite(cur)) return;
    const step = ev.key === "ArrowUp" ? -0.02 : 0.02;
    let next = cur + step;
    if (next < MIN_SPLIT) next = MIN_SPLIT;
    if (next > MAX_SPLIT) next = MAX_SPLIT;
    _applySplit(root, next);
    window.rpSavePref?.("reports_split", next);
    ev.preventDefault();
  });
}

// Write the same fraction to all three split-aware elements so the table
// pane, chart pane, and handle stay aligned. Fraction is the table pane's
// height as a 0-1 number; chart pane fills the rest. Handle is biased up
// by 0.25rem so its 0.5rem hit area straddles the pane boundary line.
function _applySplit(root, frac) {
  const pct       = (frac * 100).toFixed(2) + "%";
  const handlePct = `calc(${pct} - 0.25rem)`;
  const tablePane = root.querySelector("[data-reports-table-pane]");
  const chartPane = root.querySelector("[data-reports-chart-pane]");
  const handle    = root.querySelector("[data-reports-split-handle]");
  if (tablePane) tablePane.style.height = pct;
  if (chartPane) chartPane.style.top    = pct;
  if (handle)    handle.style.top       = handlePct;
}

// ─────────────────────────── tiny helpers ─────────────────────────────

function _htmlEsc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function _attrEsc(s) {
  // Same as html, plus apostrophe (we use double-quoted attrs but data-
  // attrs occasionally land inside single-quoted innerHTML strings).
  return _htmlEsc(s).replace(/'/g, "&#39;");
}
