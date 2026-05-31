---
title: frontend/scripts/pages/cases.js
source: ../../../../../frontend/scripts/pages/cases.js
owner: Torv
section: Internal · Code · Frontend · scripts/pages
last modified date: 2026-05-31
---

# cases.js

## Purpose

Cases — rail + (kanban board | case detail) surface. v1 scope: cases + comments tables, kanban (5 columns), detail page, agent migration from Internal-Slack. Activity feed ports Monitoring M-2 UserActivity render shape.

## Public surface

- Default export: page mount.
- Rail: case list grouped by status + Internal/External source toggle + Assignee/Status chip rows.
- Main: board overview (mutually-exclusive with detail) OR case detail.
- Comment composer + inline edit support **@mention autocomplete**: typing `@name` opens a user menu (`/admin/users?q=`, same as the assignee picker) and inserts a non-editable `<span class="rp-mention" data-uid>` chip. The chip is whitelisted in `sanitizeRichHtml`, so it persists on the stored body and re-renders in the thread. No notifications backend in this slice (chip is presentational + carries the uid).
- Detail properties panel (`#rp-cases-detail-side`) is a collapsible side panel: a toggle pinned to the right of the status-path band (`#rp-cases-side-toggle`) flips `.open` on the panel + `.is-active` on itself — same mechanism as the workspace Filter/Tools panels (width 0 ⇄ 18rem, fixed-width inner to avoid mid-slide reflow). Open/closed persists via the `casesDetailPanel` pref (default open), reconciled at mount so it survives reloads + case switches.

## Drift-prone areas

- Multi-source: workstream proposition in jira-flow-proposition/proposition.md; agent guide in cases/agent-cookbook.md.
- Side-panel toggle mirrors the workspace `bindPanel` pattern (panel.css `.rt-panel`); keep the two in sync if the panel idiom changes.
- **Attachments rendered on TWO surfaces** (2026-05-31 CAS_1E6D3B2E): the per-case sidebar list (`#rp-cases-attach-list`) AND a rail mirror (`#rp-cases-rail-attach` — a `<details>` between `.rt-nav-body` and `.rt-nav-foot`). Mirrors the Workspace Project→Files rail pattern. `renderAttachments` paints both from the shared `currentAttachments` array; both surfaces' remove buttons share the same delegated click handler (`onAttachRemoveClick`) so removing from either fires the same PATCH. Both hide independently when `n === 0`. Open-by-default in the rail when the case has attachments. Attachments stay JSONB on `cases.attachments`; the "first-class FIL_ entity?" question is parked on the case description and deferred.
- Mention chips depend on `sanitizeRichHtml` whitelisting `span.rp-mention` — if the sanitizer's allow-list is refactored, the chip rebuild branch must survive or mentions get unwrapped to plain text on the next edit/render.

## Related

- [Frontend pillar landing](../../../index.md)
