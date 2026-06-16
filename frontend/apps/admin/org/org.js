/* admin/org — organization CRUD. Now a THIN instance of the generic
   object-list page: the server-driven rail (GET /api/rail/org) supplies the
   object-type tabs (Users / Companies / Teams / custom), and mountObjectList
   renders the selected type's table + create/delete with zero per-type code.
   A freshly-seeded custom type appears as a rail tab AND gets a working list
   page, no source change (the S7 invariant). */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountObjectList } from "../../../framework/object-list/object-list.js";

export default async function mount(root, ctx) {
  let objList = null;

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "org",
    title: "Organization",
    // The rail's type tabs come from the server (OrgDynamic). Selecting one
    // re-renders the generic list for that type; "user" leads the list.
    rail: {
      active: "user",
      onRailTab: (tab) => {
        if (tab?.kind !== "type") return;
        page.rail?.setActive(tab.id);
        objList?.update({ type: tab.id });
      },
    },
    sections: [{ key: "main" }],
  });

  objList = mountObjectList(page.section("main"), { type: "user" });

  return {
    destroy: () => {
      objList?.destroy();
      page.destroy();
    },
  };
}
