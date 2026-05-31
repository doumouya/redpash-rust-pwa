---
title: Internal docs — index
section: Internal
order: 0
last modified date: 2026-05-31
---

# RedPash internal docs

The team-only counterpart to [public docs](../INDEX.md). Thirteen sections
plus this index, the [redmap](redmap.md), and [team-memory](team-memory.md)
(shared conventions, project state, and working-with-Em notes that every
Torv reads before opening a file). Each section captures a distinct
*shape* of document, not a topic. Mixing shapes is the smell the old
flat layout suffered from.

## Sections

| Section | Shape | Lifecycle |
|---|---|---|
| [architecture](architecture/index.md) | the **why** — design choices that bind future work | durable; supersession moves the doc to archive |
| [subsystems](subsystems/index.md) | the **how it works** — one doc per system | lives as long as the system does |
| [specs](specs/index.md) | the **what** — current wire contracts, schemas | rewritten when the contract changes |
| [flows](flows/index.md) | the **how data moves** — explicit cross-system traces | rewritten when the flow changes shape |
| [processes](processes/index.md) | how the team works | lives as long as the practice does |
| [runbooks](runbooks/index.md) | operational / incident playbooks | one per incident class |
| [standup](standup/index.md) | daily logs, one append-only file per contributor | never retired — history |
| [code](code/index.md) | the **what this file is** — one doc per source file under `tools/`, `frontend/scripts/`, `backend/crates/` | lives as long as the file does; refreshed in the touching commit (touch-policy) |
| [observability](observability/index.md) | the **runtime visibility** — events / request_log / db_query_log capture + investigation playbooks | lives as long as the runtime stack does |
| [cases](cases/index.md) | the **active workstream guide** — agent-facing operating playbook for the cases system | lives as long as the workstream is active |
| [excel-edge-cases](excel-edge-cases/index.md) | the **fixtures** — triage data: 22 dirty `.xlsx` fixtures × 41 edge-case classes | grows when a new edge class is encountered |
| [jira-flow-proposition](jira-flow-proposition/index.md) | the **design proposition** — one-off proposal that became the cases workstream | frozen reference once the workstream shipped |
| [archive](archive/index.md) | snapshots no longer load-bearing | frozen reference |

The thirteen categories answer different questions:

- *Why is it like this?* → architecture
- *How does X actually work?* → subsystems
- *What's on the wire?* → specs
- *How does data move from A to B?* → flows
- *How do we work?* → processes
- *Something broke, what do I do?* → runbooks
- *What happened yesterday?* → standup
- *Where's the deep-explanation for a specific source file?* → code
- *What's the runtime doing right now / what tools do I use to investigate?* → observability
- *How do I work the cases system as an agent?* → cases
- *What edge case in this dirty Excel file?* → excel-edge-cases
- *What was the original design proposition for cases?* → jira-flow-proposition
- *Where's that old doc?* → archive

## Lane ownership

Per `[[feedback_docs_lane_ownership]]` — each agent is the SME for
their own lane's docs. Don't centralise updates under one editor.

| Agent | Owns | Co-authors |
|---|---|---|
| **Gus** | most of `subsystems/` (api-routes, audit-storage, data-engine, events-and-logs, step-engine, wasm-engine), most of `specs/`, `runbooks/` he writes | `subsystems/omnisearch.md` (backend), `subsystems/prefs.md` (server table) |
| **Torv** | `architecture/`, `processes/`, `subsystems/workspace-shell.md`, page IA in `specs/admin-monitoring-surfaces.md` | `subsystems/omnisearch.md` (dropdown UI), `subsystems/prefs.md` (SWR + boot) |
| **Woz** (when active) | frontend audit tools (`subsystems/` slot when authored) | — |

## Audience-routed entry points

- **New engineer** → [redmap](redmap.md) → [architecture](architecture/index.md)
- **Implementing a feature** → relevant [subsystem](subsystems/index.md)
- **Debugging in prod** → [runbooks](runbooks/index.md)
- **Adding to the wire** → relevant [spec](specs/index.md)
- **Tracing a data path** → [flows](flows/index.md)
- **Following the team's conventions** → [processes](processes/index.md)

## Adding a new doc

1. Pick the section by **shape** (see the table above), not topic.
2. Filename: lowercase-kebab.
3. Frontmatter required: `title`, `section: Internal`, `last modified date`.
4. Link from that section's `index.md`.
5. If the doc is cross-cutting (touches multiple subsystems / flows),
   link from [redmap](redmap.md) under "Find by question" too.

## Public vs internal

Public docs live in `docs/` (rendered at `/docs`). Internal docs live
here (`docs/internal/`) and are team-only — they cover the **why** +
**internal mechanics** that don't belong in the user-facing surface.
The split per [`processes/docs-lane-ownership.md`](processes/docs-lane-ownership.md):

- *User-facing feature description* → public docs
- *Why we chose that feature shape* → internal architecture
- *How it works under the hood* → internal subsystem
- *Wire contract for the engineer extending it* → internal spec
