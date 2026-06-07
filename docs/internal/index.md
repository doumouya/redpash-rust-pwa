---
title: Internal docs — index
section: Internal
order: 0
last modified date: 2026-06-07
---

# RedPash internal docs

The single team-only knowledge base. Organized by a **feature/page logic**,
not by document-shape — you navigate by *"what part of the product is this?"*
and *"how does this specific file work?"*, not by *"is this a spec or a
flow?"*.

> **Rebuild in progress (CAS_701CF65E).** This tree is being rewritten from
> the old shape-based layout (architecture / subsystems / specs / flows / …)
> into the feature/page spine below, and the public `docs/` tier is being
> folded in (one tier, not two). Sections under **Transitional** are being
> migrated and then deleted — don't add new docs there; add to the spine.

## The two axes

- **The feature/page spine** — hand-written WHY + UI + business logic, one
  area per feature and one folder per shipped page. This is where you start.
- **The per-file survival layer** ([`code/`](code/index.md)) — one doc per
  source file under `tools/` · `frontend/scripts/` · `backend/crates/`. This
  is the **cross-rewrite + agent-onboarding layer**: `code/.../joins.md` is
  what let RedPash's join feature be rebuilt across multiple incarnations
  (clarna-django, ubuntu22, …). Kept first-class, made navigable, and held
  fresh by the **touch-policy** (edit a source file → update its atomic doc
  in the same commit; see [`processes/atomic-doc-plan.md`](processes/atomic-doc-plan.md)).

The spine links *down* into `code/` (each spine page ends with a **Source
files** section); `code/` links *up* via the generated
[`code/_nav.md`](code/index.md) back-index + an optional `feature:`
front-matter field. Plus cross-cutting **shelves** that aren't feature-bound:
runbooks, processes, decisions, archive.

**Generated facts can't drift.** DB schemas, the REST route table, the UI
component catalog, and the page→rail inventory are emitted into
`<!-- doc-gen:… START/END -->` regions by `tools/doc-gen`; the hand-written
WHY lives around them and is never overwritten.

## Sections

| Section | What it holds | Generated? |
|---|---|---|
| [rest-api](rest-api/index.md) | the HTTP surface — route table + per-resource conventions, auth, pagination, errors | route lists generated (`--api`) |
| [auth](auth/index.md) | sign-in paths — Google OAuth + the dev-user/bootstrap path | hand-written |
| [db](db/index.md) | the data model — per-object [schemas](db/schemas/index.md) (schema generated + field/business-logic prose) + [RBAC](db/rbac/index.md) (entity / memberships / teams / permission contract) | schemas generated (`--schema`) |
| [stack](stack/index.md) | the code explanation at SYSTEM granularity — front-end / back-end / tools / db, and the deep per-subsystem prose | hand-written |
| [pages](pages/index.md) | the feature-per-page spine — one folder per shipped page + the shared chrome (topbar, rail-footer) | rail inventory generated (`--pages`) |
| [code](code/index.md) | **the survival layer** — one doc per source file; lives as long as the file does, refreshed in the touching commit (touch-policy) | nav back-index generated (`--code-nav`) |
| [runbooks](runbooks/index.md) | operational / incident playbooks — one per incident class (cross-cutting shelf) | hand-written |
| [processes](processes/index.md) | how the team works — touch-policy, audit cadence, bug→case→runbook, push policy, lane ownership | hand-written |
| [decisions](decisions/index.md) | the durable **why** — design choices that bind future work (the keepers from the old `architecture/`) | hand-written |
| [archive](archive/index.md) | snapshots no longer load-bearing | frozen |

## Transitional — migrating into the spine (CAS_701CF65E)

These are the old shape-based sections, still present until their content is
ported (Phase C) and they're deleted (Phase E). **Don't add new docs here.**

| Section | Migrating to |
|---|---|
| [architecture](architecture/index.md) | durable "why" → [decisions](decisions/index.md); FE/shell patterns → [stack/frontend](stack/index.md) |
| [subsystems](subsystems/index.md) | per-system prose → [stack](stack/index.md) or the owning [page](pages/index.md) |
| [specs](specs/index.md) | schemas → [db/schemas](db/schemas/index.md), RBAC → [db/rbac](db/rbac/index.md), page IA → [pages](pages/index.md), wire contracts → the owning subsystem |
| [flows](flows/index.md) | cross-system traces → the owning [page](pages/index.md) / subsystem |
| [ui](ui/index.md) | the generated component catalog stays under `ui/catalog/`, linked from [pages](pages/index.md) |
| [observability](observability/index.md) | runtime visibility → [pages/monitoring](pages/index.md) + [stack/backend](stack/index.md) |
| [cases](cases/index.md) | agent operating playbook → [pages/cases](pages/index.md) + [processes](processes/index.md) |
| [excel-edge-cases](excel-edge-cases/index.md) | fixtures triage — kept; referenced from [stack/backend](stack/index.md) |
| [jira-flow-proposition](jira-flow-proposition/index.md) | frozen proposition → [archive](archive/index.md) |
| [standup](standup/index.md) | retired (empty) → deleted in Phase E |

> Agent memory (`team-memory.md`, the `memory/` files, `.remember/`) is NOT
> part of this doc tree — it's operational agent state, not documentation.

## How to navigate

- *What does this part of the product do / how does this page work?* → [pages](pages/index.md)
- *What's the HTTP surface?* → [rest-api](rest-api/index.md)
- *What's the data model / who can do what?* → [db](db/index.md)
- *How does this subsystem work under the hood?* → [stack](stack/index.md)
- *How does this specific source file work?* → [code](code/index.md) (the survival layer)
- *Why is it built this way?* → [decisions](decisions/index.md)
- *Something broke — what do I do?* → [runbooks](runbooks/index.md)
- *How do we work as a team?* → [processes](processes/index.md)
- Full map: [redmap](redmap.md).

## Adding a new doc

1. Pick the **feature/page** it belongs to (rest-api / auth / db / stack /
   pages) — not a document-shape. Cross-cutting? → runbooks / processes /
   decisions.
2. Filename: lowercase-kebab. Frontmatter: `title`, `section: Internal`,
   `last modified date`.
3. Link it from that section's `index.md` and, if cross-cutting, from
   [redmap](redmap.md).
4. If you're documenting a source file, that's an atomic [code](code/index.md)
   doc — the touch-policy carries it; link it from the owning spine page's
   **Source files** section.
5. Don't hand-write what a generator emits (schemas / routes / component
   catalog / rail inventory) — edit the source of truth and re-run `doc-gen`.

## Lane ownership

Per [`processes/docs-lane-ownership.md`](processes/docs-lane-ownership.md) —
each agent is SME for their own lane's docs; don't centralise updates under
one editor. The atomic [code](code/index.md) docs follow the code: whoever
edits a source file updates its atomic doc in the same commit (touch-policy).
