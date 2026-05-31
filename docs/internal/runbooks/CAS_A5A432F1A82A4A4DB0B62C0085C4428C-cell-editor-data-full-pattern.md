---
title: 0010 — Cell-editor data-full pattern for truncated long-text columns
section: Internal
order: 10
last modified date: 2026-05-31
case_id: CAS_A5A432F1A82A4A4DB0B62C0085C4428C
status: resolved
---

# 0010 — Cell-editor data-full pattern for truncated long-text columns

**Date:** 2026-05-31 · **Area:** `frontend/scripts/pages/home.js` (row templates + `decorateEditMode` + `saveCellEdit`) · **Status:** resolved · **Case:** `CAS_A5A432F1A82A4A4DB0B62C0085C4428C`

## Problem Statement

Em 2026-05-31: *"make relevant columns on the objects editable-sortable etc, we barely have anything editable on Home page."* The audit (recorded in commit `71e8c05`'s commit body) showed the easy spec-flag-flip wins were exhausted at two columns (Users `email` + `organisation`). The next tier of useful editable columns — Cases `description`, Cases `error_message`, Projects `description` — was blocked by a **data-loss bug class waiting to ship the moment we'd naively flag them `editable: true`:**

Their row templates render via `esc((row.field || "").slice(0, N) || "—")` — putting the **truncated** display string directly into `td.textContent`. The cell-editor's `saveCellEdit` reads `td.textContent.trim()` and PATCHes that. So flagging the column `editable: true` would let the user "edit a description" — but on save the backend would receive the 120-char *display* string, **silently overwriting the original 2,000-char description with its own first 120 chars**. The tail would be gone forever, with no audit trail beyond the PATCH log.

This isn't a hypothetical — we found it by reading the code path before shipping the spec flip. The previous-Torv-files-a-PR-without-noticing scenario is exactly what the [bug-case-runbook cadence](../processes/bug-case-runbook-cadence.md) was designed to catch.

## Troubleshooting steps

1. **Audit current editable surface across all 7 Home tabs.** Grep for `editable: true` in `pages/home.js`. Surface state: Users `job_title`, Cases `title`, Files `filename → display_name`, Charts `display_name`, Projects `name`. Five tabs at one column each, two tabs at zero (Companies, Memberships).
2. **Find the constraint behind the sparseness.** Read each tab's row template. Two structural blockers:
   - **Chip / pill markup** (Companies `name` + slug pill, all enum cols like Cases `status`, Memberships everywhere): contenteditable=plaintext-only on a TD containing nested spans would let the user accidentally edit-and-clobber the chip styling. Needs a dedicated cell-editor (dropdown overlay for enums, restructured row template for mixed markup).
   - **`.slice(0, N)` truncation** (Cases `description` slice 120, Cases `error_message` slice 80, Projects `description` slice 120): the *data-loss* class described in the Problem Statement.
3. **Verify backend PATCH support per column.** `CasePatchRequest` accepts `description` + `error_message`; `PatchProjectBody` accepts `description`. Backend's ready — only the frontend cell-editor is the gap.
4. **Design the contract.** Either restructure every row template to render full text (breaks layout — descriptions can be thousands of chars), or carry source-of-truth + display separately. Picked the second: `data-full` attribute holds the full string, `data-trunc` holds the truncation length, `td.textContent` shows the truncated display.
5. **Live smoke-test in Playwright after implementing.** Sequence: pre-edit (text=120 chars, data-full=2855), edit-on (text swapped to 2855, contenteditable=plaintext-only), simulate edit (text=2881 with appended marker), PATCH (HTTP 200, returns 2881-char body with the marker — backend received the full edited value), edit-off (text=120 again, re-truncated from updated data-full). All four phases passed; the case being edited was `CAS_A5A432F1A82A4A4DB0B62C0085C4428C` itself — end-to-end loop closed.

## RCA

The root pattern: **whenever a row's display value is derived (truncated, formatted, computed) from a source-of-truth value, `td.textContent` alone is insufficient** to round-trip a PATCH. The cell shows one thing; the data layer expects another. Without an explicit source-of-truth handle on the DOM, the editor has no way to distinguish "this is the truncated display" from "this is what the user wants to save."

The same class of bug surfaces anywhere display ≠ source-of-truth:
- `.slice(0, N)` truncation (today's three columns).
- Chip rendering of enum values (deferred to a follow-up cell-editor slice — separate case).
- Computed formatting (`fmtTime`, `Math.round(… * 100) + "%"`, etc. — read-only by design, but the pattern would extend if any became editable).

Pre-fix, the only signal that this was a bug was *reading the row template carefully*. The discipline rule below makes that signal explicit at the spec layer.

## Solution

**Three coordinated edits in `frontend/scripts/pages/home.js`:**

### 1. Row templates carry source-of-truth + truncation rule on the TD

```js
// Cases row — description + error_message
+ '<td class="rp-meta" data-full="' + esc(c.description || "") + '" data-trunc="120">'
+   esc((c.description || "").slice(0, 120) || "—")
+ '</td>'
+ '<td class="rp-meta" data-full="' + esc(c.error_message || "") + '" data-trunc="80">'
+   esc((c.error_message || "").slice(0, 80) || "—")
+ '</td>'

// Projects row — description
+ '<td class="rp-meta" data-full="' + esc(p.description || "") + '" data-trunc="120">'
+   esc((p.description || "").slice(0, 120) || "—")
+ '</td>'
```

### 2. `decorateEditMode` becomes data-attribute-aware

- **Edit-mode ON path**: after the existing contenteditable + class + data-edit-key block, swap `td.textContent` to `td.dataset.full` when present — expands the cell so the user edits the full string.
- **Edit-mode OFF / strip path**: after the existing class + contenteditable removal, re-truncate via `td.dataset.full.slice(0, +td.dataset.trunc) || "—"` so the cell snaps back to display form without waiting for the next `fetchList` paint. `data-trunc="0"` (or absent) falls through to "show the full value" — pattern works for cols that need source-of-truth tracking but no display truncation.

### 3. `saveCellEdit` keeps `data-full` in sync after a successful PATCH

```js
td.dataset.editOriginal = value;
if (td.dataset.full !== undefined) {
  td.dataset.full = value;
}
```

Without this, a second edit in the same edit-mode session would start from the *stale* full value (the pre-PATCH one cached in `data-full`), and the exit-edit-mode re-truncate would snap to the stale text. The two-line sync closes both gaps.

### 4. Spec flips on the 3 unlocked columns

```js
// Cases
{ label: "Description", key: "description",   sortable: false, defaultHidden: true, editable: true, editKey: "description" },
{ label: "Error",       key: "error_message", sortable: false, defaultHidden: true, editable: true, editKey: "error_message" },
// Projects
{ label: "Description", key: "description",   sortable: false, defaultHidden: true, editable: true, editKey: "description" },
```

Net: 2 → 5 editable columns on Cases, 1 → 2 on Projects, total Home editable surface from 5 cols → 8 cols across 5 tabs.

## Post Checking

Playwright smoke test ran the full flow on the live backend (port 8080), targeting `CAS_A5A432F1A82A4A4DB0B62C0085C4428C` — *this very case's* description — as the test subject:

| Phase | Verified |
|---|---|
| pre-edit | `textContent.length === 120` (truncated), `dataset.full.length === 2855` (source-of-truth holds full string) |
| edit-on | `getAttribute("contenteditable") === "plaintext-only"`, `classList.contains("editable")`, `textContent === dataset.full` (swap to full) |
| after-focusin | `dataset.editOriginal.length === 2855` (focusin captures the full snapshot, not the truncated display) |
| after-edit | `textContent.length === 2881` (full + appended `[EDITED AT …]` marker), `endsWith(marker) === true` |
| PATCH | `/api/cases/<rid>` returned `HTTP 200`, response body `description` field was 2881 chars and ended with the marker — backend received and persisted the full edited string |
| edit-off | `contenteditable` removed, `editable` class removed, `textContent.length === 120` (re-truncated from updated `data-full`), `text_preview` shows the start of the new full value |

The Cases column-picker showing Description out-of-the-box is opt-in (the column is `defaultHidden: true`); a user has to enable it via the toolbar columns icon. Same for `error_message` and Projects `description`. Toolbar shows them in the picker, hide-on-by-default for visual density.

## The discipline this updates

**Hard rule for any future column that wants to be `editable: true`:**

> If the row template's TD content is *derived* from the source-of-truth value (truncated, formatted, computed), the TD MUST carry a `data-full="<source-of-truth>"` attribute before being flagged `editable: true`. `data-trunc="<N>"` declares the display-truncation length so `decorateEditMode` can re-shrink on exit-edit-mode. Otherwise the cell-editor's PATCH path will silently corrupt the data by writing the *display* string back to the backend.

The home.js atomic doc's [drift section](../code/frontend/scripts/pages/home.md) now documents this contract inline so the next agent grepping for "where to add a new editable col" sees the constraint before writing the spec flag.

### Follow-ups worth a pass

- **Chip cell-editor slice.** The enum columns (Cases `status` / `priority` / `type`, Users `plan`, Projects `status`, Memberships `role` / `scope`) need a `<select>` overlay editor — `contenteditable=plaintext-only` won't preserve the chip styling. File its own case + runbook when prioritised.
- **Companies `name` + `slug` row template restructure.** Currently `<td>` carries `name` plus a slug pill suffix in the same cell — mixed markup blocks contenteditable. Splitting into separate name + slug TDs (and dropping the in-name pill suffix) would unlock both for `editable: true`. UI design call: does the suffix-pill convey something that the dedicated slug column already shows? If yes, dropping it is fine.
- **Files / Charts `description`.** Backend `AdminFileSummary` and `ChartSummary` don't surface description today. If they grow one, the row template already has the data-full pattern to copy from.
- **Generalise the pattern to list-page.js.** Today the data-full pattern lives in `pages/home.js`'s `decorateEditMode`. Monitoring uses the same `wireListColumnsExport` shape — when it adds editable columns it could reuse the contract via the shared helper. Defer until Monitoring needs editing.

## Linked

- The implementation — commit (next, this runbook ships in the same commit).
- The audit that surfaced the gap — commit `71e8c05` (the spec-flag-flip + atomic-doc constraint note).
- The cell-editor contract — `frontend/scripts/pages/home.js` `decorateEditMode` (around the "data-full pattern" comment blocks) + `saveCellEdit` (the post-PATCH sync block).
- The atomic doc capturing the contract — `docs/internal/code/frontend/scripts/pages/home.md` drift section.
- Sibling runbooks under the new cadence — `CAS_2C692011AD2C41E88A7C2541EF30AE1E-column-drag-reorder-cluster.md` + `CAS_097E36B6F6904E429401F4951A54BA9B-mcp-cases-session-auto-refresh.md` + `CAS_35090747FD78414D8CD060A73181A414-dev-static-assets-no-cache-control.md`. Four CAS-named runbooks in one day under the new cadence.
- Related discipline — [[bug-case-runbook-cadence]] (cadence itself), [[process-oriented]] (encode the constraint in the contract so the next agent doesn't reinvent the bug).
