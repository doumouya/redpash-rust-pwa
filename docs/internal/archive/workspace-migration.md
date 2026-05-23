---
title: Workspace migration — execution plan
section: Internal — RedPash team only
order: 90
last modified date: 2026-05-22
---

# Workspace migration — execution plan

> **Status — active.** The unified surface is no longer a parked
> concept; the team has greenlit the migration. The *what* is locked in
> [unified-surface.md](../frontend/unified-surface.md) — this doc is the
> *how*: workstreams, owners, sequencing, and the discipline that keeps
> an app-wide refactor from turning into open-ended debt.

## What we're migrating

RedPash today is four separate pages — Cleaner, Reports (Designer),
Dashboards, and the Objects browse surface. The migration collapses
them onto **one page: the Workspace.**

Same `rp-topbar`, same `rt-nav` side trail. The body is a *render
target* — a table, a chart, or a dashboard, depending on the open
file's type. The side panels carry the toolsets. "Cleaner" and
"Designer" stop being pages; they become *which file you have open*.

**Working proof:** the `red-front` prototype
(`github.com/doumouya/red-front`) — the Workspace shell, standing, in
vanilla JS, at ~6–8 components.

## The model it rests on

Four decisions from the prototype work make the migration sound rather
than cosmetic:

- **The redtable is a query builder.** Every control emits a structured
  query node (filter = `WHERE`, sort = `ORDER BY`, …). The clicks build
  an AST; the engine — Polars now, SQL on a connected DB later — is a
  swappable compile target.
- **A file is an immutable base + a view.** The raw upload is never
  mutated; cleaning builds a view definition over it. Report and
  Dashboard were already derived views — the cleaned file becomes one
  too.
- **Versioning is the operation log**, not the data. A file = a base +
  a replayable, branchable history of operations.
- **Joins are `project_id`-scoped.** Files sharing a `project_id` are
  joinable — the project *is* the boundary. No parent-table machinery.

## The discipline — non-negotiable

"Extend the refactoring to all the code" is a debt trap *unless* it is
bounded. Open-ended refactoring never converges — there is always more
to improve, and "improve the code" has no finish line.

This migration converges only because every workstream is
**decomposition into a finite, named set of parameterised atoms** — not
"make it better," but "produce *this* closed list of components, then
stop." A workstream is done when its component inventory is closed. A
workstream that cannot name its finite set is not ready to start.

The redtable refactor already proved the shape: the whole surface is
~6–8 atoms. Every other part of the app gets the same treatment — a
finite atom set, or it does not get touched.

## Workstreams

The migration runs as parallel code audits feeding a frontend
decomposition.

| # | Workstream | Owner | Artifact |
|---|------------|-------|----------|
| 1 | Rust code audit — factorisation candidates | Gus | `backend/suggestion-rust-factorisation.md` |
| 2 | JS code audit — factorisation candidates | Woz | `docs/internal/js-refactor-review.md` |
| 3 | Panel decomposition — disassemble the side panels into atoms | frontend | — |
| 4 | Docs — this plan + uncaging `unified-surface.md` | Torv | this doc |

### Workstream 3 — panel decomposition (first UI step)

The side panels are the densest, least-factored part of the surface.
The filter panel, the tools panel, and the chart-config accordion get
disassembled into named atoms — the same way the redtable became
`rt-nav`, `rt-toolbar`, `rp-table`, `rt-pager`. The output is a closed
component inventory for the panels; nothing more open-ended than that.

## Sequencing

1. **Audits first.** Gus (Rust) and Woz (JS) produce their
   factorisation candidate lists. The audits define the finite sets;
   the decomposition executes against them.
2. **Panel decomposition** — workstream 3 — is the first UI workstream,
   run against `red-front` as the reference shell.
3. **Page-by-page migration** — Cleaner, then Designer, then the browse
   surface — onto the Workspace, once the atom set is closed.
4. **Docs track each step** — REDMAP and INDEX stay in sync per commit;
   `unified-surface.md` moves out of `redpash-canary/` into
   `docs/frontend/` as it goes active.

## Status

- **Concept** — locked, [unified-surface.md](../frontend/unified-surface.md).
- **Prototype** — done, `red-front`.
- **This plan** — active.
- **Workstreams 1 & 2** — code audits in progress (Gus, Woz).
- **Workstream 3** — panel decomposition, next.
