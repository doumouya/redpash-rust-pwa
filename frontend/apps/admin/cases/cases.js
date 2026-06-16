/* admin/cases — Cases, Phase A. A thin instance of the generic object-list over
   the `case` type: browse · filter · search · select · delete the cases agents
   file (today via the MCP, tomorrow the dedicated /api/cases routes).

   Create + inline edit are SUPPRESSED here (cfg.source — the same lever the
   Overview uses for its read-only /files view): cases are born from agents, and
   a create FORM needs the `case` type_fields seed. The kanban board, the
   workflow-aware drag, the detail drawer + comments + activity arrive in Phase
   B/C on the dedicated /api/cases contract.

   Rail: the server descriptor (GET /api/rail/cases) supplies the workflow STAGES
   as tabs (the internal kanban columns — All · Backlog · … · Done); clicking one
   scopes the table to that status, client-side, via the object-list filter. */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountObjectList } from "../../../framework/object-list/object-list.js";

/* The `case` type has no type_fields seed yet, so name the display columns
   explicitly (cfg.columns). Keys match the `cases` table; assignee resolves to a
   user id for now (Phase C resolves names in the detail drawer). */
const CASE_COLUMNS = [
  { key: "title", label: "Title" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
  { key: "assignee_id", label: "Assignee" },
  { key: "created_at", label: "Created" },
];

/* A rail stage tab → the FilterNode the object-list scopes by. "all" clears it. */
function stageFilter(status) {
  if (!status || status === "all") return null;
  return { node: "group", op: "and", children: [{ node: "pred", col: "status", op: "eq", value: status }] };
}

export default async function mount(root, ctx) {
  let objList = null;

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "cases",
    title: "Cases",
    // The rail's stage tabs come from the server (GET /api/rail/cases). Selecting
    // one scopes the table to that status (or clears for "all").
    rail: {
      active: "all",
      onRailTab: (tab) => {
        if (tab?.kind !== "section") return;
        page.rail?.setActive(tab.id);
        objList?.update({ filter: stageFilter(tab.id) });
      },
    },
    sections: [{ key: "main" }],
  });

  // source:"/objects/case" IS the canonical endpoint — naming it explicitly makes
  // this instance browse + filter + delete only (create/edit gate on !cfg.source).
  objList = mountObjectList(page.section("main"), {
    type: "case",
    source: "/objects/case",
    columns: CASE_COLUMNS,
  });

  return {
    destroy: () => {
      objList?.destroy();
      page.destroy();
    },
  };
}
