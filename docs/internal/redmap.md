---
title: Internal REDMAP — find anything fast
section: Internal
order: -1
last modified date: 2026-06-07
---

# Internal REDMAP

One page for navigating the internal docs without `grep`. This is the **single**
nav map (the old public `docs/REDMAP.md` was folded in + deleted, CAS_701CF65E).
The old shape-layout sections were ported into the spine and their originals
frozen under `archive/legacy/`.

Sections:
[Surface map](#surface-map) ·
[Find by area](#find-by-area) ·
[The survival layer](#the-survival-layer-code)

---

## Surface map

```
docs/internal/
├── index.md            the ontology — feature/page spine + survival layer + shelves
├── redmap.md           ← you are here
│
│   ── feature/page spine (hand-written WHY + generated facts) ──
├── rest-api/           the HTTP surface — generated route table + per-resource conventions
├── auth/               sign-in — google + dev-user/bootstrap
├── db/
│   ├── schemas/        per-object: generated schema + field/business-logic prose
│   └── rbac/           entity · memberships · teams · permission-contract
├── stack/              code explanation at SYSTEM granularity — frontend/backend/tools/db
├── pages/              one doc per shipped page + _shared/ chrome (topbar, rail-footer)
│
│   ── the survival layer ──
├── code/               one doc per source file (tools/ · frontend/scripts/ · backend/crates/)
│   ├── _nav.md         generated back-index of every atomic doc
│   ├── backend/  frontend/  tools/
│
│   ── cross-cutting shelves ──
├── runbooks/           operational / incident playbooks
├── processes/          how the team works (touch-policy, audit cadence, push policy, agent roles, …)
├── decisions/          the durable WHY — design choices that bind future work
├── specs/              Case spec mirrors — on-disk handoff fallback for the agent role chain
├── state/              orchestrator run-ledger (current_feature.md) — operational run-state, not docs
├── ui/                 the generated component catalog (ui/catalog/, --components)
├── excel-edge-cases/   dirty-.xlsx fixtures triage
└── archive/            snapshots no longer load-bearing (incl. legacy/)
```

---

## Find by area

| If you want to … | Read |
|---|---|
| Understand a page (what it does, its rail, its surface) | [pages/](pages/index.md) |
| Find / add an HTTP route | [rest-api/](rest-api/index.md) |
| Know the data model / an object's schema or who can touch it | [db/](db/index.md) · [db/schemas/](db/schemas/index.md) · [db/rbac/](db/rbac/index.md) |
| Understand how a subsystem works under the hood | [stack/](stack/index.md) |
| Understand a specific source file | [code/](code/index.md) — the survival layer |
| Know *why* it's built this way | [decisions/](decisions/index.md) |
| Sign-in / session flow | [auth/](auth/index.md) |
| Debug a production incident | [runbooks/](runbooks/index.md) |
| Follow the team's conventions | [processes/](processes/index.md) |
| How the agent role chain works (roles, /feature, gates, breaker) | [processes/agent-roles.md](processes/agent-roles.md) — role prompts in `.claude/agents/`, the orchestrator in `.claude/commands/feature.md` |
| Find a Case's spec mirror (agent-chain handoff fallback) | [specs/](specs/index.md) |
| See the orchestrator's live run-state | [state/](state/index.md) → `current_feature.md` — ephemeral run-ledger, not documentation |
| See the UI component catalog | [ui/](ui/index.md) → [ui/catalog/](ui/catalog/index.md) (generated) |
| Find a dirty-Excel fixture's edge case | [excel-edge-cases/](excel-edge-cases/index.md) |
| See current doc coverage / drift | run `sh tools/audit.sh` — `doc-coverage-audit` reports per-pillar % + stubs / staleness |

---

## The survival layer (`code/`)

One doc per source file — the cross-rewrite + agent-onboarding layer
(`code/.../joins.md` is what let the join feature be rebuilt across multiple
RedPash incarnations). Held fresh by the **touch-policy** (edit a source file →
update its atomic doc in the same commit).

- [code/index.md](code/index.md) — the dir map + up-links to each file's spine page.
- [code/_nav.md](code/index.md) — the generated back-index of every atomic doc (`doc-gen --code-nav`).
- [code/_template.md](code/_template.md) — copy + fill the 3 required headings to author one.

---

## Archive

Superseded shape-layout docs (architecture · subsystems · specs · flows ·
observability · cases · jira-flow-proposition) are frozen under
[archive/legacy/](archive/index.md) — their keepers were ported into the spine
above. Read the spine first; reach for archive only for un-ported historical detail.
