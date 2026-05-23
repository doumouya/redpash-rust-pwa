---
title: Archive — index
section: Internal
order: 90
last modified date: 2026-05-24
---

# Archive

Snapshots no longer load-bearing. Kept (not deleted) because commit
messages, PR refs, and past conversations link here. Frozen on entry
— archive docs are *read-only* references, never updated.

| Doc | Why it was load-bearing | Why it stopped |
|---|---|---|
| [frontend-parity-inventory](frontend-parity-inventory.md) | accounted for the gap before the merge of `frontend-reset` → `prerelease` | the gap was closed page by page; the inventory served its purpose |
| [frontend-reset-merge-report](frontend-reset-merge-report.md) | the merge report captured the cutover | post-merge state is now `prerelease` HEAD |
| [handoff-frontend-datatables](handoff-frontend-datatables.md) | Woz → Torv handoff during Woz's 48-hour suspension | the four workstreams it scoped are all shipped (WS#1–4) |
| [js-refactor-review](js-refactor-review.md) | one-shot review of frontend JS hygiene during the rebuild | rebuild done; the rules live in [processes/](../processes/ui-change-process.md) |
| [workspace-migration](workspace-migration.md) | journal of the workspace-page migration | workspace shipped; the running shape is captured in [subsystems/workspace-shell](../subsystems/workspace-shell.md) |
| [woz-2026-05-25-suspension-report](woz-2026-05-25-suspension-report.md) | self-written accounting after the suspension | feedback memories captured the lessons; the report itself is history |

## How to add to archive

A living doc retires when:
1. Its claims are no longer load-bearing (the gap closed, the
   workstream shipped, the system retired), AND
2. Something still references the doc (a commit message, an old
   memory, a past PR) — so deletion would break the trail.

When both conditions hit: `git mv` the file here, add a row to the
table above with *why it was load-bearing* and *why it stopped*. Do
not edit the file's content — let it stand as the snapshot it was.
