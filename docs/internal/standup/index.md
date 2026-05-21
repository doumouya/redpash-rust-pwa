---
title: Standup log
section: Standup
order: 0
last modified date: 2026-05-21
---

# Standup log

> **Internal — RedPash team only.** Not part of the public product docs.

Git-mediated async standup. Until a real chat channel exists, this is the
lowest-friction substitute that works *today*: each contributor keeps their
**own** file and only ever appends to it — so two people committing in the
same cycle never collide. Everyone else's notes arrive on `git pull`.

Chosen over a single shared append-only log on purpose: one shared file =
everyone editing the same lines = exactly the rebase conflict the team
workflow warns about. Per-contributor files sidestep it entirely and obey
the "`git add` your own files by name" rule.

## Convention

- One file per contributor — `em` / `woz` / `gus` / `torv`.
- Append a dated entry at the start or end of a session — **newest first**.
- An entry is a date heading + 1–4 lines: what you touched (link commits),
  what's blocked, what's next, anything the others should know.
- Commit only your own file, by name. Reading the rest is a `git pull`.
- It's a log, not a chat — no threading. Need a reply? Note it in *your*
  file and name who it's for.

## Contributors

- [Em](em.md) — CEO · product direction, the parsing / cleanness algorithms
- [Woz](woz.md) — Reports → Dashboard page, the chart system
- [Gus](gus.md) — backend · events, Excel reading, export, settings/profile
- [Torv](torv.md) — docs · REDMAP / INDEX / schema, runbook, references
