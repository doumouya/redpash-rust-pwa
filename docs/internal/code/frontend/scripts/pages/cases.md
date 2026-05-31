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
- Detail properties panel (`#rp-cases-detail-side`) is a collapsible side panel: a toggle pinned to the left of the status-path band (`#rp-cases-side-toggle`) flips `.open` on the panel + `.is-active` on itself — same mechanism as the workspace Filter/Tools panels (width 0 ⇄ 18rem, fixed-width inner to avoid mid-slide reflow). Defaults open.

## Drift-prone areas

- Multi-source: workstream proposition in jira-flow-proposition/proposition.md; agent guide in cases/agent-cookbook.md.
- Side-panel toggle mirrors the workspace `bindPanel` pattern (panel.css `.rt-panel`); keep the two in sync if the panel idiom changes.

## Related

- [Frontend pillar landing](../../../index.md)
