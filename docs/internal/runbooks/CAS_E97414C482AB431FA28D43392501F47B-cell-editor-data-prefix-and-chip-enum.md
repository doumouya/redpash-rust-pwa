---
title: 0012 — Cell-editor extensions — data-prefix render rule + chip-enum select-overlay editor
section: Internal
order: 12
last modified date: 2026-05-31
case_id: CAS_E97414C482AB431FA28D43392501F47B
status: resolved
---

# 0012 — Cell-editor extensions — data-prefix render rule + chip-enum select-overlay editor

**Date:** 2026-05-31 · **Area:** `frontend/scripts/pages/home.js` (row template + `decorateEditMode` + `saveCellEdit` + editor event handlers) · **Status:** resolved · **Case:** `CAS_E97414C482AB431FA28D43392501F47B`

## Problem Statement

Em 2026-05-31: *"back to our editable fields on Home. handle, role, name, plan, org, should be editable" → "for Users".* Audit (earlier commit `71e8c05`'s body + the workflow `wik561ah7` synthesis from earlier today) had already established that the easy spec-flag-flip wins on Users were exhausted; reaching the next 3 of Em's 5 (handle + name + plan) required two extensions to the cell-editor contract that landed in `CAS_A5A4…` (the data-full pattern), plus a row-template restructure for Name.

Why each blocker matters concretely:

- **Handle (`username`)** — row template renders `<td class="rp-meta">@${esc(username)}</td>`. Naively flagging it editable would let the user edit `@sam-rivera`. `saveCellEdit` reads `td.textContent.trim()` and PATCHes that, so the backend would receive `@sam-rivera` — wrong by exactly one `@`. The discipline rule on the `data-full` pattern from CAS_A5A4… already accounts for "display value derived from source-of-truth via a render rule"; we just need a *new* render rule (`data-prefix`) alongside the existing `data-trunc`.
- **Name (`display_name`)** — row template's NAME TD is `<td><span class="rp-home-user-display">${display_name}</span> <span class="rp-home-handle">@${username}</span></td>`. `contenteditable=plaintext-only` on the TD lets the user edit *both* the display name and the handle suffix in one cell, but `saveCellEdit` only sends `display_name`. The handle suffix would visually persist as whatever the user typed until the next fetchList paint — stale display, silent confusion. Fix: drop the handle suffix from the NAME TD and let the HANDLE column (already a separate spec entry, `defaultHidden: true`) carry that surface.
- **Plan (`plan`)** — `<td>${planChip(u.plan)}</td>` chip span. `contenteditable=plaintext-only` strips the chip styling and lets the user type any string. The right shape is a finite enum, not free-text — so a `<select>` overlay is the proper editor, not contenteditable.

## Troubleshooting steps

1. **Confirm `PatchUserBody` accepts each field.** `display_name`, `username`, and `plan` all land in the backend's user PATCH body (`backend/crates/api/src/routes/users.rs:97-109`). Backend ready — every gap is frontend-side.
2. **Map each blocker onto the existing cell-editor contract.** Handle's `@` prefix is the same *display-derived-from-source* shape as the truncation case from `CAS_A5A4…` — both need an explicit `data-full` source plus a render rule for going back to display form on edit-off. Plan's chip is a *different editor type* — not `contenteditable`, a `<select>` swap.
3. **Sketch the render-rule contract extension.** `data-full` holds source-of-truth. The strip path computes display via render rules:
   - `data-trunc="<N>"` (existing) → `full.slice(0, N) || "—"`
   - `data-prefix="<s>"` (new) → `(prefix + full) || "—"`
   - Future: `data-suffix`, `data-format=currency`, `data-render=chipName` (chip-enum reuses the third)
   Both rules default to `"—"` when `data-full` is empty so the cell doesn't render an orphaned `@` for users without usernames.
4. **Sketch the chip-enum editor.** The decorator path branches:
   - `col.editor === "chip-enum"` → replace TD content with `<select>` populated from `col.options`, current value from `data-full` pre-selected. Don't set `contenteditable`. Add `.editable` + `data-edit-key` so the existing focusin/focusout listeners still find the cell.
   - Otherwise → existing contenteditable path.
   `saveCellEdit` branches on `td.querySelector("select.rp-cell-edit-select")`: read `select.value` instead of `td.textContent.trim()`.
   Plus a `change` listener: `<select>` value changes fire `saveCellEdit` immediately so the user doesn't have to blur the cell for the PATCH to land.
5. **Live smoke-test in Playwright** — login → Users → enable Handle column via picker → toggle edit-on → for each of the 3 cells verify the editor state (contenteditable / `<select>`), simulate an edit, confirm PATCH landed at the backend, toggle edit-off, verify display restored.

## RCA

The shared theme across both editor-contract extensions: **TD content is the user's *view*, not the data layer's source-of-truth.** When display is derived (truncation, prefix decoration, chip styling, formatted dates), the editor needs an explicit source-of-truth handle on the DOM that survives the round-trip through edit-mode. `data-full` was the handle CAS_A5A4… established; today's slice generalises the *rendering rules* layer on top.

The pre-fix mistake class: assuming `td.textContent` *was* the value. It's never the value when display is derived. The right framing: **`data-full` is the model; `textContent` is the view; render rules compose the view from the model.** That model-view split is what unlocked the chip-enum editor — replacing the *view* with a `<select>` doesn't touch the *model*, so `saveCellEdit` reads from whichever editor is present and PATCHes back into the model unchanged.

## Solution

**Three coordinated changes in `frontend/scripts/pages/home.js`:**

### 1. Row template for the Users tab

- NAME TD: dropped the `<span class="rp-home-handle">@…</span>` suffix. Just `<span class="rp-home-user-display">${esc(display_name)}</span>`. HANDLE column carries the `@username` independently.
- HANDLE TD: `<td class="rp-meta" data-full="${esc(username || "")}" data-prefix="@">@${esc(username || "")}</td>`. Display shows `@sam-rivera`; `dataset.full = "sam-rivera"`; `dataset.prefix = "@"`.
- PLAN TD: `<td data-full="${esc(plan || "")}">${planChip(plan)}</td>`. Chip stays as the display; `data-full` carries the source value so the chip-enum strip path can rebuild the chip via `planChip(dataset.full)`.

### 2. Spec flags (Users `columns:`)

```js
{ label: "Name",   key: "display_name", sortable: true,  editable: true, editKey: "display_name" },
{ label: "Handle", key: "username",     sortable: true,  defaultHidden: true, editable: true, editKey: "username" },
{ label: "Plan",   key: "plan",         sortable: true,  editable: true, editKey: "plan",
                                                          editor: "chip-enum",
                                                          options: ["free", "pro", "team", "enterprise"],
                                                          render: "planChip" },
```

The new spec fields (`editor`, `options`, `render`) are read by `decorateEditMode` only when present — backward-compatible with existing editable cols (Email, Job, Org, the truncated descriptions from CAS_A5A4…).

### 3. `decorateEditMode` + `saveCellEdit` + event handlers

- Added `chipRenderFor(name)` dispatcher near `decorateEditMode` mapping `spec.render` strings to the chip render functions (planChip, caseStatusChip, roleChip, orgChip, stageChip, priorityChip).
- Strip path: if the TD's `editKey`'s col is `chip-enum`, re-render via `td.innerHTML = chipRenderFor(col.render)(td.dataset.full)`. Otherwise apply the `data-trunc` + `data-prefix` render rules to compose textContent.
- Activate path: if `col.editor === "chip-enum"`, build a `<select>` via `document.createElement` (not innerHTML — security hook flagged the string-interp builder, `createElement`/`appendChild` is the defensible shape since `col.options` is dev-controlled but defense-in-depth is cheap), populated with options, current value pre-selected. Otherwise apply contenteditable + expand textContent to `data-full`.
- `saveCellEdit` reads `select.value` if a chip-enum `<select>` is present, else falls back to `textContent.trim()`. The existing post-PATCH `dataset.full = value` sync keeps source-of-truth fresh across subsequent edits in the same session.
- `focusin` snapshots `dataset.editOriginal` from `select.value` if present, else from `textContent.trim()` — so Escape-revert restores correctly for both editor types.
- `keydown` Escape: if select present, restore `select.value`; else `textContent`. Enter triggers blur on the select (or the TD) for consistent save semantics.
- `change` listener (new): when a `<select>.rp-cell-edit-select` value changes, fire `saveCellEdit` immediately. Without this, the user picks "pro" but the chip-area stays on the select until they click elsewhere — confusing UX.

## Post Checking

Live Playwright smoke against `:8080` after a cache-bust reload (ES module cache held the old version — required `?_=cachebust` query trick to force re-import):

| Editor | Phase | Verified |
|---|---|---|
| **Name** | pre-edit | textContent `"Sam Rivera"` (no `@sam-rivera` suffix — row restructure landed) |
| Name | edit-on | `classList.contains("editable")`, `contenteditable="plaintext-only"` |
| Name | edit-off | textContent `"Sam Rivera"` (no flicker) |
| **Handle** | pre-edit | textContent `"@sam-rivera"`, `dataset.full="sam-rivera"`, `dataset.prefix="@"` |
| Handle | edit-on | textContent `"sam-rivera"` (bare — prefix stripped for editing) |
| Handle | edit + save | PATCHed `{username: "sam-rivera-edited"}` (bare, NOT `@sam-rivera-edited`); backend echoed back `username: "sam-rivera-edited"` |
| Handle | edit-off | textContent `"@sam-rivera"` (prefix re-applied from `dataset.full`) |
| **Plan** | pre-edit | chip rendering present, `dataset.full="free"`, no `<select>` |
| Plan | edit-on | `<select>` swapped in via `createElement`, `select.value="free"`, four options populated (`free`/`pro`/`team`/`enterprise`) |
| Plan | change → "pro" | `change` event fired `saveCellEdit` immediately; PATCHed `{plan: "pro"}`; backend echoed back `plan: "pro"`; `dataset.full="pro"` synced |
| Plan | edit-off | chip restored via `chipRenderFor("planChip")(dataset.full)`, textContent `"free"` (after revert) |

Backend test: every PATCH returned `200 OK`; subsequent GET of the user echoed the PATCHed value verbatim. No lingering stale UI state across edit cycles.

## The discipline this updates

**Two new contracts written into the cell-editor surface:**

### 1. `data-full` is the *model*, `textContent` is the *view*, render rules compose

> Any TD whose display value is derived from the source-of-truth (truncation, prefix decoration, formatted dates, computed percentages, chip styling, etc.) MUST carry `data-full="<source-of-truth>"`. Render rules (`data-trunc`, `data-prefix`, future: `data-suffix`, `data-format`, `data-render=chipName`) compose the display from the model on edit-off and during initial paint. Edit-on strips display rules to expose the bare model for editing. `saveCellEdit` reads from the active editor (text or `<select>`) and PATCHes into the model, then syncs `data-full` so subsequent edits read fresh.

### 2. `editor: "chip-enum"` is the foundation for finite-enum editors

> Any column whose values come from a finite enum (Cases `status` / `priority` / `type`, Users `plan`, Memberships `role`, Projects `status`, Files `stage`) declares `editor: "chip-enum"`, `options: [...]`, and `render: "<chipFunctionName>"` in its spec entry. `decorateEditMode` swaps the chip span for a `<select>` on edit-on and restores the chip on edit-off via the `chipRenderFor` dispatcher. New chip families add their renderer to `chipRenderFor`. The pattern composes with `data-full` (which holds the enum value as model) — both contracts work in concert.

### Follow-ups worth a pass

- **Role + Org for Users** (the remaining 2 of Em's 5 columns) need backend work first — `org_role` and `org_name` live on the memberships row, not on `users`, and PATCH path is `/companies/:rid/members/:user_id`. Needs a per-column endpoint override in the spec (today `saveCellEdit` hardcodes `spec.patchEndpoint`) plus "primary company" disambiguation since a user can be in multiple companies. Separate case when prioritised.
- **Apply `chip-enum` to Cases status / priority / type** — same `roleChip` / `caseStatusChip` / `priorityChip` renderers already exist, the spec.options come from the existing const sets (`backlog|todo|in_progress|in_review|done`, `low|medium|high|critical`, `bug|feature|task|epic`). Pure spec-flag work now that the editor type exists. Probably a 5-minute follow-up.
- **Users `plan` allowed values** — the backend `PatchUserBody.plan: Option<String>` doesn't constrain values. If we want to enforce `free|pro|team|enterprise` strictly, that's a 1-line CHECK constraint on `users.plan` plus a const set on the route. Could ship alongside the spec entries that already enumerate the options.
- **`data-format` render rule** — currency cells (e.g., `"$1,200"` derived from `1200`) and percentage cells (`"30%"` from `30.0`) would slot into the same pattern. Defer until the first such column wants to be editable.
- **Restoration of `<select>` after save** — currently after a successful chip-enum PATCH, the `<select>` stays as the editor with the new value selected (correct, but maybe surprising — user sees no chip flash). Could blink-restore the chip briefly on save, then re-build the select on next focus. Tiny UX polish, defer until someone complains.

## Linked

- The implementation — this commit (next).
- The case discovery + spec — `CAS_E97414C482AB431FA28D43392501F47B`.
- The parent contract this builds on — runbook `CAS_A5A432F1A82A4A4DB0B62C0085C4428C-cell-editor-data-full-pattern.md` (the original `data-full` truncation pattern).
- The atomic doc capturing both contracts — `docs/internal/code/frontend/scripts/pages/home.md` drift section.
- The sibling RBAC + scrub-retain workstreams that ran in parallel — `CAS_A3B5D5F8…` (entity-membership migration) + `CAS_46BA…` (scrub-retain), both landed earlier today on `prerelease`.
- The cadence — `docs/internal/processes/bug-case-runbook-cadence.md`.
- Related discipline — [[bug-case-runbook-cadence]] (cadence itself), [[process-oriented]] (encode contracts in code + docs, not in agent memory).
