---
title: Specs — index
section: Internal
order: 60
last modified date: 2026-06-12
---

# Specs — Case spec mirrors

On-disk mirrors of agent-chain Case specs — the **handoff fallback** when the
`redpash-slack` MCP is down (see
[processes/agent-roles.md](../processes/agent-roles.md)). One doc per Case,
written by the architect at `/feature` Step 1, committed by the orchestrator
at Checkpoint 1.

> Unrelated to the retired shape-layout "specs" section — that one is frozen
> under [archive/legacy/](../archive/index.md); this shelf is live and
> load-bearing for the agent role chain.

| Doc | What it is |
|---|---|
| [objects-idor-regression](objects-idor-regression.md) | spec for Case CAS_DD6F55FB1B1446138936DBF66A74DBDB — `objects.rs` `scope_parent_id` IDOR regression tests (6 ACs; AC-5/6 split to a sibling Case at Checkpoint 1) |
| [auth-audit-scope-parent](auth-audit-scope-parent.md) | spec for Case CAS_26EC04CAF5934A0996B7A04C8FA55534 — the AC-5/6 sibling: auth-audit Cat-4 detector for unchecked `scope_parent_id` / parent binds |
| [agent-system-review-2026-06-12](agent-system-review-2026-06-12.md) | independent review of the 5-role orchestrator — 49 adversarially-verified findings + priority triage |
