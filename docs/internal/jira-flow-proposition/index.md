---
title: Jira-flow proposition
section: Proposition
order: 0
last modified date: 2026-05-30
---

# Jira-flow proposition

One-off design proposition for the cases workstream — the document
that argued for an internal "Jira-like" kanban + comments + status
flow as the customer-ticket-triage dogfood ground. The cases workstream
that followed is described in [../cases/](../cases/index.md) and
implemented in `backend/crates/api/src/routes/cases.rs` +
`frontend/scripts/pages/cases.js`.

## Documents

| Doc | Purpose |
|---|---|
| [proposition.md](proposition.md) | the original design proposition — kanban columns, comment threading, activity feed, status lifecycle |

## Status

Shipped as the **cases workstream** (active). This proposition doc is
preserved as the design rationale. If you need the *live* description,
read [../cases/agent-cookbook.md](../cases/agent-cookbook.md) or the
upcoming atomic docs for `cases.rs` / `cases.js` in
[`../code/`](../code/index.md).
