---
title: Page — Cases
section: Internal
last modified date: 2026-06-07
---

# Page — Cases

## Purpose

The ONE question Cases answers: **what work is in flight, and where is each
piece in its lifecycle?** It is RedPash's own work-tracker — a Jira-class
kanban + ticket-detail surface (workstream spec:
`docs/internal/jira-flow-proposition/proposition.md`) that the agent team
uses to coordinate, and that doubles as the destination for auto-triaged
crashes (a case can carry an `error_message` payload). It is the migration
target for the old file-based `/Internal-Slack/` channels.

Same rail-page shell as `/home` and `/monitoring`: a constant left rail for
navigation, a mutually-exclusive main area that shows **either** the board
**or** one case's detail.

## The five-column lifecycle (not three)

The kanban has **five** lanes, in this fixed order: **backlog → todo →
in_progress → in_review → done**. The order is the single source of truth
(`STATUS_ORDER` in `pages/cases/labels.js`) and drives everything: column
layout, rail sort, the detail-page status path, and the forward cycle. Any
case whose `status` isn't one of the five falls back to `backlog` at render
time, so a bad/legacy value never produces an orphan column.

Status moves through the lanes by three routes, all funnelling through one
optimistic mutator (`setCaseStatus`):

- **Card chevron** — cycles forward one lane, wrapping `done → backlog`
  (i.e. "Reopen"). The chevron tooltip names the *destination* as a verb
  ("Send for review", "Mark as Done") rather than asserting a state.
- **Kanban drag-drop** — native HTML5 DnD (no library, per the no-frameworks
  rule), drop a card on any column to set that lane directly. Added 2026-05-28
  after proposition.md deferred it to v2.
- **Detail status path** — clicking a step in the detail hero sets that
  status directly, allowing backward jumps (reopen) as well as forward.

All three mutate the cached row + repaint immediately, then PATCH; a failed
PATCH reverts the optimistic move. The status change emits a
`case_status_change` event that surfaces in the detail activity feed.

## Rail

The rail is **flat** (the old status/assignee grouping was retired
2026-05-28 — status now rides each row as a colored dot, source moved to a
top toggle). Top to bottom:

- **Board pseudo-tab** — always-on link back to the kanban (`#/cases`,
  active whenever no case is open).
- **Internal / External source seg** — a server-side filter
  (`/api/cases?source=`), defaulting to `internal` so the agent team's queue
  shows first. Flipping it refetches. Backed by `mountRailSeg` + the
  `cases-activeSource` pref.
- **Assignee / Status filter chip rows** — two independent single-select
  dimensions that AND against the source. Assignee chips are static
  (`All` / `Mine` / `Unassigned`) plus per-agent chips populated from
  `/admin/users` on mount (`mine` resolves to the caller's rid;
  `__unassigned__` is a sentinel the backend matches as `assignee_id IS
  NULL`). Selections persist via prefs.
- **Closed-window chip-row** — caps how far back `done` cases stay visible
  (the same control sits in the board's Done column; one shared pref
  `cases-doneWindow`, toggling from either surface updates both).
- **Case list** — sorted by status order then `updated_at` desc, each row
  carrying a priority dot, the title, a per-status color dot, and a hide ×.
- **Attachments mirror** — when a case is open, its attachments also render
  here (mirrors Workspace's Project→Files pattern; shares state with the
  detail sidebar).
- **Hidden recovery** — a `<details>` "Hidden (n)" section appears only when
  ≥1 case is hidden, with per-item restore.

**Hide is display, not access.** The hide × removes a case from the rail and
board for declutter only — the full roster is always fetched; the hidden set
(a list of rids in the `cases_hidden` pref) is applied at *render time* in
both surfaces, never at fetch time. This is the replicable hide/restore
pattern shared with Workspace.

## Surface — board OR detail

The route is decided by `?id=` in the hash:

- `#/cases` → **kanban board** (default).
- `#/cases?id=CAS_…` → **case detail** (full-bleed; the board hides
  entirely — they are mutually exclusive, no overlay).

The board is a **3-row overview** (a variation of the Home/Monitoring
layout): row 1 = a hero strip (two donuts — By status / By priority —
flanking a 2×2 stats grid of Total / Urgent / Mine / Unassigned); row 2 =
the five kanban columns; row 3 = a flat cases table (newest first). All
three derive from the *same* filtered roster the columns render, so the
done-window + hidden filters track across them.

One data fetch (`refreshCases`) feeds everything: it pulls the list (server
returns `{ items, total, page, size }`), repaints the rail, and repaints the
board even while hidden so it's fresh when the user closes a detail. Any
mutation re-triggers `refreshCases` so both halves stay in sync. A `404`
degrades gracefully to an "endpoint not live yet" empty state.

### Case detail

`loadCaseDetail` fires its own `/cases/:rid` fetch (independent of the list).
It is a careful dual-shape consumer: `GET /cases/:rid` returns the full
`CaseDetail` (case + comments + activity), but a `PATCH` returns a **bare
Case row**. `paintDetail` detects which shape it got, so a field-edit repaint
never wipes the comments thread or resets the activity filter.

The detail surface carries:

- **Inline title edit** — click the H1 → `contenteditable=plaintext-only`;
  Enter commits, Escape reverts.
- **Status path hero** — the five-step lifecycle, click to set directly.
- **Properties panel** — Priority / Type / Category / Assignee are *editable*
  rows built on the `rp-field-editable` framework atom (a `<select>` editor,
  or for assignee a `/admin/users` search picker); Reporter / Opened /
  Updated are read-only `rp-field` rows. Each edit fires a sparse PATCH.
  Reporter shows an Internal/External source badge. The panel's open/closed
  state persists via the `cases-detailPanel` pref.
- **Description** — rich text, rendered as sanitized HTML, edited via the
  same WYSIWYG stack as comments (pencil → toolbar + contentEditable).
- **Comments thread** — chat-bubble layout (own messages right-aligned +
  tinted; others left), grouped under day dividers, with Reporter/Assignee
  role tags. The composer is a contentEditable WYSIWYG editor with a
  formatting toolbar (bold/italic/list/quote/code/link via `execCommand`),
  `@mention` autocomplete (inserts a non-editable chip that survives the
  sanitizer), per-message file staging (paperclip + drag-drop), and
  `⌘↵ / ⌘B / ⌘I / ⌘K` shortcuts. Own comments get hover edit/delete.
- **Error payload** — auto-triaged crashes show their raw `error_message`;
  hidden when absent.
- **Activity feed** — the shared `rp-activity` framework timeline, filtered
  by client-side pills (All / Comments / Status / Assignment / Edits) over
  the memoized event payload (no network per pill).

### Security note

All HTML that round-trips through storage (comment bodies, description) is
run through a **whitelist-rebuild sanitizer** (`sanitizeRichHtml`) on both
send and render (defence in depth): only a fixed tag set survives,
disallowed tags are unwrapped keeping their text, and `<a href>` is kept only
for safe schemes and forced to `target=_blank rel=noopener noreferrer
nofollow`. No attributes, no script/style/event vectors.

### Create / delete

Create is a modal (title + description; an attachments slot is wired but
backend-pending) → `POST /cases` → navigate straight into the new case's
detail. Delete is a trash icon → `window.confirm` → `DELETE /cases/:rid` →
back to the board. Delete is dev-permissive today; v3 RBAC gates it by
reporter/admin role.

## Source files

- [../code/frontend/scripts/pages/cases.md](../code/frontend/scripts/pages/cases.md) — the page module (rail + board + detail).
- [../code/frontend/scripts/pages/cases/labels.md](../code/frontend/scripts/pages/cases/labels.md) — `STATUS_ORDER` + status/priority/type label & icon vocab + done-window constants.
- [../code/frontend/scripts/framework/activity.md](../code/frontend/scripts/framework/activity.md) — `rp-activity` timeline (the detail activity feed).
- [../code/frontend/scripts/framework/field.md](../code/frontend/scripts/framework/field.md) — `rp-field` / `rp-field-editable` rows (the properties panel).
- [../code/frontend/scripts/list-page.md](../code/frontend/scripts/list-page.md) — hero strip + list charts (the board overview).
- [../code/frontend/scripts/rail-controls.md](../code/frontend/scripts/rail-controls.md) — rail seg (source toggle) + collapse helpers.
- [../code/frontend/scripts/rail-footer.md](../code/frontend/scripts/rail-footer.md) — shared rail footer nav.
- [../code/frontend/scripts/topbar.md](../code/frontend/scripts/topbar.md) — shared topbar.
- [../code/frontend/scripts/prefs.md](../code/frontend/scripts/prefs.md) — per-user pref store (filters, hidden set, done-window, panel state).
- [../code/frontend/scripts/format.md](../code/frontend/scripts/format.md) — `fmtAge` / `fmtTime` / `fmtClock` / `dayKey` / `dayLabel`.
- [../code/frontend/scripts/api.md](../code/frontend/scripts/api.md) — the `api` fetch wrapper.
- [../code/frontend/scripts/dom.md](../code/frontend/scripts/dom.md) — `esc` HTML escaping.
