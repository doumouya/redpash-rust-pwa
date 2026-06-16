/* settings — RENDERED FROM THE `preference` TYPE, never hand-written. The pref
   definitions are the fields of the builtin `preference` type (served by
   /api/types); this page reads the user-scope fields, groups them, and renders
   the generic settings-form. A pref added to the type_fields seed appears here
   with zero edits to this file — the third-framework promise, now server-sourced.
   Values resolve + persist through the settings cascade (getPref/setPref). The
   server-driven rail (GET /api/rail/settings) lists the pref groups; clicking
   one scrolls to its section. */

import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountSettingsForm } from "../../../framework/settings-form/settings-form.js";
import { prefDefs, getPref, setPref } from "../../../framework/registry/pref-registry.js";
import { toast } from "../../../framework/toast/toast.js";

export default async function mount(root, ctx) {
  const defs = await prefDefs("user");
  let form = null;

  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "settings",
    title: "Settings",
    meta: "changes apply immediately",
    // The rail (server-driven) lists the pref groups; clicking scrolls to one.
    rail: {
      onRailTab: (tab) => {
        if (tab?.kind !== "prefgroup") return;
        form?.el.querySelector(`[data-group="${tab.id}"]`)?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      },
    },
    sections: [{ key: "form" }],
  });

  form = mountSettingsForm(page.section("form"), {
    defs,
    get: getPref,
    set: (key, value) => {
      setPref(key, value);
      toast({ message: "Saved" });
    },
  });

  return { destroy: () => page.destroy() };
}
