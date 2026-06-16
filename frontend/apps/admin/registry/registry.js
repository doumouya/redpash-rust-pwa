/* admin/registry — the Data Registry. A thin instance of the generic object-list
   page over the postgres REGISTRY types (Files, Projects): the server-driven rail
   (GET /api/rail/registry) supplies the type tabs, and mountObjectList renders the
   selected type's table + filter + delete with zero per-type code.

   The redundancy layer made visible: customer DATA stays client-side ("not on our
   servers"); the registry — project ids, file ids, metadata — lives in postgres so
   structure survives if the client copy is lost. This page browses that store. */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountObjectList } from "../../../framework/object-list/object-list.js";

export default async function mount(root, ctx) {
  let objList = null;

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "registry",
    title: "Data Registry",
    // The rail's type tabs come from the server (GET /api/rail/registry — file +
    // project). Selecting one re-renders the generic list; "file" leads (it's the
    // one we clean up most). Same wiring as org.js.
    rail: {
      active: "file",
      onRailTab: (tab) => {
        if (tab?.kind !== "type") return;
        page.rail?.setActive(tab.id);
        objList?.update({ type: tab.id });
      },
    },
    sections: [{ key: "main" }],
  });

  objList = mountObjectList(page.section("main"), { type: "file" });

  return {
    destroy: () => {
      objList?.destroy();
      page.destroy();
    },
  };
}
