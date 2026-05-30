---
title: Internal · Code — one doc per source file
section: Internal · Code
order: 0
last modified date: 2026-05-30
---

# Code — atomic docs

The **9th shape** of internal docs (added 2026-05-30 — see the shape
ontology in [../index.md](../index.md)): one doc per source file under
`tools/`, `frontend/scripts/`, and `backend/crates/`. Each atomic doc
explains the *what this file is* — purpose, public surface, drift-prone
areas — at a granularity that supports onboarding, refactor planning,
and code review without re-reading the source.

**The plan** is at
[`../processes/atomic-doc-plan.md`](../processes/atomic-doc-plan.md) —
read it first if you're authoring or executing a phase. The
**template** is [`_template.md`](_template.md); copy it when starting a
new atomic doc. **Coverage and drift** are enforced by
[`tools/doc-coverage-audit/`](../../../tools/doc-coverage-audit/) — run
it via `sh tools/audit.sh` to see what's stubbed, stale, or missing.

## Discipline

Editing a source file requires updating its atomic doc *in the same
commit* (touch-policy, recorded in `CLAUDE.md`). `doc-coverage-audit`
flags `stale_doc` when a source has been touched more recently than
its doc by more than 14 days; `missing_breadcrumb` when the source
lacks a `Doc:` line pointing at this tree.

## Source → doc mapping

| Source | Atomic doc |
|---|---|
| `backend/crates/<crate>/src/path/file.rs` | [`backend/<crate>/path/file.md`](backend/) |
| `frontend/scripts/path/file.js` | [`frontend/scripts/path/file.md`](frontend/) |
| `tools/<name>-audit/audit.js` | [`tools/audit-suite/<name>-audit.md`](tools/) |
| `tools/<name>.sh` | [`tools/shell/<name>.md`](tools/) |
| `tools/{mcp-server,team,wasm-bench,memory-gc,parse-diag}/` | single per-dir doc in [`tools/`](tools/) |
| `tools/{css-parallel,css-usage,csv-to-xlsx-rs}/` | [`tools/one-off/<name>.md`](tools/) |

## Pillars

| Pillar | Source root | Atomic docs |
|---|---|---|
| [Backend](backend/index.md) | `backend/crates/{api,data,shared}/src/` | 80 files |
| [Frontend](frontend/index.md) | `frontend/scripts/` | 45 files |
| [Tools](tools/index.md) | `tools/` | 32 units |

Total at baseline (2026-05-30): **157 atomic units**, 0 of them
documented. The audit measures coverage % per pillar; Phases B/C/D walk
it up.

## In-source breadcrumb

Every documented source file carries a 2-line pointer back to its
atomic doc, in the comment style of the language:

```rust
//! Purpose: short one-liner — what this file is.
//! Doc: docs/internal/code/backend/api/routes/files/joins.md
```

```js
/* Purpose: short one-liner.
   Doc: docs/internal/code/frontend/scripts/api.md */
```

```bash
#!/usr/bin/env sh
# Purpose: short one-liner.
# Doc: docs/internal/code/tools/shell/audit.md
```

The breadcrumb closes the loop bidirectionally — the doc's front-matter
`source:` field points back at the source, and the source's `Doc:`
line points at the doc. `doc-coverage-audit` validates both directions.

## Related

- [Atomic-doc plan](../processes/atomic-doc-plan.md) — the spec
- [`tools/doc-coverage-audit/audit.js`](../../../tools/doc-coverage-audit/audit.js) — the enforcer
- [Shape ontology](../index.md) — how this section fits with the other 8
