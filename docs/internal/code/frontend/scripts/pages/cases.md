---
title: frontend/scripts/pages/cases.js
source: ../../../../../frontend/scripts/pages/cases.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-06-05
---

# cases.js

## Purpose

Cases — rail + (kanban board | case detail) surface. v1 scope: cases + comments tables, kanban (5 columns), detail page, agent migration from Internal-Slack. The activity feed mounts the shared `rp-activity` framework component; this page owns only the `ACTIVITY_PILLS` filter and hands it the filtered events.

## Public surface

- Default export: page mount.
- Rail: case list grouped by status + Internal/External source toggle + Assignee/Status chip rows.
- Main: board overview (mutually-exclusive with detail) OR case detail.
- Comment composer + inline edit support **@mention autocomplete**: typing `@name` opens a user menu (`/admin/users?q=`, same as the assignee picker) and inserts a non-editable `<span class="rp-mention" data-uid>` chip. The chip is whitelisted in `sanitizeRichHtml`, so it persists on the stored body and re-renders in the thread. No notifications backend in this slice (chip is presentational + carries the uid).
- Detail properties panel (`#rp-cases-detail-side`) is a collapsible side panel: a toggle pinned to the right of the status-path band (`#rp-cases-side-toggle`) flips `.open` on the panel + `.is-active` on itself — same mechanism as the workspace Filter/Tools panels (width 0 ⇄ 18rem, fixed-width inner to avoid mid-slide reflow). Open/closed persists via the `casesDetailPanel` pref (default open), reconciled at mount so it survives reloads + case switches. The property **values** inside (`#rp-cases-props`, an `rp-field-group`) are now shared `rp-field-editable`/`rp-field` rows painted by `paintProps` — click-to-edit Priority/Type/Category/Assignee + read-only Reporter/Opened/Updated — not the retired page-local `rp-cases-prop*` markup + custom prop-menu.

## Drift-prone areas

- Multi-source: workstream proposition in jira-flow-proposition/proposition.md; agent guide in cases/agent-cookbook.md.
- Side-panel toggle mirrors the workspace `bindPanel` pattern (panel.css `.rt-panel`); keep the two in sync if the panel idiom changes.
- **Attachments rendered on TWO surfaces** (2026-05-31 CAS_1E6D3B2E): the per-case sidebar list (`#rp-cases-attach-list`) AND a rail mirror (`#rp-cases-rail-attach` — a `<details>` between `.rp-rail-body` and `.rp-rail-footer`). Mirrors the Workspace Project→Files rail pattern. `renderAttachments` paints both from the shared `currentAttachments` array; both surfaces' remove buttons share the same delegated click handler (`onAttachRemoveClick`) so removing from either fires the same PATCH. Both hide independently when `n === 0`. Open-by-default in the rail when the case has attachments. Attachments stay JSONB on `cases.attachments`; the "first-class FIL_ entity?" question is parked on the case description and deferred.
- Mention chips depend on `sanitizeRichHtml` whitelisting `span.rp-mention` — if the sanitizer's allow-list is refactored, the chip rebuild branch must survive or mentions get unwrapped to plain text on the next edit/render.
- Activity timeline = the shared `rp-activity` component (`scripts/framework/activity.js`, `mountActivity`). `renderActivityList` filters via `ACTIVITY_PILLS`, then mounts the component with the filtered events; the page→component contract is the event shape `{ kind, occurred_at, message, actor? }` — keep it in sync if the backend event payload or `mountActivity`'s signature changes. The legacy page-local `rp-cases-activity-*` render (`activityRow`) is retired in its favour; the orphaned `rp-cases-activity-*` CSS deletion is gated on the `cases.css` page-lane (CAS_37B2E1BF).
- Property rows = the shared `rp-field-editable` component (`scripts/framework/field.js`). `paintProps(c)` (called from `paintDetail`) rebuilds `#rp-cases-props`: four `mountFieldEditable` rows (Priority/Type/Category/Assignee) whose `edit(slot,commit,cancel)` mounts an editor, plus three read-only `mountField` rows. Editors are `mountSelectEditor` (a native `<select>` — change commits + `patchCase`es, blur cancels) and `mountAssigneeEditor` (the `/admin/users?q=` user-search, de-cased from the old side picker). The page→component contract is `mountFieldEditable`'s `{ label, value, placeholder, edit }` opts — keep in sync if `field.js` changes. The orphaned `rp-cases-prop*` CSS deletion is gated on the same `cases.css` page-lane (CAS_37B2E1BF). Known a11y gap: the assignee `rp-user-picker-result` items are mouse-click only (no arrow-nav) — fix belongs with the shared user-picker atom.
- Rail chrome = the shared `rp-rail*` atoms (`framework/rail.css`). The Cases rail/list/tabs migrated off the legacy `rt-nav*`/`rt-tab*`/`rt-group*`/`rt-hidden*` family to `rp-rail*` in lockstep across `cases.html` + `cases.js` (render strings **and** the `querySelector`/`closest` selectors at 62/338/354) + `cases.css` (the page-scoped overrides `.rp-rail.compact .rp-cases-*`, `.rp-cases-card .rp-rail-tab-hide`, `.rp-rail-group-body > …`). **Semantic rename:** the Cases hide-button `rt-tab-close` → `rp-rail-tab-hide` (the framework already renamed close→hide; the bodies are byte-identical) — it's a "Hide from board/rail" declutter, not a destructive close. `rp-rail-tab-hide` is still a `<span>` (delegated click, mouse-only) — the `<button class="rp-btn-icon rp-rail-tab-hide">` a11y upgrade is deferred with the btn-cluster. The page rules now share `rp-rail-*` names with `rail.css` (the page-scopes-the-atom pattern, +3 benign `dupSelectors`); they collapse when legacy `styles/rail.css` `rt-*` rules retire. The rail's three controls also migrated (matching golden-treasure's rail-rollout targets): collapse `rt-btn rt-icon-btn` → `rp-btn-icon`, the rail-foot New case `rt-btn rt-btn--glass` → `rp-btn-icon rp-btn-icon--glass`, the source toggle `rt-seg rt-seg--rail` → `rp-seg rp-seg--rail` — all `#id`-targeted in JS, so no lockstep. `tools/page-verify --pages cases` then reports the rail subtree `rt-*`-clean (the remaining ~45 `rt-*` are the deferred detail/list/modal btn + table surface, outside the rail).
- Case-card titles render the `rp-title` atom inside `.rp-cases-card` (sized by the `.rp-cases-card .rp-title` context, not a `rp-cases-card-title` class — CAS_37B2E1BF). The `rp-cases-detail-title` is intentionally NOT collapsed (its always-editable header contract diverges from the `[data-editable]`-gated `.rp-head .rp-title` — see the coherence plan's blocked list).

## Related

- [Frontend pillar landing](../../../index.md)
