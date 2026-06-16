/* admin/console — the platform's policy surface. Three sections, all DERIVED:
   (a) App visibility — the STORED role-scope values of app.<id>.enabled (the
       launcher resolves per-caller; this matrix edits what roles inherit),
       read per cell from /api/settings/role/… (404 = unset → default true)
       and written via setPolicy("role", …).
   (b) Objects & fields — per-tier field access from /api/types; clicking a
       cell cycles none → r → rw and writes the sparse override
       (PUT /api/admin/fields), then re-derives from a fresh catalog.
   (c) Policies — settings-form over the policy registry, platform scope.
   The app kill-switch policies are REGISTERED here at module load. */

import { api } from "../../../framework/boot/api.js";
import { el } from "../../../framework/boot/dom.js";
import { APPS } from "../../../framework/boot/apps.js";
import { assemblePage } from "../../../framework/page-assembly/page-assembly.js";
import { mountChipRow } from "../../../framework/chip-row/chip-row.js";
import { mountField } from "../../../framework/field/field.js";
import { mountPermCell } from "../../../framework/perm-cell/perm-cell.js";
import { mountSettingsForm } from "../../../framework/settings-form/settings-form.js";
import { mountEmptyState } from "../../../framework/empty-state/empty-state.js";
import { toast } from "../../../framework/toast/toast.js";
import { getTypes, invalidate } from "../../../framework/registry/type-registry.js";
import { prefDefs, getPref, setPolicy } from "../../../framework/registry/pref-registry.js";

const ROLES = ["user", "admin"]; // platform roles the visibility matrix manages
const TIERS = ["owner", "admin", "member", "viewer"]; // per-object rbac tiers
const VISIBLE_APPS = APPS.filter((a) => !a.hidden); // home · studio · admin

// The app kill-switch policies are now the platform-scope fields of the
// `preference` type (served by /api/types) — no client registration; the
// Policies section reads them via prefDefs("platform").

/* GET the STORED role-scope value; 404 means unset → undefined (default). */
async function storedRoleValue(role, key) {
  try {
    const d = await api.get(`/settings/role/${role}/${key}`);
    return d && typeof d === "object" && "value" in d ? d.value : d;
  } catch (e) {
    if (e.status === 404) return undefined;
    throw e;
  }
}

export default async function mount(root, ctx) {
  const page = assemblePage(root, {
    session: ctx.getSession(),
    activePageId: "console",
    title: "Console",
    meta: "policies apply to everyone — change carefully",
    // The server-driven rail (GET /api/rail/console) lists the Console's
    // sections; clicking one scrolls the surface to it.
    rail: {
      onRailTab: (tab) => {
        if (tab?.kind !== "section") return;
        // section() hands back the section body; its parent is the <section>
        // wrapper (incl. the heading) — scroll to that, without naming a
        // framework class (ui-fork-audit R8).
        const body = page.section(tab.id);
        (body?.parentElement ?? body)?.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    },
    sections: [
      { key: "visibility", title: "App visibility" },
      { key: "fields", title: "Objects & fields" },
      { key: "policies", title: "Policies" },
    ],
  });

  /* ── (a) app visibility: role × app toggles over STORED role values ── */
  const vis = page.section("visibility");
  for (const role of ROLES) {
    const row = el(
      "div",
      { class: "pg-admin-console-visrow" },
      el("span", { class: "pg-admin-console-visrole" }, role)
    );
    vis.append(row);
    for (const app of VISIBLE_APPS) {
      const key = `app.${app.id}.enabled`;
      const box = el("input", { type: "checkbox" });
      box.checked = true; // the default until the stored value answers
      box.disabled = true;
      storedRoleValue(role, key)
        .then((v) => (box.checked = v !== false))
        .catch(() => {}) // unreadable → keep the default; writing still works
        .finally(() => (box.disabled = false));
      box.addEventListener("change", async () => {
        try {
          await setPolicy("role", role, key, box.checked);
          toast({ message: `${app.name} ${box.checked ? "enabled" : "disabled"} for ${role}s` });
        } catch (e) {
          box.checked = !box.checked; // revert — the server said no
          toast({ message: e.message || "Save failed", tone: "danger" });
        }
      });
      mountField(row, { label: app.name, inline: true, bare: true, control: box });
    }
  }

  /* ── (b) objects & fields: the per-tier field matrix ── */
  const fieldsHost = page.section("fields");
  const matrixWrap = el("div", { class: "pg-admin-console-matrixwrap" });
  let seq = 0; // guards rapid chip switches racing their fetches

  async function renderMatrix(typeId) {
    const my = ++seq;
    let t = null;
    try {
      t = (await getTypes()).find((x) => x.type_id === typeId) ?? null;
    } catch {
      t = null;
    }
    if (my !== seq) return;
    matrixWrap.replaceChildren();
    if (!t) {
      mountEmptyState(matrixWrap, {
        title: "Types unavailable",
        line: "The object catalog did not answer — field access cannot be shown.",
      });
      return;
    }
    if (!t.is_builtin) {
      matrixWrap.append(
        el(
          "p",
          { class: "pg-admin-console-note" },
          "Stored now — enforced once custom types gain their field gate."
        )
      );
    }
    const grid = el("div", { class: "pg-admin-console-matrix" });
    grid.append(
      el("span", { class: "pg-admin-console-mhead" }, "Field"),
      ...TIERS.map((tier) =>
        el("span", { class: "pg-admin-console-mhead pg-admin-console-mcell" }, tier)
      )
    );
    for (const f of t.fields) {
      grid.append(el("span", { class: "pg-admin-console-mfield" }, f.label ?? f.key));
      for (const tier of TIERS) {
        const hostCell = el("span", { class: "pg-admin-console-mcell" });
        const cell = mountPermCell(hostCell, {
          value: f.cells?.[tier] ?? "",
          onChange: async (next) => {
            try {
              await api.put("/admin/fields", {
                type_id: t.type_id,
                field: f.key,
                role: tier,
                can_read: next !== "",
                can_write: next === "rw",
              });
              invalidate(); // catalog changed — re-derive, never patch locally
              toast({ message: `${f.label ?? f.key} · ${tier} → ${next || "none"}` });
              await renderMatrix(t.type_id);
            } catch (e) {
              cell.update({ value: f.cells?.[tier] ?? "" });
              toast({ message: e.message || "Save failed", tone: "danger" });
            }
          },
        });
        grid.append(hostCell);
      }
    }
    matrixWrap.append(grid);
  }

  let catalog = [];
  try {
    // Only OBJECT types with a field catalog belong in the matrix — exclude
    // `preference` (its fields are user prefs, not RBAC-governed object fields).
    catalog = (await getTypes()).filter((t) => t.fields.length && t.type_id !== "preference");
  } catch {
    catalog = [];
  }
  if (catalog.length) {
    mountChipRow(fieldsHost, {
      items: catalog.map((t) => ({ value: t.type_id, label: t.display_name })),
      value: catalog[0].type_id,
      onChange: (id) => renderMatrix(id),
    });
    fieldsHost.append(matrixWrap);
    await renderMatrix(catalog[0].type_id);
  } else {
    mountEmptyState(fieldsHost, {
      title: "Types unavailable",
      line: "The object catalog did not answer — field access cannot be shown.",
    });
  }

  /* ── (c) policies: the `preference` type's platform-scope fields (the
        app.*.enabled kill-switches), rendered via the same settings-form. ── */
  mountSettingsForm(page.section("policies"), {
    defs: await prefDefs("platform"),
    get: getPref,
    set: (key, value) => {
      setPolicy("platform", "", key, value)
        .then(() => toast({ message: "Saved" }))
        .catch((e) => toast({ message: e.message || "Save failed", tone: "danger" }));
    },
  });

  return { destroy: () => page.destroy() };
}
