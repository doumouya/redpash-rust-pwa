/* studio/workspace — the Data Cleaner.

   STEP 2 of the redtable-family rebuild: the loaded view composes the family
   parts à la carte — a slim toolbar over the full-surface table:
     upload · filter · search · edit/select/delete · undo/redo · refresh ·
     row-numbers · rows-per-page · columns · download.
     · filter — the nested AND/OR builder, SUMMONED in a modal (no pinned panel);
       Apply sets QuerySpec.filter and re-fetches a server-filtered page.
     · search — client-side filter over the loaded page.
     · sortable headers — server sort via QuerySpec.sort.
     · edit/select/delete — redtable interaction; edit→set_cell, delete→drop_rows.
   History + Clean/Joins panels return as the last two parts.

   set_cell/drop_rows address rows by ABSOLUTE dataframe index. The page is
   offset=0, so a row's __k IS its absolute index — UNTIL a server filter makes
   the page filter-relative; edit/delete are gated off while a filter is active
   (correctness, not permission) until rows carry a stable id. */

import { api } from "../../../framework/boot/api.js";
import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountUploader } from "../../../framework/uploader/uploader.js";
import { mountRedTable } from "../../../framework/redtable/redtable.js";
import { mountGridView } from "../../../framework/grid-view/grid-view.js";
import { mountObjectList } from "../../../framework/object-list/object-list.js";
import { mountFilterPanel } from "../../../framework/filter-panel/filter-panel.js";
import { mountColumnManager } from "../../../framework/column-manager/column-manager.js";
import { mountStepsPanel } from "../../../framework/steps-panel/steps-panel.js";
import { mountSqlEditor } from "../../../framework/sql-editor/sql-editor.js";
import { mountJoinsWizard } from "../../../framework/joins-wizard/joins-wizard.js";
import { mountReportBuilder } from "../../../framework/report-builder/report-builder.js";
import { pickSource } from "../../../framework/engine/window-source.js";
import { openModal } from "../../../framework/modal/modal.js";
import { mountField } from "../../../framework/field/field.js";
import { input } from "../../../framework/atoms/atoms.js";
import { el } from "../../../framework/boot/dom.js";
import { toast } from "../../../framework/toast/toast.js";
import { invalidateRailData } from "../../../framework/rail/rail-data.js";
import { getPref, setPref } from "../../../framework/registry/pref-registry.js";
import { mainToolbar } from "./toolbar-spec.js";
import { CLEAN_OPS } from "./clean-catalog.js";
import { buildReportSpec, AGG_FNS } from "./report-spec.js";

// a Group with no children is "match all" — treat that as no filter.
const isEmptyFilter = (node) => !node || (Array.isArray(node?.children) && node.children.length === 0);

export default async function mount(root, ctx) {
  const session = ctx.getSession();
  let current = null; // {rid, filename, ...} | null
  let page = null;
  let gridView = null; // grid-view composer (toolbar + table)
  let grid = null; // = gridView.table
  let uploader = null;
  let uploading = false; // re-entry guard: serialize upload batches (the keyboard
  // path can re-open the picker mid-upload; a 2nd concurrent batch could race
  // ensure_default_project — see uploadFiles).
  let overviewList = null; // the Overview's Files table — a files object-list over /files
  let columns = []; // current column metas
  let allRows = []; // the full loaded page (before the search filter)
  let query = ""; // toolbar search — client-side filter over allRows
  let sort = null; // {col, descending} | null — server sort for POST /page
  let filterNode = null; // FilterNode | null — server filter (QuerySpec.filter)
  let rowNumbers = true; // leading #-column on the grid (toolbar toggle, default on)
  const hiddenCols = new Set(); // column keys hidden via the Columns menu
  let mode = "browse"; // browse | edit | select | delete
  let selection = []; // selected row keys (select mode)
  let stepsState = { steps: [], canUndo: false, canRedo: false };
  let sqlSource = null; // window-source for client-first SQL (lazy, per open file)
  let sqlQuery = ""; // last SQL run — reseeds the editor on reopen
  let pendingSteps = []; // staged-but-unsaved clean steps ([{kind,params,label}]) — the preview buffer

  // deep link: #/workspace?file=<rid> opens that file directly.
  const deepLink = (location.hash.split("?")[1] ?? "")
    .split("&")
    .map((kv) => kv.split("="))
    .find(([k]) => k === "file")?.[1];

  // The rail is server-driven (projects→csv); the page adds the Overview
  // pseudo-tab (upload landing), an in-place open for file tabs, and the active.
  function railSpec() {
    return {
      overview: { label: "Overview", icon: "bi-magic", active: !current, onSelect: () => renderEmpty() },
      onRailTab: (tab) => { if (tab?.kind === "file") openFile(tab.id); },
      active: current?.rid,
    };
  }

  // Name a new project → POST /projects, then refresh the rail so it appears.
  // A project is a top-level container any user owns once created (the backend
  // grants the caller owner), so this is a plain create — no parent to scope to.
  function newProject() {
    let name = "";
    let busy = false;
    let modal = null;
    async function submit() {
      if (busy) return; // a 2nd Enter / Create click while the POST is in flight
      const n = name.trim();
      if (!n) { toast({ message: "Project name is required", tone: "danger" }); return; }
      busy = true;
      try {
        await api.post("/projects", { name: n });
        modal?.close();
        toast({ message: `Project “${n}” created` });
        // Re-pull the rail IN PLACE so the new project appears — NOT renderEmpty(),
        // which would tear down an open file + its unsaved staged steps.
        page?.rail?.refresh?.();
      } catch (e) {
        busy = false; // let the user retry
        toast({ message: e.message || "Couldn't create the project", tone: "danger" });
      }
    }
    const body = el("div");
    mountField(body, { label: "Project name", control: input({ onInput: (v) => (name = v), onEnter: () => submit() }) });
    modal = openModal({
      title: "New project",
      body,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: ({ close }) => close() },
        { label: "Create", variant: "accent", onClick: () => submit() },
      ],
    });
  }

  const pageRows = () => Number(getPref("workspace.page_rows") ?? 1000);
  const visibleColumns = () => columns.filter((c) => !hiddenCols.has(c.key));

  // search is a CLIENT-SIDE filter over the loaded page: keep rows whose visible
  // cells contain the query (case-insensitive). Full-file search is the server's
  // QuerySpec.search (a later upgrade); this box stays over the loaded page.
  function filteredRows() {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) =>
      visibleColumns().some((c) => String(row[c.key] ?? "").toLowerCase().includes(q)));
  }
  function paintGrid() {
    grid.update({ columns: visibleColumns(), rows: filteredRows(), sort });
  }

  // server page → row objects keyed by a stable per-row index.
  function mapRows(p) {
    return p.rows.map((cells, i) => {
      const obj = { __k: String(i) };
      p.columns.forEach((c, j) => (obj[c] = cells[j]));
      return obj;
    });
  }

  // ── toolbar state + dispatch ─────────────────────────────────────────────────
  function toolbarState() {
    return {
      columns: columns.map((c) => ({ key: c.key, label: c.label, hidden: hiddenCols.has(c.key) })),
      pageRows: pageRows(),
      query,
      mode,
      rowNumbers,
      hasFilter: !!filterNode,
      dirty: pendingSteps.length > 0,
      canUndo: stepsState.canUndo,
      canRedo: stepsState.canRedo,
      selectionCount: selection.length,
    };
  }
  function refreshToolbar() {
    const s = toolbarState();
    gridView?.toolbar?.update({ state: s, controls: mainToolbar(s) });
  }
  function onToolbarAction(id, ctx) {
    if (id === "search") { query = ctx?.value ?? ""; paintGrid(); return; }
    if (id === "filter") { openFilter(); return; }
    if (ctx?.menu === "export") { location.href = `/api/files/${current.rid}/export?format=${id}`; return; }
    if (ctx?.menu === "rows") { setPref("workspace.page_rows", Number(id)); renderView(); return; }
    if (ctx?.menu === "cols") {
      if (hiddenCols.has(id)) hiddenCols.delete(id); else hiddenCols.add(id);
      paintGrid();
      refreshToolbar();
      return;
    }
    switch (id) {
      case "upload": renderEmpty(); return;
      case "save": saveStaged(); return;
      case "discard": discardStaged(); return;
      case "refresh": renderView(); return;
      case "history": openHistory(); return;
      case "clean": openClean(); return;
      case "sql": openSql(); return;
      case "joins": openJoins(); return;
      case "report": openReport(); return;
      case "rownum": rowNumbers = !rowNumbers; grid.update({ rowNumbers }); refreshToolbar(); return;
      case "edit": case "select": case "delete": setMode(id); return;
      case "undo": mutate(() => api.post(`/files/${current.rid}/undo`)); return;
      case "redo": mutate(() => api.post(`/files/${current.rid}/redo`)); return;
      case "clearsel": grid?.clearSelection?.(); selection = []; refreshToolbar(); return;
    }
  }

  // ── sortable headers — click cycles asc → desc → off, then re-fetch sorted ───
  function sortBy(col) {
    if (!sort || sort.col !== col) sort = { col, descending: false };
    else if (!sort.descending) sort = { col, descending: true };
    else sort = null;
    renderView();
  }

  // ── filter (summonable; no pinned panel) — the nested AND/OR builder in a
  //    modal; Apply sets QuerySpec.filter and re-fetches a server-filtered page.
  function openFilter() {
    const host = el("div");
    const modal = openModal({ title: "Filter", body: host, actions: [] });
    mountFilterPanel(host, {
      columns,
      value: filterNode,
      onApply: (node) => { applyFilter(node); modal.close(); },
      onClear: () => { clearFilter(); modal.close(); },
    });
  }
  function applyFilter(node) {
    filterNode = isEmptyFilter(node) ? null : node;
    // a filter makes the page filter-relative — pause any active row mutation.
    if (filterNode && (mode === "edit" || mode === "delete")) {
      mode = "browse";
      grid?.setInteraction("browse");
      toast({ message: "Edit/Delete paused while a filter is active.", tone: "warn" });
    }
    renderView();
  }
  function clearFilter() {
    filterNode = null;
    renderView();
  }

  // ── history + clean tools (summonable panels — no pinned region) ─────────────
  function openHistory() {
    const host = el("div");
    openModal({ title: "Cleaning steps", body: host, actions: [] });
    mountStepsPanel(host, {
      steps: stepsState.steps,
      canUndo: stepsState.canUndo,
      canRedo: stepsState.canRedo,
      onUndo: () => mutate(() => api.post(`/files/${current.rid}/undo`)),
      onRedo: () => mutate(() => api.post(`/files/${current.rid}/redo`)),
    });
  }
  function openClean() {
    const host = el("div");
    const modal = openModal({ title: "Clean", body: host, actions: [] });
    // close on apply so the next summon re-reads the (possibly changed) columns.
    mountColumnManager(host, {
      columns,
      ops: CLEAN_OPS,
      onApply: (op, cols, values) => { runCleanOp(op, cols, values); modal.close(); },
    });
  }

  // ── SQL console (summonable) — client-first Polars SQL via the window seam ───
  // Lazy per-file source: client (resident wasm Workbook.sql) where the frame
  // fits, server otherwise; either way the read-only guard lives in the engine.
  function ensureSqlSource() {
    if (!sqlSource) sqlSource = pickSource(current.rid, { rows: current.row_count ?? 0, cols: columns.length });
    return sqlSource;
  }
  async function runSqlPage(q) {
    try {
      return await ensureSqlSource().sql(q); // client-first (or server source)
    } catch {
      return await api.post(`/files/${current.rid}/sql`, { sql: q }); // worker fell over → server
    }
  }
  function openSql() {
    const editorHost = el("div");
    const resultHost = el("div");
    const body = el("div", { class: "pg-studio-workspace-console" }, editorHost, resultHost);
    openModal({ title: "SQL", body, actions: [] });
    let resultGrid = null;
    mountSqlEditor(editorHost, {
      value: sqlQuery,
      suggestName: () => `${current.filename.replace(/\.csv$/i, "")} query`,
      onRun: async (q) => {
        sqlQuery = q;
        const p = await runSqlPage(q);
        const cols = p.columns.map((c) => ({ key: c, label: c }));
        const rows = mapRows(p);
        if (resultGrid) resultGrid.update({ columns: cols, rows });
        else resultGrid = mountRedTable(resultHost, {
          columns: cols, rows, rowKey: (r) => r.__k, mode: "pager", pageSize: 100,
          empty: { title: "No rows", line: "The query returned nothing." },
        });
        return p;
      },
      onMaterialize: async (q, name) => {
        const out = await api.post(`/files/${current.rid}/sql/materialize`, { sql: q, materialize_as: name });
        invalidateRailData();
        toast({ message: `Saved ${out.filename} · ${out.rows} rows` });
      },
    });
  }

  // ── joins (summonable) — the multi-file join wizard; materialises a new file ──
  function openJoins() {
    const host = el("div");
    const modal = openModal({ title: "Join files", body: host, actions: [] });
    mountJoinsWizard(host, {
      detect: () => api.get(`/files/${current.rid}/joins`),
      onExecute: async (body) => {
        const out = await api.post(`/files/${current.rid}/joins`, body);
        invalidateRailData();
        toast({ message: `Joined → ${out.filename} · ${out.rows} rows` });
        modal.close();
        await openFile(out.rid); // open the joined result
      },
      onCancel: () => modal.close(),
    });
  }

  // ── report (summonable) — group + aggregate via /group/preview, result in a grid ──
  function openReport() {
    const builderHost = el("div");
    const resultHost = el("div");
    const body = el("div", { class: "pg-studio-workspace-console" }, builderHost, resultHost);
    openModal({ title: "Report", body, actions: [] });
    let resultGrid = null;
    mountReportBuilder(builderHost, {
      columns,
      aggFns: AGG_FNS,
      onRun: async ({ groupBy, measures }) => {
        try {
          const spec = buildReportSpec({ groupBy, measures, filter: filterNode });
          const p = await api.post(`/group/preview`, { file_id: current.rid, spec });
          const cols = p.columns.map((c) => ({ key: c, label: c }));
          const rows = mapRows(p);
          if (resultGrid) resultGrid.update({ columns: cols, rows });
          else resultGrid = mountRedTable(resultHost, {
            columns: cols, rows, rowKey: (r) => r.__k, mode: "pager", pageSize: 100,
            empty: { title: "No rows", line: "The report returned nothing." },
          });
        } catch (e) {
          toast({ message: e.message || "Report failed", tone: "danger" });
        }
      },
    });
  }

  // ── interaction modes (edit / select / delete) ───────────────────────────────
  function setMode(next) {
    // edit/delete address rows by absolute index; a server filter makes the page
    // filter-relative, so position-based mutation would hit the wrong row. Gate
    // it (correctness, not permission) until rows carry a stable id.
    if ((next === "edit" || next === "delete") && filterNode) {
      toast({ message: "Clear the filter to edit or delete rows — positions shift under a filter.", tone: "warn" });
      return;
    }
    mode = mode === next ? "browse" : next;
    grid?.setInteraction(mode);
    if (mode !== "select") { grid?.clearSelection?.(); selection = []; }
    refreshToolbar();
  }
  function commitEdit(rowKey, colKey, value) {
    if (filterNode) return; // defensive — setMode already blocks the mode under a filter
    applyStep({ label: `Edit ${colKey}`, kind: "set_cell", params: { row: Number(rowKey), column: colKey, value } });
  }
  function commitDelete(rowKey) {
    if (filterNode) return;
    applyStep({ label: "Delete row", kind: "drop_rows", params: { indices: [Number(rowKey)] } });
  }

  // Apply one or more steps as ONE gesture via the ATOMIC batch endpoint: it
  // pre-flights the whole chain, so a mid-chain failure rejects the entire Save
  // (vs N /steps calls that can leave a partial commit). The toast's Undo still
  // pops exactly as many as were committed (a per-column op is N steps, one undo).
  async function applySteps(steps, label) {
    if (!steps.length) return;
    try {
      await api.post(`/files/${current.rid}/steps/batch`, { steps: steps.map((s) => ({ kind: s.kind, params: s.params })) });
      toast({
        message: label,
        action: { label: "Undo", onClick: () => mutate(async () => { for (let i = 0; i < steps.length; i++) await api.post(`/files/${current.rid}/undo`); }) },
      });
      await afterMutation();
    } catch (e) {
      toast({ message: e.message || "Step failed", tone: "danger" });
      await afterMutation();
    }
  }
  const applyStep = (step) => applySteps([{ kind: step.kind, params: step.params }], step.label);

  // a clean-catalog op fired from the column-manager. clean-catalog owns the param
  // shape (op.build); a single-column param over a multi-selection becomes one step
  // per column, while array-shaped + exactly-2 ops stay a single step.
  function runCleanOp(op, cols, values) {
    const params = op.build(cols, values);
    const perColumn = "column" in params && cols.length > 1;
    const steps = perColumn
      ? cols.map((c) => ({ kind: op.id, params: op.build([c], values) }))
      : [{ kind: op.id, params }];
    stageSteps(steps, perColumn ? `${op.label} · ${cols.length} columns` : op.label);
  }

  // ── staged cleaning (preview → Save) ─────────────────────────────────────────
  // A clean op STAGES rather than commits: it lands in pendingSteps and the grid
  // shows the previewed result (committed + pending, via /steps/preview — the SAME
  // engine Save runs, so the preview is exact). Save commits the buffer through the
  // normal /steps path; Discard drops it. Edit/delete still commit immediately (v1).
  function stageSteps(steps, label) {
    steps.forEach((s) => pendingSteps.push({ kind: s.kind, params: s.params, label }));
    previewPending();
  }
  async function previewPending() {
    if (!current || !grid) return;
    if (!pendingSteps.length) return renderView();
    try {
      const p = await api.post(`/files/${current.rid}/steps/preview`, {
        offset: 0,
        limit: pageRows(),
        steps: pendingSteps.map((s) => ({ kind: s.kind, params: s.params })),
      });
      columns = p.columns.map((c) => ({ key: c, label: c }));
      for (const k of [...hiddenCols]) if (!columns.some((c) => c.key === k)) hiddenCols.delete(k);
      allRows = mapRows(p);
      paintGrid();
      refreshToolbar();
    } catch (e) {
      toast({ message: e.message || "Preview failed", tone: "danger" });
    }
  }
  async function saveStaged() {
    if (!pendingSteps.length) return;
    const steps = pendingSteps.map((s) => ({ kind: s.kind, params: s.params }));
    const label = pendingSteps.length === 1 ? pendingSteps[0].label : `Saved ${pendingSteps.length} changes`;
    pendingSteps = []; // clear first so afterMutation paints the committed frame, not the preview
    await applySteps(steps, label);
    refreshToolbar();
  }
  function discardStaged() {
    pendingSteps = [];
    renderView();
    refreshToolbar();
  }
  async function mutate(fn) {
    try { await fn(); await afterMutation(); }
    catch (e) { toast({ message: e.message || "Failed", tone: "danger" }); }
  }
  async function afterMutation() {
    await Promise.all([renderView(), refreshSteps()]);
  }
  async function refreshSteps() {
    if (!current) return;
    try {
      const s = await api.get(`/files/${current.rid}/steps`);
      stepsState = { steps: s.steps ?? [], canUndo: !!s.can_undo, canRedo: !!s.can_redo };
      refreshToolbar();
    } catch { /* keep the prior undo/redo state */ }
  }

  // ── render the loaded grid — POST /page with the window query (filter + sort) ──
  async function renderView() {
    if (!current || !grid) return;
    let p;
    try {
      p = await api.post(`/files/${current.rid}/page`, {
        offset: 0,
        limit: pageRows(),
        sort: sort ? [sort] : [],
        ...(filterNode ? { filter: filterNode } : {}),
      });
    } catch (e) {
      toast({ message: e.message || "Could not load rows", tone: "danger" });
      return;
    }
    columns = p.columns.map((c) => ({ key: c, label: c }));
    for (const k of [...hiddenCols]) if (!columns.some((c) => c.key === k)) hiddenCols.delete(k);
    allRows = mapRows(p);
    paintGrid();
    refreshToolbar();
  }

  // ── data lifecycle ───────────────────────────────────────────────────────────
  async function openFile(rid) {
    const summary = await api.get(`/files/${rid}`);
    current = { rid, filename: await fileName(rid), ...summary };
    hiddenCols.clear();
    query = "";
    sort = null;
    filterNode = null;
    mode = "browse";
    selection = [];
    sqlSource?.destroy();
    sqlSource = null;
    renderLoaded();
    await Promise.all([renderView(), refreshSteps()]);
  }

  async function fileName(rid) {
    const { items } = await api.get("/files?limit=50");
    return items.find((f) => f.rid === rid)?.filename ?? rid;
  }

  // Upload one or many files. Each CSV is its own request (the backend pipeline
  // is per-file: one genesis + cleanness score + project_files row), uploaded
  // SEQUENTIALLY — the first upload may mint the user's default project, so
  // parallel first-uploads could race it. A single clean upload opens the file
  // (the original flow); multiple refresh the Overview so they all appear.
  async function uploadFiles(files) {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length || uploading) return; // guard re-entry (keyboard picker mid-batch)
    uploading = true;
    try {
      const ok = [];
      let failed = 0;
      for (let i = 0; i < list.length; i++) {
        uploader?.busy(true, list.length > 1 ? `Uploading ${i + 1} of ${list.length}…` : "");
        try {
          const fd = new FormData();
          fd.append("file", list[i]);
          ok.push(await api.upload("/files", fd));
        } catch {
          failed++;
        }
      }
      invalidateRailData();
      if (ok.length && !failed) {
        toast({ message: ok.length === 1 ? `${ok[0].filename} uploaded` : `${ok.length} files uploaded` });
      } else if (ok.length) {
        toast({ message: `${ok.length} uploaded, ${failed} failed`, tone: "danger" });
      } else {
        toast({ message: failed > 1 ? `All ${failed} uploads failed` : "Upload failed", tone: "danger" });
      }
      // exactly one file, uploaded → open it (preserves the single-file flow);
      // otherwise re-render the Overview so every new file shows in the Files table.
      if (list.length === 1 && ok.length === 1) {
        // a flaky post-upload GET must not strand the spinner: the file IS saved.
        try {
          await openFile(ok[0].rid);
        } catch (e) {
          toast({ message: e.message || "Uploaded, but couldn't open the file", tone: "danger" });
          uploader?.busy(false);
          renderEmpty();
        }
        return;
      }
      uploader?.busy(false);
      if (ok.length) renderEmpty();
    } finally {
      uploading = false;
    }
  }

  // ── assembly ─────────────────────────────────────────────────────────────────
  function destroyPage() {
    gridView?.destroy?.();
    overviewList?.destroy?.();
    page?.destroy();
    sqlSource?.destroy();
    sqlSource = null;
    page = gridView = grid = uploader = overviewList = null;
  }

  function renderEmpty() {
    destroyPage();
    page = assemblePage(root, {
      session,
      activePageId: "workspace",
      rail: railSpec(),
      title: "Data Cleaner",
      sections: [{ key: "main" }, { key: "files", title: "Files" }],
    });
    current = null;
    uploader = mountUploader(page.section("main"), {
      multiple: true,
      hint: "CSV, TSV or text — pick one or several; open a file for a full-screen view",
      onFiles: uploadFiles,
    });
    // Overview = the Files table: the SAME generic object-list (redtable + the
    // filter toolbar), sourced from /files so it works without the registry backend
    // lane; a row click opens the file in the cleaner.
    overviewList = mountObjectList(page.section("files"), {
      type: "file",
      source: "/files?limit=200",
      columns: [
        { key: "filename", label: "File" },
        { key: "project_name", label: "Project" },
        { key: "rows", label: "Rows" },
        { key: "cols", label: "Cols" },
        { key: "cleanness", label: "Score" },
        { key: "created_at", label: "Created" },
      ],
      onOpen: (r) => openFile(r.rid),
      // New project lives in the toolbar "+" — the app-wide create affordance
      // (every object-list opens its create there). The Workspace is the project
      // flow, so the Files overview hosts it; creating refreshes the rail in place.
      create: { label: "New project", onCreate: newProject },
    });
  }

  // The loaded view — STEP 2: slim toolbar + the table, taking the whole surface.
  function renderLoaded() {
    destroyPage();
    page = assemblePage(root, {
      session,
      activePageId: "workspace",
      rail: railSpec(),
      title: current.filename,
      head: false, // full-bleed: the grid takes the whole surface, no title band
      sections: [{ key: "work", layout: "fill" }],
    });
    gridView = mountGridView(page.section("work"), {
      toolbar: { controls: mainToolbar(toolbarState()), onAction: onToolbarAction, state: toolbarState() },
      table: {
        columns: [],
        rows: [],
        rowKey: (r) => r.__k,
        mode: "auto",
        pageSize: 50,
        interaction: "browse",
        sortable: true,
        onSort: sortBy,
        rowNumbers,
        onSelectChange: (keys) => { selection = keys; refreshToolbar(); },
        onCellCommit: commitEdit,
        onRowDelete: commitDelete,
        empty: { title: "Empty file", line: "This file parsed to zero rows." },
      },
    });
    grid = gridView.table;
  }

  if (deepLink) {
    try { await openFile(deepLink); } catch { renderEmpty(); }
  } else {
    renderEmpty();
  }

  return { destroy: () => destroyPage() };
}
