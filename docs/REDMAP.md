# REDMAP — docs ⇄ code

Scan this before diving. It tells you **which doc covers which code area**, and
**where the code lives**. The flat one-line-per-doc list is in [INDEX.md](INDEX.md).

**Rule:** when a doc and the code disagree, the **code wins** — file the drift.
`tools/doc-coverage-audit` guards the mechanical part (index completeness + the
retired next-era naming — the old `*-next` doc titles and the `*_next` DB name).

## doc ⇄ code-area cross-reference

| Doc | Code area(s) it maps to |
|---|---|
| `ROADMAP.md` | whole repo — the rebuild plan, cross-cuts every crate + the frontend |
| `decisions/day-one.md` | `backend/migrations/`; `backend/crates/api/src/{rbac,objects,field_perms}.rs`; `backend/crates/shared/src/filter.rs` |
| `decisions/client-data-engines.md` | `backend/crates/data/src/wasm.rs`; `frontend/wasm/`; `frontend/wasm-src/gluesql/`; `frontend/framework/engine/` |
| `decisions/registry-redundancy.md` | `backend/crates/api/src/{objects,types,pipeline}.rs` |
| `privacy/privacy-by-design.md` | `tools/privacy-audit/`; cross-cuts the F-A…F-L code areas (`db,cases,event,designer.rs`, `migrations/`, `frontend/`) |
| `privacy/assessment-2026-06-16.md` | dated review of the same surface as `privacy/privacy-by-design.md` |
| `internal/code/backend/README.md` | `backend/crates/{api,data,shared}/` (the workspace) |
| `internal/code/backend/api-routes.md` | `backend/crates/api/src/{auth,me,group,objects,types,rail,search,projects,admin}.rs` + `files/` |
| `internal/code/backend/data-engine.md` | `backend/crates/data/src/{steps/,group_by,wasm}.rs`; `backend/crates/shared/src/filter.rs` |
| `internal/code/backend/connectors.md` | `backend/crates/api/src/{connectors_core,mysql_loader}.rs` |
| `internal/code/frontend/README.md` | `frontend/index.html`; `frontend/framework/{boot,registry,page-assembly}/` |
| `internal/code/frontend/components.md` | `frontend/framework/` (all `rp-*` components); `frontend/styles/tokens.css` |
| `internal/code/frontend/conventions.md` | `tools/ui-fork-audit/`; `tools/ci.sh`; `frontend/styles/`; `frontend/framework-sandbox.html` |
| `internal/code/frontend/data-cleaner.md` | `frontend/apps/studio/workspace/`; `frontend/framework/{column-manager,sql-editor,engine}/` |
| `internal/specs/*` | the work item's own target area (named in the spec) |

## Repo layout (scan-before-dive)

```
backend/
  crates/api/     Axum edge: routes, RBAC gate, pipeline, connectors, admin
  crates/data/    pure-compute Polars engine (wasm32 purity gate enforced)
  crates/shared/  DTOs both sides serialize (FilterNode, QuerySpec, ReportSpec, SortKey)
  migrations/     designed schema; checksum-protected — never edited post-apply

frontend/
  framework/   rp-* components + boot/ + registry/ + engine/ + page-assembly/
  apps/        pages: studio/workspace, admin/{org,console,registry,cases}, auth, …
  styles/      tokens.css + main.css (the @import manifest) + base.css
  wasm/        built Polars + GlueSQL wasm (content-hashed); wasm-src/ holds the sources

docs/
  INDEX.md     flat one-line-per-doc index
  REDMAP.md    this file
  ROADMAP.md   the rebuild plan
  decisions/   locked architectural decisions
  internal/
    code/{backend,frontend}/   per-area code docs
    specs/                     work items / specs

tools/
  ci.sh             the gate (purity-check + cargo + ui-fork-audit + test-fe + build-fe; + doc-coverage)
  *-audit/          the audit suite (ui-fork, css, js, html, rs, doc-coverage, …)
  build-*.sh        hashed FE build + the two wasm builds
  purity-check.sh   wasm32 cargo check for the data crate
  wasm-bench/       wasm-vs-native data-engine benchmarks
```
