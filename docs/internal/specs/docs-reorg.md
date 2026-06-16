# CASE — Docs: reorganize hierarchy + add INDEX.md/REDMAP.md + reconcile against code

> **Filed on-disk** (the cases MCP backend returned HTTP 405 — the separate
> redpash-api cases instance is down/version-skewed). Promote to a DB case via
> `case_create` when it's back. Filed 2026-06-16.

- **Type:** task &nbsp;·&nbsp; **Priority:** medium &nbsp;·&nbsp; **Status:** backlog &nbsp;·&nbsp; **Source:** internal

## Why

The `docs/` tree grew organically and is lopsided + partly stale after the
next→lean graduation and the lean page-cut.

**Current state (`docs/`):**
- `ROADMAP.md`; `decisions/{client-data-engines, day-one, registry-redundancy}.md`;
  `internal/code/frontend/{README, backend, components, conventions, data-cleaner}.md`.
- `backend.md` sits **misplaced** under `code/frontend/`; there is no backend docs
  home, no per-area index, no top-level map.
- No `INDEX.md` or `REDMAP.md` anywhere in `docs/`.
- **Known drift:** `CLAUDE.md` still titled "RedPash-next"; the frontend docs lag the
  code (column-manager, DC3b/DC3c, the just-landed registry "derive-all-fields" change
  + the MySQL connector conduit); likely references to lean-cut-removed pages and the
  now-dropped `redpash_next` DB.

## Acceptance criteria

1. **Coherent hierarchy** grouped by area (`decisions/`, `code/frontend/` +
   `code/backend/`, `processes/`); `backend.md` relocated to a backend home; no
   orphans / duplicates.
2. **`docs/INDEX.md`** — one-line-per-doc navigable index, kept current.
3. **`docs/REDMAP.md`** — the structural map (REDMAP-style: scan-before-dive) of the
   docs tree + the code areas each doc maps to.
4. **Reconciled against code** — every doc checked; stale refs fixed (RedPash-next
   naming, removed pages, the registry/connector/DB changes) or explicitly flagged.
5. **Repeatable check** — extend/wire `tools/doc-coverage-audit` so doc↔code drift
   fails a gate, not the user.

## Lanes / flow

Docs-lane ownership (whoever last worked an area writes its docs). Suggested next
step: run `/feature` on this case, or assign.
