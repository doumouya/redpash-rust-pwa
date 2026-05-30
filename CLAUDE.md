# Project conventions — RedPash

Agent-facing instructions. Treat as authoritative; check
[`docs/REDMAP.md`](docs/REDMAP.md) for the source-tree map and
[`docs/internal/index.md`](docs/internal/index.md) for the internal-docs
shape ontology.

---

## Touch-policy — atomic docs

**Editing a source file requires updating its atomic doc in the same
commit.** Source files live under `tools/`, `frontend/scripts/`, and
`backend/crates/`; each has a corresponding atomic doc under
`docs/internal/code/<mirrored-path>.md`. The full mapping rule and
the doc template are at
[`docs/internal/code/index.md`](docs/internal/code/index.md); the spec
is [`docs/internal/processes/atomic-doc-plan.md`](docs/internal/processes/atomic-doc-plan.md).

Drift is enforced by
[`tools/doc-coverage-audit/audit.js`](tools/doc-coverage-audit/audit.js):

- `missing_doc` / `missing_breadcrumb` — source has no atomic doc, or no `Doc:` line in its first 30 lines pointing back.
- `stale_doc` — source was touched more recently than the doc by more than 14 days (decision §10·2 of the plan).
- `wrong_breadcrumb` — `Doc:` line points to a path that doesn't match the mirror.

Run `sh tools/audit.sh` before commit to see coverage and drift; the
audit auto-discovers under the `tools/*-audit/` glob.

## In-source breadcrumb

Every documented source file carries a 2-line header:

```rust
//! Purpose: short one-liner.
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

## Other standing conventions

- **Audit-everything.** Run `sh tools/audit.sh` before commit. New
  static checks live as `tools/<name>-audit/audit.js` (auto-discovered).
  See [`docs/internal/processes/audit-cadence.md`](docs/internal/processes/audit-cadence.md).
- **Parallel-Torv commits.** Three Torv instances share the
  `prerelease` branch; commit named files with
  `git commit -o <pathspecs>` so parallel-staged WIP doesn't sweep into
  your commit. See [`docs/internal/processes/push-policy.md`](docs/internal/processes/push-policy.md).
- **Commit convention.** Subject: `area: imperative summary`; body:
  per-file changelog; sign `Co-Authored-By:` for AI contributors. See
  the recent commit log for the established shape.
- **No frameworks.** Stack is vanilla Rust + vanilla JS by deliberate
  choice. Tooling carve-out for static-analysis Node scripts under
  `tools/` (Acorn-style is fine there; nowhere else).
- **No service-worker cache bump in dev.** `frontend/service-worker.js`
  is install-only — frontend edits show up on a normal refresh.
- **JS↔Rust boundary is locked.** Rust owns data, JS owns pixels. JS
  never implements a data engine. See
  [`docs/internal/architecture/js-rust-boundary.md`](docs/internal/architecture/js-rust-boundary.md).

## Lane ownership

Per [`docs/internal/processes/docs-lane-ownership.md`](docs/internal/processes/docs-lane-ownership.md) —
each agent is SME for their own lane's docs; don't centralise updates
under one editor.
