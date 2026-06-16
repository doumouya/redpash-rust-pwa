/* toolbar-spec — the Data Cleaner's toolbar as DATA. `mainToolbar(state)` returns
   the grid-toolbar control list; reading this function IS reading the toolbar.
   The orchestrator (workspace.js) supplies `state` and handles onAction(id, ctx).
   Gates (`when`/`active`/`visible`/`label`) are functions of state, re-evaluated
   by grid-toolbar on update; menu items (rows/cols checkmarks) are re-derived by
   re-calling this on the relevant state change.

   ORDER is Em's spec:
     upload · filter · search · edit/select/delete · undo/redo · refresh ·
     row-numbers · rows-per-page · columns · download · history · clean-tools
   Four parts aren't built yet (filter, row-numbers, history, clean-tools); their
   slots are marked below and fill in as each composable part lands — no inert
   buttons in the meantime (the redtable's "no no-op affordance" rule). */

export const PAGE_SIZES = [100, 500, 1000, 5000];

export function mainToolbar(state) {
  const cols = state.columns ?? [];
  return [
    // staged-changes commit controls — only present while there are pending (unsaved) steps.
    { kind: "button", id: "save", icon: "bi-save", title: "Save staged changes", when: (s) => s.dirty },
    { kind: "button", id: "discard", icon: "bi-arrow-counterclockwise", title: "Discard staged changes", when: (s) => s.dirty },
    { kind: "button", id: "upload", icon: "bi-upload", title: "Upload a data file" },
    { kind: "toggle", id: "filter", icon: "bi-funnel", title: "Filter", active: (s) => s.hasFilter },
    { kind: "sep" },
    { kind: "search", id: "search", placeholder: "Search loaded rows…", value: state.query ?? "" },
    { kind: "sep" },
    // edit / select / delete — one mode at a time (group exclusivity enforced by
    // the orchestrator via setInteraction; the toggles just report the click).
    { kind: "toggle", id: "edit", icon: "bi-pencil", title: "Edit cells", group: "mode", active: (s) => s.mode === "edit" },
    { kind: "toggle", id: "select", icon: "bi-check2-square", title: "Select rows", group: "mode", active: (s) => s.mode === "select" },
    { kind: "toggle", id: "delete", icon: "bi-trash3", title: "Delete rows", group: "mode", active: (s) => s.mode === "delete" },
    { kind: "sep" },
    { kind: "button", id: "undo", icon: "bi-arrow-return-left", title: "Undo", when: (s) => s.canUndo },
    { kind: "button", id: "redo", icon: "bi-arrow-return-right", title: "Redo", when: (s) => s.canRedo },
    { kind: "sep" },
    { kind: "button", id: "refresh", icon: "bi-arrow-clockwise", title: "Reload rows" },
    { kind: "toggle", id: "rownum", icon: "bi-hash", title: "Row numbers", active: (s) => s.rowNumbers },
    { kind: "sep" },
    { kind: "menu", id: "rows", icon: "bi-list-ol", title: "Rows per page",
      items: PAGE_SIZES.map((n) => ({ id: String(n), label: `${n} rows`, icon: n === state.pageRows ? "bi-check2" : "" })) },
    { kind: "menu", id: "cols", icon: "bi-layout-three-columns", title: "Show / hide columns",
      items: cols.map((c) => ({ id: c.key, label: c.label, icon: c.hidden ? "" : "bi-check2" })) },
    { kind: "chip", id: "clearsel", visible: (s) => s.selectionCount > 0, label: (s) => `${s.selectionCount} selected` },
    { kind: "sep" },
    { kind: "menu", id: "export", icon: "bi-download", title: "Download / export",
      items: [{ id: "csv", label: "CSV" }, { id: "xlsx", label: "Excel" }, { id: "json", label: "JSON" }] },
    { kind: "sep" },
    { kind: "button", id: "sql", icon: "bi-terminal", title: "SQL query" },
    { kind: "button", id: "joins", icon: "bi-intersect", title: "Join files" },
    { kind: "button", id: "report", icon: "bi-bar-chart", title: "Report — group & aggregate" },
    { kind: "button", id: "history", icon: "bi-clock-history", title: "Cleaning steps" },
    { kind: "button", id: "clean", icon: "bi-tools", title: "Clean tools" },
  ];
}
