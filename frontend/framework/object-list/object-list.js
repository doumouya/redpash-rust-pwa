/* object-list — THE generic object-table page body. Given an object type, it
   renders that type's list with zero per-type code: columns + cells DERIVE from
   the type registry, rows from /objects/<type> (reach-scoped), CRUD through the
   generic endpoints + the server field gate. The rail chooses the type;
   update({type}) switches.

   Composes the redtable FAMILY (mountGridView): the SAME data-table toolbar the
   Workspace carries, minus the cleaner-specific parts — search · FILTER (the only
   summonable PANEL) · edit/select/delete modes · refresh · row-numbers ·
   rows-per-page · show/hide columns · download. New only for creatable types;
   browse-only registry types (file/project) get filter+edit+delete, not create —
   unless the page injects its own create flow via `create` (below).
   Items load fully, so filter + search run CLIENT-side over the loaded rows.

   mountObjectList(host, { type, source?, columns?, onOpen?, create? }) -> { el,
   update({type}), current(), destroy }
     source?  — fetch override (default /objects/:type; e.g. /files for Overview)
     columns? — column override (else derived from the type registry)
     onOpen?  — browse-mode row click → onOpen(row) (e.g. open a file)
     create?  — { label, onCreate } — light up the toolbar "+" with a custom
                create flow (the app-wide create affordance) even on a browse-only
                / sourced list; e.g. the Workspace Files overview hosts New project */

import { api } from "../boot/api.js";
import { el } from "../boot/dom.js";
import { mountGridView } from "../grid-view/grid-view.js";
import { mountFilterPanel } from "../filter-panel/filter-panel.js";
import { evalFilter } from "../filter-panel/filter-node.js";
import { mountEmptyState } from "../empty-state/empty-state.js";
import { mountField } from "../field/field.js";
import { openModal, confirmModal } from "../modal/modal.js";
import { input } from "../atoms/atoms.js";
import { toast } from "../toast/toast.js";
import { getTypes } from "../registry/type-registry.js";
import { register } from "../registry/component-registry.js";

const REQUIRED = { user: ["display_name"], company: ["name"], team: ["name", "company_id"] };
/* Read-only registry types: browse · filter · DELETE only — no create AND no inline
   edit (the backend's create + patch guards reject both; they're born via upload /
   the project flow). Mirrors the backend contract. */
const READ_ONLY = new Set(["file", "project"]);
const PAGE_SIZES = [25, 50, 100, 500];
const isEmptyFilter = (node) => !node || (Array.isArray(node?.children) && node.children.length === 0);

/* The toolbar as DATA — the only summonable PANEL is filter. */
function listToolbar(s) {
  const c = [];
  if (s.creatable) c.push({ kind: "button", id: "new", icon: "bi-plus-lg", title: s.createTitle ?? `New ${s.typeLabel}` });
  c.push(
    { kind: "toggle", id: "filter", icon: "bi-funnel", title: "Filter", active: (st) => st.hasFilter },
    { kind: "sep" },
    { kind: "search", id: "search", placeholder: `Search ${s.typeLabelPlural.toLowerCase()}…`, value: s.query ?? "" },
    { kind: "sep" },
    // edit / select / delete — one interaction mode at a time.
    { kind: "toggle", id: "edit", icon: "bi-pencil", title: "Edit cells", group: "mode", active: (st) => st.mode === "edit", when: (st) => st.editable },
    { kind: "toggle", id: "select", icon: "bi-check2-square", title: "Select rows", group: "mode", active: (st) => st.mode === "select" },
    { kind: "toggle", id: "delete", icon: "bi-trash3", title: "Delete rows", group: "mode", active: (st) => st.mode === "delete" },
    { kind: "button", id: "delsel", icon: "bi-trash", title: "Delete selected", when: (st) => st.selectionCount > 0 },
    { kind: "chip", id: "clearsel", visible: (st) => st.selectionCount > 0, label: (st) => `${st.selectionCount} selected` },
    { kind: "sep" },
    { kind: "button", id: "refresh", icon: "bi-arrow-clockwise", title: "Refresh" },
    { kind: "toggle", id: "rownum", icon: "bi-hash", title: "Row numbers", active: (st) => st.rowNumbers },
    { kind: "sep" },
    { kind: "menu", id: "rows", icon: "bi-list-ol", title: "Rows per page",
      items: PAGE_SIZES.map((n) => ({ id: String(n), label: `${n} rows`, icon: n === s.pageRows ? "bi-check2" : "" })) },
    { kind: "menu", id: "cols", icon: "bi-layout-three-columns", title: "Show / hide columns",
      items: (s.columns ?? []).map((col) => ({ id: col.key, label: col.label, icon: col.hidden ? "" : "bi-check2" })) },
    { kind: "menu", id: "export", icon: "bi-download", title: "Download / export", items: [{ id: "csv", label: "CSV" }] },
  );
  return c;
}

export function mountObjectList(host, cfg) {
  const root = el("div", { class: "rp-objlist" });
  host.append(root);

  let current = null; // the type def
  let gridView = null;
  let items = []; // all loaded rows (client-side; not server-paged)
  let query = "";
  let filterNode = null;
  const hiddenCols = new Set();
  let selection = [];
  let mode = "browse"; // browse | edit | select | delete
  let rowNumbers = false;
  let pageRows = 50;
  let seq = 0; // guards rapid type switches racing their fetches

  const labelOf = (t, key) => t.fields.find((f) => f.key === key)?.label ?? key;
  const sourceUrl = () => cfg.source ?? `/objects/${current.type_id}`;

  // Presence on the wire MEANS readable: the server omits fields the caller can't
  // read, so a builtin column every row lacks is hidden access — drop it. A caller
  // override (cfg.columns) wins; custom types are sparse on the wire, so keep all.
  function fields() {
    if (cfg.columns) return cfg.columns;
    const def = current;
    if (!def) return [];
    return def.is_builtin && items.length
      ? def.fields.filter((f) => items.some((r) => f.key in r))
      : def.fields;
  }
  const visibleColumns = () =>
    fields().map((f) => ({ key: f.key, label: f.label ?? f.key })).filter((c) => !hiddenCols.has(c.key));
  function visibleRows() {
    const q = query.trim().toLowerCase();
    const cols = visibleColumns();
    return items.filter((r) => {
      if (filterNode && !evalFilter(filterNode, r)) return false;
      if (q && !cols.some((c) => String(r[c.key] ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function toolbarState() {
    return {
      typeLabel: current?.display_name ?? "object",
      typeLabelPlural: current?.display_name_plural ?? "objects",
      // A page can inject its own create flow (cfg.create = { label, onCreate });
      // the toolbar "+" then fires that instead of the built-in typed-object
      // create, so a browse-only / sourced list (e.g. the Workspace's Files
      // overview) can still host a create action in the canonical place.
      creatable: !!cfg.create || (!!current && !cfg.source && !READ_ONLY.has(current.type_id)),
      createTitle: cfg.create?.label ?? null,
      columns: fields().map((f) => ({ key: f.key, label: f.label ?? f.key, hidden: hiddenCols.has(f.key) })),
      query,
      hasFilter: !!filterNode,
      selectionCount: selection.length,
      mode,
      rowNumbers,
      pageRows,
      editable: !!current && !cfg.source && !READ_ONLY.has(current.type_id), // no edit for read-only types/sources
    };
  }
  function paint() {
    gridView?.update({ columns: visibleColumns(), rows: visibleRows(), state: toolbarState() });
  }
  function refreshToolbar() {
    const s = toolbarState();
    gridView?.toolbar?.update({ state: s, controls: listToolbar(s) });
  }

  // build (or rebuild — e.g. on a rows-per-page change, since pageSize is fixed at
  // mount) the gridView from current state.
  function mountTable() {
    gridView?.destroy();
    const s = toolbarState();
    gridView = mountGridView(root, {
      toolbar: { controls: listToolbar(s), onAction, state: s },
      table: {
        columns: visibleColumns(),
        rows: visibleRows(),
        rowKey: (r) => r.rid,
        mode: "pager",
        pageSize: pageRows,
        interaction: mode,
        rowNumbers,
        onSelectChange: (keys) => { selection = keys; refreshToolbar(); },
        onCellCommit: commitEdit,
        onRowDelete: commitDelete,
        onRowClick: (row) => { if (mode === "browse") cfg.onOpen?.(row); },
        empty: {
          title: current ? `No ${current.display_name_plural.toLowerCase()} yet` : "Nothing here",
          line: current && !READ_ONLY.has(current.type_id) && !cfg.source
            ? `Create the first one with “New ${current.display_name.toLowerCase()}”.`
            : "Nothing to show here.",
        },
      },
    });
  }

  async function defOf(typeId) {
    const all = await getTypes();
    return all.find((t) => t.type_id === typeId) ?? null;
  }

  async function show(typeId) {
    const my = ++seq;
    let def;
    try { def = await defOf(typeId); } catch { def = null; }
    if (my !== seq) return;
    current = def;
    filterNode = null;
    query = "";
    hiddenCols.clear();
    selection = [];
    mode = "browse";
    items = [];
    gridView?.destroy();
    gridView = null;
    root.replaceChildren();

    if (!def) {
      mountEmptyState(root, { title: "Type unavailable", line: "The object catalog did not answer for this type." });
      return;
    }
    try {
      items = (await api.get(sourceUrl())).items ?? [];
    } catch (e) {
      if (my !== seq) return;
      mountEmptyState(root, {
        title: `${def.display_name_plural} unavailable`,
        line: e.message ? `The server said: ${e.message}` : "Could not reach the server.",
      });
      return;
    }
    if (my !== seq) return;
    mountTable();
  }

  // re-fetch + repaint after a mutation, preserving the filter/search view + mode.
  async function reload() {
    if (!current) return;
    try { items = (await api.get(sourceUrl())).items ?? []; } catch { /* keep prior */ }
    selection = [];
    gridView?.table?.clearSelection?.();
    paint();
    refreshToolbar();
  }

  function setMode(next) {
    mode = mode === next ? "browse" : next;
    gridView?.table?.setInteraction(mode);
    if (mode !== "select") { gridView?.table?.clearSelection?.(); selection = []; }
    refreshToolbar();
  }

  function onAction(id, ctx) {
    if (id === "search") { query = ctx?.value ?? ""; paint(); return; }
    if (id === "filter") { openFilter(); return; }
    if (ctx?.menu === "cols") {
      if (hiddenCols.has(id)) hiddenCols.delete(id); else hiddenCols.add(id);
      paint();
      refreshToolbar();
      return;
    }
    if (ctx?.menu === "rows") { pageRows = Number(id); mountTable(); return; }
    if (ctx?.menu === "export") { exportCsv(); return; }
    switch (id) {
      case "new": (cfg.create?.onCreate ?? openCreate)(); return;
      case "edit": case "select": case "delete": setMode(id); return;
      case "delsel": deleteSelected(); return;
      case "clearsel": gridView?.table?.clearSelection?.(); selection = []; refreshToolbar(); return;
      case "refresh": return reload();
      case "rownum": rowNumbers = !rowNumbers; gridView?.table?.update({ rowNumbers }); refreshToolbar(); return;
    }
  }

  function openFilter() {
    const fhost = el("div");
    const modal = openModal({ title: "Filter", body: fhost, actions: [] });
    mountFilterPanel(fhost, {
      columns: fields().map((f) => ({ key: f.key, label: f.label ?? f.key })),
      value: filterNode,
      onApply: (node) => { filterNode = isEmptyFilter(node) ? null : node; paint(); refreshToolbar(); modal.close(); },
      onClear: () => { filterNode = null; paint(); refreshToolbar(); modal.close(); },
    });
  }

  // edit-mode: a committed cell edit → PATCH that field (the server gate enforces
  // per-field editability — we stay permissive and surface its response).
  async function commitEdit(rowKey, colKey, value) {
    const type = current?.type_id;
    if (!type || cfg.source || READ_ONLY.has(type)) return; // read-only types/sources reject patch
    try {
      await api.patch(`/objects/${type}/${rowKey}`, { data: { [colKey]: value } });
    } catch (e) {
      toast({ message: e.message || "Edit failed", tone: "danger" });
      await reload();
    }
  }

  // delete-mode: a clicked row → confirm → delete (single).
  async function commitDelete(rowKey) {
    if (!current) return;
    const t = current;
    const ok = await confirmModal({
      title: `Delete this ${t.display_name.toLowerCase()}?`, message: "This cannot be undone.",
      confirmLabel: "Delete", danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/objects/${t.type_id}/${rowKey}`);
      toast({ message: `${t.display_name} deleted` });
    } catch (e) {
      toast({ message: e.message || "Delete failed", tone: "danger" });
    }
    await reload();
  }

  // select-mode: bulk-delete the current selection (one confirm).
  async function deleteSelected() {
    const selected = gridView?.table?.selection() ?? [];
    if (!selected.length || !current) return;
    const t = current;
    const what = selected.length === 1
      ? `this ${t.display_name.toLowerCase()}`
      : `${selected.length} ${t.display_name_plural.toLowerCase()}`;
    const ok = await confirmModal({ title: `Delete ${what}?`, message: "This cannot be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      for (const rid of selected) await api.del(`/objects/${t.type_id}/${rid}`);
      toast({ message: selected.length === 1 ? `${t.display_name} deleted` : `${selected.length} deleted` });
    } catch (e) {
      toast({ message: e.message || "Delete failed", tone: "danger" });
    }
    await reload();
  }

  function openCreate() {
    const t = current;
    if (!t || cfg.source || READ_ONLY.has(t.type_id)) return;
    const keys = REQUIRED[t.type_id] ?? t.fields.map((f) => f.key);
    const required = REQUIRED[t.type_id] ?? [];
    const values = Object.fromEntries(keys.map((k) => [k, ""]));
    let modal = null;
    async function submit() {
      const missing = required.find((k) => !values[k].trim());
      if (missing) { toast({ message: `${labelOf(t, missing)} is required`, tone: "danger" }); return; }
      try {
        const data = Object.fromEntries(keys.filter((k) => values[k].trim()).map((k) => [k, values[k].trim()]));
        await api.post(`/objects/${t.type_id}`, { data });
        modal?.close();
        toast({ message: `${t.display_name} created` });
        await reload();
      } catch (e) {
        toast({ message: e.message || "Create failed", tone: "danger" });
      }
    }
    const body = el("div", { class: "rp-objlist-form" });
    for (const k of keys) {
      mountField(body, { label: labelOf(t, k), control: input({ onInput: (v) => (values[k] = v), onEnter: () => submit() }) });
    }
    modal = openModal({
      title: `New ${t.display_name.toLowerCase()}`,
      body,
      actions: [
        { label: "Cancel", variant: "ghost", onClick: ({ close }) => close() },
        { label: "Create", variant: "accent", onClick: () => submit() },
      ],
    });
  }

  // download the CURRENT (filtered) view as CSV, client-side — no server endpoint.
  function exportCsv() {
    const cols = visibleColumns();
    const rows = visibleRows();
    const cell = (v) => { const sv = String(v ?? ""); return /[",\n]/.test(sv) ? `"${sv.replace(/"/g, '""')}"` : sv; };
    const csv = [cols.map((c) => cell(c.label)).join(","), ...rows.map((r) => cols.map((c) => cell(r[c.key])).join(","))].join("\n");
    const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: `${current?.display_name_plural ?? "objects"}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (cfg.type) show(cfg.type);

  return {
    el: root,
    // type switch re-shows; an external FilterNode (e.g. a rail status tab) scopes
    // the loaded rows client-side — same filterNode the panel drives, so they stay
    // in sync. `filter:null` clears.
    update: (p = {}) => {
      if (p.type) { show(p.type); return; }
      if ("filter" in p) { filterNode = p.filter || null; paint(); refreshToolbar(); }
    },
    current: () => current?.type_id ?? null,
    destroy: () => { gridView?.destroy(); root.remove(); },
  };
}

register("object-list", mountObjectList);
