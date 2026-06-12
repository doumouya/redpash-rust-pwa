---
title: State — orchestrator run-ledger
section: Internal
order: 70
last modified date: 2026-06-12
---

# State — operational run-state, not documentation

One file: [`current_feature.md`](current_feature.md) — the `/feature`
orchestrator's ephemeral run-ledger (checklist, gate results, breaker
counters), written after every step so a dead/bloated session can resume.
The spec it tracks lives in the Case + [`../specs/`](../specs/index.md);
the process is [`../processes/agent-roles.md`](../processes/agent-roles.md).
Reset to the template when a feature lands or is abandoned.
