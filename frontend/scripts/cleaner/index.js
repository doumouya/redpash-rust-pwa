// Cleaner controller. Owns the upload form, redtable mount, and the
// undo/redo header. Step actions go through `applyStep` which POSTs to
// /api/files/:rid/steps and then re-mounts the table with fresh columns.
//
// Step kinds shipped in this slice:
//   - drop_columns  (via the redtable's column-× hover button)
//   - rename_column (next — wired through a column-header rename UI)
//
// The state shape returned by /api/files/:rid (and every step endpoint)
// is { summary, columns, steps } — `steps` drives the Undo/Redo
// disabled-state and a future "Applied" sidebar.

import { api } from "/scripts/api.js";
import { toast } from "/scripts/ui/toast.js";
import { mount as mountRedtable }    from "/scripts/redtable/index.js";
import { mount as mountSidebar }     from "/scripts/cleaner/tools/sidebar.js";
import { mount as mountFilterPanel } from "/scripts/cleaner/filters/panel.js";

export function mount(root) {
  const fileInput   = root.querySelector("#cleaner-file");
  const meta        = root.querySelector("#cleaner-meta");
  const actions     = root.querySelector("#cleaner-actions");
  const tableHost   = root.querySelector("#cleaner-table");
  const toolsHost   = root.querySelector("#cleaner-tools");
  const filtersHost = root.querySelector("#cleaner-filters");

  let table   = null;
  let rid     = null;
  let summary = null;
  let columns = [];
  let steps   = [];

  const sidebar = mountSidebar(toolsHost,       { onAction: dispatchTool });
  const filters = mountFilterPanel(filtersHost, { table: null, columns: [] });

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    await uploadFile(f);
    fileInput.value = "";
  });

  // Header buttons (delegated — the markup is rendered by renderActions).
  actions.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled || !rid) return;
    const act = btn.dataset.act;
    if (act === "undo")     await callStep(`/files/${encodeURIComponent(rid)}/undo`);
    if (act === "redo")     await callStep(`/files/${encodeURIComponent(rid)}/redo`);
    if (act === "snapshot") openSnapshotDialog();
  });

  function openSnapshotDialog() {
    if (!rid || !summary) return;
    const defaultName = `${stripExt(summary.display_name ?? summary.filename)}_cleaned.csv`;
    const dlg = document.createElement("dialog");
    dlg.className = "rp-modal";
    dlg.innerHTML = `
      <header class="rp-modal__head">
        <h2 class="rp-modal__title">Save as cleaned file</h2>
        <button class="rp-modal__close" data-close aria-label="Close">×</button>
      </header>
      <div class="rp-modal__body rp-create-join">
        <p class="rp-muted">Creates a new file in this project with the current view as its content. The new file has no step history — it's a stable snapshot ready for Reports / Dashboards.</p>
        <label>
          <span>New file name</span>
          <input class="rp-tools__input" data-name value="${escapeHtml(defaultName)}" />
        </label>
      </div>
      <footer class="rp-modal__actions">
        <button class="rp-btn" data-close>Cancel</button>
        <button class="rp-btn rp-btn--primary" data-submit>Save</button>
      </footer>
    `;
    document.body.appendChild(dlg);
    dlg.showModal();

    dlg.addEventListener("click", async (e) => {
      if (e.target.matches("[data-close]")) { close(); return; }
      if (e.target.matches("[data-submit]")) {
        const submit = dlg.querySelector('[data-submit]');
        submit.disabled = true;
        submit.textContent = "Saving…";
        try {
          const body = { name: dlg.querySelector('[data-name]').value || undefined };
          const env = await api.post(`/files/${encodeURIComponent(rid)}/snapshot`, body);
          const newRid = env.summary.redpash_id;
          close();
          if (confirm(`Created "${env.summary.filename}". Open it now?`)) {
            location.hash = `#/cleaner?file=${encodeURIComponent(newRid)}`;
            location.reload();
          } else {
            toast.success(`Saved as "${env.summary.filename}"`);
          }
        } catch (err) {
          console.error("[cleaner] snapshot failed", err);
          submit.disabled = false;
          submit.textContent = "Save";
          alert(`Save failed: ${err.message ?? err}`);
        }
      }
    });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    function close() { dlg.close(); dlg.remove(); }
  }

  function stripExt(name) { return String(name).replace(/\.csv$/i, ""); }

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append("file", file);
    toast.info(`Uploading ${file.name}…`);
    try {
      const env = await api.post("/files/upload", fd);
      adopt(env);
      history.replaceState(null, "", `#/cleaner?file=${encodeURIComponent(env.summary.redpash_id)}`);
    } catch (err) {
      console.error("[cleaner] upload failed", err);
      toast.error(`Upload failed: ${err.message ?? err}`);
    }
  }

  async function openByRid(id) {
    try {
      const env = await api.get(`/files/${encodeURIComponent(id)}`);
      adopt(env);
    } catch (err) {
      toast.error(`Couldn't open file: ${err.message ?? err}`);
    }
  }

  function adopt(env) {
    rid     = env.summary.redpash_id;
    summary = env.summary;
    columns = env.columns ?? [];
    steps   = env.steps ?? [];
    renderMeta(summary);
    renderActions();
    tableHost.hidden   = false;
    toolsHost.hidden   = false;
    filtersHost.hidden = false;
    if (table) table.destroy();
    table = mountRedtable(tableHost, {
      rid,
      columns,
      onDropColumn:    (col)    => applyStep("drop_columns", { cols: [col] }),
      onDeleteRows:    (idxs)   => applyStep("drop_rows",    { indices: idxs }),
      onFiltersChange: ()       => filters.update({ table, columns, rid }),
    });
    filters.update({ table, columns, rid });
    sidebar.update({ summary, columns, steps, rid, getFilter: () => table?.getFilter?.() });
  }

  function renderMeta(s) {
    meta.innerHTML = `
      <span><strong>${escapeHtml(s.display_name ?? s.filename)}</strong></span>
      <span class="rp-muted">${s.row_count?.toLocaleString() ?? "?"} rows · ${s.col_count ?? "?"} cols</span>
      <span class="rp-muted">${s.encoding ?? "?"}</span>
    `;
  }

  function renderActions() {
    const appliedCount = steps.filter((s) => s.applied).length;
    const undoneCount  = steps.length - appliedCount;
    actions.innerHTML = `
      <button class="rp-btn rp-btn--sm" data-act="undo" ${appliedCount ? "" : "disabled"} title="Undo last step">↶ Undo</button>
      <button class="rp-btn rp-btn--sm" data-act="redo" ${undoneCount  ? "" : "disabled"} title="Redo">↷ Redo</button>
      <span class="rp-muted">${appliedCount} step${appliedCount === 1 ? "" : "s"} applied${undoneCount ? ` · ${undoneCount} undone` : ""}</span>
      <button class="rp-btn rp-btn--sm rp-btn--primary" data-act="snapshot" title="Save the current view as a new project file (no step history)">Save as cleaned…</button>
    `;
  }

  async function applyStep(kind, params) {
    if (!rid) return;
    const before = summary;   // snapshot pre-step counts for the toast
    try {
      const env = await api.post(`/files/${encodeURIComponent(rid)}/steps`, { kind, params });
      consumeUpdate(env);
      toast.success(stepLabel(kind, params, before, env.summary, env.last_op));
    } catch (err) {
      console.error("[cleaner] step failed", err);
      toast.error(`Step failed: ${err.message ?? err}`);
    }
  }

  async function callStep(path) {
    try {
      const env = await api.post(path, {});
      consumeUpdate(env);
    } catch (err) {
      console.error("[cleaner] step failed", err);
      toast.error(err.message ?? String(err));
    }
  }

  function consumeUpdate(env) {
    summary = env.summary;
    columns = env.columns ?? [];
    steps   = env.steps ?? [];
    renderMeta(summary);
    renderActions();
    sidebar.update({ summary, columns, steps, rid, getFilter: () => table?.getFilter?.() });
    // Columns may have changed → push them into the redtable and refresh
    // both sidebars so the filter panel reflects the new column list.
    table?.setColumns(columns);
    filters.update({ table, columns, rid });
  }

  // Sidebar tools dispatch unique action shapes. The cleaner is the
  // single place that knows how to translate each into an HTTP call.
  async function dispatchTool(req) {
    if (!rid) return;
    try {
      if (req.tool === "encoding") {
        const env = await api.post(`/files/${encodeURIComponent(rid)}/encoding`, { encoding: req.encoding });
        consumeUpdate(env);
        toast.success(`Encoding set to ${req.encoding}`);
        return;
      }
      // Generic step dispatch — most tools land here.
      if (req.tool === "step") {
        if (!req.kind) return;
        await applyStep(req.kind, req.params ?? {});
        return;
      }
      console.warn("[cleaner] unknown tool action", req);
    } catch (err) {
      console.error("[cleaner] tool action failed", req, err);
      toast.error(err.message ?? String(err));
    }
  }

  function stepLabel(kind, params, before, after, lastOp) {
    const rowDelta = (before?.row_count ?? 0) - (after?.row_count ?? 0);
    const colDelta = (before?.col_count ?? 0) - (after?.col_count ?? 0);
    const colDeltaAbs = Math.abs(colDelta);
    const cells = lastOp?.cells_changed;
    const plural = (n, s) => `${n.toLocaleString()} ${s}${n === 1 ? "" : "s"}`;
    switch (kind) {
      case "drop_columns":        return `Dropped ${plural(colDelta, "column")}`;
      case "filter_columns":      return `Kept ${after?.col_count ?? "?"} column${after?.col_count === 1 ? "" : "s"}, dropped ${colDelta}`;
      case "rename_column":       return `Renamed ${params.from} → ${params.to}`;
      case "drop_rows":           return `Dropped ${plural(rowDelta, "row")}`;
      case "drop_nulls":          return params.cols?.length
        ? `Dropped ${plural(rowDelta, "row")} with null in ${params.cols.join(", ")}`
        : `Dropped ${plural(rowDelta, "row")} with any null`;
      case "fill_nulls":          return cells != null
        ? `Filled ${plural(cells, "null")} (${params.strategy})${params.column ? ` in ${params.column}` : " across all columns"}`
        : `Filled nulls (${params.strategy})${params.column ? ` in ${params.column}` : " across all columns"}`;
      case "cast":                return `Cast ${params.column} → ${params.dtype}`;
      case "snake_case_columns":  return `Snake_cased headers`;
      case "replace_in_names":    return `Replaced "${params.find}" in headers`;
      case "change_case":         return cells != null
        ? `${params.mode}cased ${plural(cells, "cell")}`
        : `${params.mode}cased all string cells`;
      case "replace_text": {
        const verb = params.replace ? `Replaced "${params.find}" → "${params.replace}"` : `Removed "${params.find}"`;
        return cells != null
          ? `${verb} in ${plural(cells, "cell")} of ${params.column}`
          : `${verb} in ${params.column}`;
      }
      case "fix_invalid": {
        const verb = params.replacement != null && params.replacement !== ""
          ? `Replaced "${params.sentinel}" with "${params.replacement}"`
          : `Nulled "${params.sentinel}"`;
        return cells != null
          ? `${verb} in ${plural(cells, "cell")} of ${params.column}`
          : `${verb} in ${params.column}`;
      }
      case "join_columns":        return `Joined ${params.col1} + ${params.col2} → 1 column (-${colDeltaAbs} sources)`;
      case "split_column":        return `Split ${params.column} into ${Math.max(1, -colDelta + (params.keep_original ? 0 : 1))} columns`;
      case "format_dates":        return `Formatted ${params.column} as ${params.fmt}${rowDelta > 0 ? `, dropped ${rowDelta} unparseable` : ""}`;
      default:                    return `Applied ${kind}`;
    }
  }

  // Open file referenced in the URL on first mount, or render the
  // project's file list if only ?project= is provided. The list is a
  // simple troubleshooting view — filename + counts + Open link.
  const fileMatch    = location.hash.match(/[?&]file=([^&]+)/);
  const projectMatch = location.hash.match(/[?&]project=([^&]+)/);
  if (fileMatch) {
    openByRid(decodeURIComponent(fileMatch[1]));
  } else if (projectMatch) {
    renderProjectFiles(decodeURIComponent(projectMatch[1]));
  }

  async function renderProjectFiles(projectRid) {
    const host = root.querySelector("#cleaner-project-files");
    if (!host) return;
    host.hidden = false;
    host.innerHTML = `<p class="rp-muted">Loading files…</p>`;
    try {
      const res = await api.get(`/projects/${encodeURIComponent(projectRid)}/files`);
      if (!res.items?.length) {
        host.innerHTML = `<p class="rp-muted">No files in this project yet. Upload one above.</p>`;
        return;
      }
      host.innerHTML = `
        <h2>Files in this project</h2>
        <table class="rp-project-files">
          <thead><tr>
            <th>Name</th><th>Rows</th><th>Cols</th><th>Encoding</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>
            ${res.items.map((f) => `
              <tr>
                <td>${escapeHtml(f.display_name ?? f.filename)}</td>
                <td class="rp-num">${f.row_count?.toLocaleString() ?? "?"}</td>
                <td class="rp-num">${f.col_count ?? "?"}</td>
                <td>${escapeHtml(f.encoding ?? "?")}</td>
                <td>${escapeHtml(new Date(f.created_at).toLocaleString())}</td>
                <td><a class="rp-btn rp-btn--sm" href="#/cleaner?file=${encodeURIComponent(f.redpash_id)}">Open</a></td>
              </tr>`).join("")}
          </tbody>
        </table>`;
    } catch (err) {
      console.error("[cleaner] project files fetch failed", err);
      host.innerHTML = `<p class="rp-muted">Couldn't load project files: ${escapeHtml(err.message ?? String(err))}</p>`;
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
