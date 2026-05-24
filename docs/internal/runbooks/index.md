---
title: Runbooks
section: Internal
order: 60
last modified date: 2026-05-24
---

# Runbooks

> **Internal — RedPash team only.** This section is not part of the
> public product documentation.

A log of real problems hit in RedPash — diagnosed, root-caused, and
fixed. Each entry is a short post-mortem in five parts so the
*reasoning* survives, not just the patch.

The Runbook is the human-written companion to the
[Events](../../api/events.md) system: Events captures *what* failed at
runtime; the Runbook captures *why* it failed and *how it was fixed*.

## Entry format

Every entry follows the same five headings:

| Section | Answers |
|---|---|
| **Problem Statement** | What was observed — the symptom, and who or what surfaced it. |
| **Troubleshooting steps** | What was checked, in what order, and what each step showed. |
| **RCA** | Root-cause analysis — the *underlying* cause, not the symptom. |
| **Solution** | What changed, what was deferred, and how to prevent a recurrence. |
| **Post Checking** | How the fix was verified once it landed — what was re-tested or monitored to confirm the problem is actually gone, plus any follow-up left watching. |

## Conventions

- One file per entry: `NNNN-short-slug.md` — zero-padded, sequential.
- `order` in the frontmatter is the entry number; this index is `order: 0`.
- Write the entry when the fix lands, while the context is still fresh.
- Link the commit(s) and any related Events `kind` so a reader can pivot
  to the live data.
- Keep it honest: record what was *deferred*, not just what was fixed.

## Entries

- [0001 — Orphan preferences](0001-orphan-prefs.md) — Settings controls
  that persisted a choice no code ever consumed.
- [0002 — Stale join after a table drop](0002-stale-join-after-drop.md) —
  `/api/projects` 500'd after Phase 2 dropped `dashboards`;
  `PROJECT_SELECT`'s published-status subquery still joined the dropped
  table.
- [0003 — Dead reference after function deletion](0003-dead-reference-after-deletion.md) —
  WS#2 swept out `refresh()` but missed its tail-call inside
  `rebuildFilterCols`; every tab pick on the Workspace threw
  ReferenceError into "Couldn't load file." Discipline rule: grep for
  function NAMES AS CALLS across the codebase, not just at the
  semantic call sites you reasoned about.
- [0004 — Unescaped apostrophe blanks the page](0004-unescaped-apostrophe-blanks-page.md) —
  `it'll` inside a single-quoted JS string closed the literal early;
  the `/docs` page failed at parser time with "unexpected token:
  identifier" and rendered the generic mount-failure shell.
  Discipline rule: use the curly U+2019 (`'`) for contractions in
  single-quoted strings — the convention the rest of the file
  already uses.
- [0005 — ECharts `colorBy` default paints every bar the same colour](0005-echarts-colorby-series-default.md) —
  fresh `redpash-mocha` theme with 8 palette colours, but every bar
  on the Profile usage chart painted `palette[0]`. RCA: ECharts
  defaults `colorBy` to `"series"`, not `"data"` — a single bar
  series of N categorical points gets one colour for the whole
  series. Discipline rule: when registering a multi-colour theme,
  set `colorBy: "data"` on any series whose points are distinct
  categories (bar / line / scatter); the default works only for
  multi-series overlays.
