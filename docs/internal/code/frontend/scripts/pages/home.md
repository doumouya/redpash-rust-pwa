---
title: frontend/scripts/pages/home.js
source: ../../../../../frontend/scripts/pages/home.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-05
---

# home.js

## Purpose

Home — the org command center. Shell pattern shared with Workspace: topbar + rail (LIST_VIEWS tabs) + body view. Per-tab list-views over Users / Memberships / Files / Companies / Charts / Cases / Projects. Composite-strip + chart cards opt-in per tab.

## Public surface

- Default export: page mount.
- Uses list-page.js for the shared paint path.
- Per-tab specs from pages/home/tabs.js.

## Drift-prone areas

- **Design-language rollout — RAIL migrated to `rp-rail*`; list surface NOT yet (2026-06-05).** The
  rail nav is JS-rendered (`renderGroup`/`renderTab` emit `rp-rail-group*` / `rp-rail-tab*`) and
  queried back (click delegation `closest('.rp-rail-group-head'|'.rp-rail-tab')`, `activate`'s
  `.rp-rail-tab.active` / `[data-key]`, the post-create re-activation query, the footer mount
  `.rp-rail-footer`) — all in lockstep with home.html. Group `.expanded` / tab `.active` stay plain
  (atom contracts). The **list/redtable surface still emits `rt-*`** (`rt-mono-pill`, `rt-table`,
  `rt-mode`, `rt-dd-item`, `rt-hidden*`, `rt-tone--*`, `rt-tab-close`, `rt-spinning`) — those are the
  shared list-page/redtable/toolbar atoms and migrate with THAT lane, not here. home.css's `rt-*`
  selector overrides (toolbar/redtable scoped) stay until then.
- Pattern is LOCKED per pattern-lock-personalization-within; new tabs join via LIST_VIEWS entry.
- Post-fetchList hook order: `_decorateSelectMode` → `_applyColumnOrder` → `_applyHiddenColumns` → `_decorateEditMode`. The drag-reorder MUST land before positional hide indexing (otherwise hide hits the wrong columns) AND before edit-mode decoration (otherwise the spec's `editable: true` flag tags whatever column the user dragged into spec position N instead of the column the spec actually named). See [list-page.js](../list-page.md) for the underlying reorder contract.
- `decorateEditMode` resolves each editable col by its `data-col-key` on the LIVE thead — not by `spec.columns[i]` index — so a user's drag-reorder doesn't make the wrong cell editable.
- **Cell-editor extracted to the framework (CAS_8A210C7A, 2026-06-01).** `decorateEditMode` + `saveCellEdit` are now thin wrappers around [`cellEditor.decorate` + `cellEditor.save`](../framework/cell-editor.md) from `/scripts/framework/cell-editor.js`. The strip + activate dispatch + PATCH live in the framework; this page keeps page-specific state (`editHistory` / `editFuture` / `actionLog` / `updateUndoRedoButtons` / `chipRenderFor`). `chipRenderFor` passes through as a `chipRender` ctx callback until the chip vocabulary moves into `framework/chip-registry.js` per CAS_BF208AA8. Behavior is unchanged — the wrappers preserve the existing closure semantics (CAS_A5A4… data-full / CAS_E97414… chip-enum / CAS_D78667D1 per-column editEndpoint).
- Which columns carry `editable: true` lives in each tab's LIST_VIEWS spec (lines ~287+ for Users etc.). The flag is only safe on TDs whose row template renders **plain text with no chip/pill markup**. Chip-wrapped cols would let contenteditable clobber the chip styling on save (deferred — needs the chip-cell-editor slice).
- **Data-full pattern for derived-display cols** (Cases `description` / `error_message`, Projects `description`, Users `username` with `@` prefix, any future `.slice()`-truncated or prefix-decorated TD that wants to be editable): the row template MUST carry `data-full="<source-of-truth>"` on the TD plus zero or more render rules. Today's render rules:
  - `data-trunc="<N>"` — `slice(0, N) || "—"` truncation ([runbook 0010](../../../runbooks/CAS_A5A432F1A82A4A4DB0B62C0085C4428C-cell-editor-data-full-pattern.md))
  - `data-prefix="<s>"` — `(prefix + full) || "—"` decoration ([runbook 0012](../../../runbooks/CAS_E97414C482AB431FA28D43392501F47B-cell-editor-data-prefix-and-chip-enum.md))

  `decorateEditMode` strips the rules on edit-on (textContent = bare `data-full`) and re-applies them on edit-off (textContent = composed display). `saveCellEdit` updates `data-full` after a successful PATCH so subsequent edits + the re-render read the fresh source. The mental model: `data-full` is the model, `textContent` is the view, render rules compose.
- **Memberships create modal** (createSpec) supports all 4 scopes — `project`, `company`, `case`, `team`. Two select fields are per-scope:
  - `role` — RBAC-tier grant (project/case: `viewer` / `member` / `owner`; company/team: `member` / `admin` / `owner`); allow-list per scope.
  - `context_role` — entity-context job title (Reporter on a case, CEO on a company, Data Analyst on a project, Team Lead on a team); allow-list per scope. Optional — "— none —" lets a user be a plain RBAC-tier member with no entity-context label, persisted as `""` at the DB.
  - Both lists mirror `routes/admin.rs` allow-lists exactly — drift = 400 from the validator. The entity-picker for `scope_id` uses `labelKeyFn(state)` (cases → `title`, projects/companies/teams → `name`) since the rest field names differ; endpoint also swaps per scope (`/admin/companies`, `/cases`, `/admin/teams`, `/projects`).
- **Teams tab** (LIST_VIEWS.teams) — column set Name / Kind / Company / Members / My role / Created / ID. createSpec needs `name` + a `company_id` entity-picker on `/admin/companies` (`teams.company_id` is NOT NULL at the schema layer) + a `kind` select (team / department, default team — keeps FE in sync with the backend allowlist; drift = 400 from `teams.rs::create`). The Kind column renders via the `teamKindChip` chip helper (added to `chipRenderFor` dispatcher for future chip-enum editing). Backed by [/admin/teams](../../../../backend/api/routes/admin.md) + [/api/teams](../../../../backend/api/routes/teams.md).
- **Platform-role chip-enum editor (2026-05-31 CAS_D78667D1 opt b FE follow-up):** Users tab's Platform column is now chip-enum editable for platform admins only. New spec fields generalized through the cell-editor framework: `col.requiresAdmin` (boolean — `decorateEditMode` skips the cell when `!isPlatformAdmin`, so non-admins never see an editor that would 404 server-side) and `col.editEndpoint` (per-column endpoint override — Platform PATCHes the gated `/admin/users/:rid` from the other Torv's commit 33b79d2 instead of the Users tab's default `/users` patch path). `isPlatformAdmin` is resolved once at mount via `api.get("/me")` and cached for the page's lifetime. The Platform row TD now carries `data-full="<role>"` so chip-enum can read/restore via the standard pattern. Backend last-admin guard returns 409 `last_admin` if the only admin tries to demote — the FE alert surfaces it.
- **Org + org-role editable on the Users tab (2026-06-01, Em request):** the two membership-derived columns are now editable for platform admins (`requiresAdmin`), both PATCHing the extended `/admin/users/:rid` ([admin.md](../../../../backend/api/routes/admin.md)) via `editEndpoint`:
  - **Org Role** — `editor: "chip-enum"`, `options: ["owner","admin","member"]` (matches backend `COMPANY_ROLES`, no viewer), `render: "roleChip"`, `editKey: "org_role"`. The TD carries `data-full="<org_role>"`. Updates the user's primary company membership role server-side.
  - **Org** — `editor: "entity-picker"`, `rel: { type: "company" }`, `editKey: "org_id"`. The TD carries `data-full="<org_id>"` (the rid we PATCH) + `data-label="<org_name>"` (display + picker pre-fill). Picking a company resolves name→rid; the backend sets/swaps the user's primary membership. This is the **first real consumer** of [editor-entity-picker.js](../framework/editor-entity-picker.md) — its company-datalist wiring landed here per [[build-ready-dont-wire]].
- **Strand 2 modal field-coverage adds (2026-05-31 CAS_B846F28C):** Projects modal gains an optional `company_id` entity-picker on `/admin/companies` (empty = personal project — `CreateProjectBody.company_id` is `Option<String>`, unchanged backend); Users modal gains `avatar_url` (URL input — backend `CreateUserBody` + `db::insert_user` widened); Companies modal gains `avatar_url` (URL input — backend `CreateCompanyBody` + `db::create_company` widened). Avatar URL fields are pure pass-through to existing PATCH-side fields, so editing later "just works" via the cell-editor.
- **Cases tab chip-enum editable cols (2026-05-31 strand 1 of CAS_B846F28C):** Type / Status / Priority all carry `editable: true + editor: "chip-enum" + options + render`. Allow-lists mirror the backend validator at `routes/cases.rs:303-313` exactly — drift = 400 from the PATCH validator. The row template wraps each chip in a TD with `data-full="<source-of-truth>"` so `decorateEditMode` can read/restore on edit-mode toggle. Type uses the `caseTypeChip` helper (plain rt-mono-pill, no tone — visual budget stays on Status + Priority).
- **`editor: "chip-enum"` for finite-enum cols** (Users `plan` shipped 2026-05-31; future Cases `status` / `priority` / `type`, Memberships `role`, Projects `status`, Files `stage`): spec entry declares `editor: "chip-enum"`, `options: [...]`, `render: "<chipFunctionName>"`. `decorateEditMode` swaps the chip span for a `<select>` (built via `createElement`/`appendChild`, not innerHTML) on edit-on, restores the chip via `chipRenderFor(spec.render)(data-full)` on edit-off. `saveCellEdit` reads from `select.value` if a `select.rp-cell-edit-select` is present. New chip families add their renderer to the `chipRenderFor` dispatcher. The `change` event fires save immediately so picking an option lands the PATCH without waiting for blur. See [runbook 0012](../../../runbooks/CAS_E97414C482AB431FA28D43392501F47B-cell-editor-data-prefix-and-chip-enum.md).

## Related

- [Frontend pillar landing](../../../index.md)
