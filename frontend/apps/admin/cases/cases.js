/* admin/cases — Cases. Two views over one surface section (full record view,
   surface swap):
     - LIST  — the generic object-list over the `case` type (browse · filter ·
               search · select · delete); a row click opens the detail.
     - DETAIL — the case record + comment thread (case-detail.js), opened on
               row click; "Back" returns to the (filtered) list.
   The server rail (GET /api/rail/cases) supplies the workflow STAGE tabs (the
   internal kanban columns — All · Backlog · … · Done); clicking one scopes the
   list to that status (client-side) and returns from the detail if needed.

   Create + inline edit stay SUPPRESSED in the list (cfg.source — cases are born
   from agents). Status-change / inline-edit / attachment upload / the kanban
   board are later slices on the ready /api/cases backend. */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountObjectList } from "../../../framework/object-list/object-list.js";
import { mountCaseDetail } from "./case-detail.js";

/* The `case` type has no type_fields seed yet, so name the display columns
   explicitly. Keys match the `cases` table; assignee resolves to a user id for
   now (the detail resolves names in a later slice). */
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
  let page = null;
  let view = null;      // the current view handle (object-list OR case-detail)
  let objList = null;   // set ONLY while the list view is mounted (else null)
  let activeStage = "all";

  const destroyView = () => { view?.destroy?.(); view = null; objList = null; };

  function renderList() {
    destroyView();
    const main = page.section("main");
    main.replaceChildren();
    // source:"/objects/case" makes this instance browse + filter + delete only
    // (create/edit gate on !cfg.source); onOpen routes a row click to the detail.
    objList = mountObjectList(main, {
      type: "case",
      source: "/objects/case",
      columns: CASE_COLUMNS,
      onOpen: (row) => renderDetail(row.rid),
    });
    objList.update({ filter: stageFilter(activeStage) });
    view = objList;
  }

  function renderDetail(rid) {
    destroyView();
    const main = page.section("main");
    main.replaceChildren();
    view = mountCaseDetail(main, { rid, onBack: () => renderList() });
  }

  page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "cases",
    title: "Cases",
    // The rail's stage tabs (GET /api/rail/cases). A click scopes the list to
    // that status; from the detail it returns to the (filtered) list.
    rail: {
      active: "all",
      onRailTab: (tab) => {
        if (tab?.kind !== "section") return;
        page.rail?.setActive(tab.id);
        activeStage = tab.id;
        if (objList) objList.update({ filter: stageFilter(activeStage) }); // already listing → just filter (no re-fetch)
        else renderList();                                                 // coming from the detail → render the filtered list
      },
    },
    sections: [{ key: "main" }],
  });

  renderList();

  return { destroy: () => { destroyView(); page.destroy(); } };
}
