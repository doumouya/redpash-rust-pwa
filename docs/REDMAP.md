# REDMAP — docs ⇄ code

Scan this before diving. It tells you **which doc covers which code area**, and
**where the code lives**. The flat one-line-per-doc list is in [INDEX.md](INDEX.md).

**Rule:** when a doc and the code disagree, the **code wins** — file the drift.
`tools/doc-coverage-audit` guards the mechanical part (index completeness + the
retired next-era naming — the old `*-next` doc titles and the `*_next` DB name).

## doc ⇄ code-area cross-reference

| Doc | Code area(s) it maps to |
|---|---|
| `decisions/day-one.md` | `backend/migrations/`; `backend/crates/api/src/{rbac,objects,field_perms}.rs`; `backend/crates/shared/src/filter.rs` |
| `decisions/client-data-engines.md` | `backend/crates/data/src/wasm.rs`; `frontend/wasm/`; `frontend/wasm-src/gluesql/`; `frontend/framework/engine/` |
| `decisions/registry-redundancy.md` | `backend/crates/api/src/{objects,types,pipeline}.rs` |
| `decisions/vision.md` | `backend/crates/data/`; `frontend/apps/studio/workspace/` (the Upload→Clean→Visualise spine the vision drives) |
| `privacy/privacy-by-design.md` | `tools/privacy-audit/`; cross-cuts the F-A…F-L code areas (`db,cases,event,designer.rs`, `migrations/`, `frontend/`) |
| `privacy/assessment-2026-06-16.md` | dated review of the same surface as `privacy/privacy-by-design.md` |
| `decisions/disposability-requires-a-ledger.md` | `tools/capability-audit/`; `docs/internal/capability-ledger.md` |
| `internal/capability-ledger.md` | `tools/capability-audit/audit.js`; the whole tree (every capability as a key) |
| `internal/parity-review-2026-06-20.md` | the `prerelease` ↔ `lean` refs (the graduation diff) |
| `internal/code/backend/README.md` | `backend/crates/{api,data,shared}/` (the workspace) |
| `internal/code/backend/api-routes.md` | `backend/crates/api/src/{auth,me,group,objects,types,rail,search,projects,admin}.rs` + `files/` |
| `internal/code/backend/data-engine.md` | `backend/crates/data/src/{steps/,group_by,wasm}.rs`; `backend/crates/shared/src/filter.rs` |
| `internal/code/backend/connectors.md` | `backend/crates/api/src/{connectors_core,mysql_loader}.rs` |
| `internal/code/backend/schema.md` | `backend/migrations/`; `backend/crates/api/src/{db,type_cache}.rs` |
| `internal/code/backend/redpash-id.md` | `backend/crates/api/src/id.rs`; `backend/crates/api/src/{objects,db}.rs` (mint paths); `backend/migrations/` (the `type_definitions.rid_prefix` seed) |
| `internal/code/backend/rbac.md` | `backend/crates/api/src/{rbac,session,field_perms,type_cache,db}.rs` |
| `internal/code/backend/objects.md` | `backend/crates/api/src/{objects,types,type_cache}.rs` |
| `internal/code/backend/cases.md` | `backend/crates/api/src/cases.rs`; `backend/crates/api/src/pipeline.rs` (attachments) |
| `internal/code/backend/messaging.md` | `backend/crates/api/src/messaging.rs`; `backend/migrations/20260618000000_messaging.sql` |
| `internal/code/backend/monitoring.md` | `backend/crates/api/src/monitoring.rs`; `backend/crates/api/src/bin/audit_ingest.rs`; `backend/migrations/20260617000001_audit_monitoring.sql` |
| `internal/code/frontend/README.md` | `frontend/index.html`; `frontend/framework/{boot,registry,page-assembly}/` |
| `internal/code/frontend/components.md` | `frontend/framework/` (all `rp-*` components); `frontend/styles/tokens.css` |
| `internal/code/frontend/conventions.md` | `tools/ui-fork-audit/`; `tools/ci.sh`; `frontend/styles/`; `frontend/framework-sandbox.html` |
| `internal/code/frontend/data-cleaner.md` | `frontend/apps/studio/workspace/`; `frontend/framework/{column-manager,sql-editor,engine}/` |
| `internal/code/tools/README.md` | `tools/` (the whole tree) — `tools/ci.sh`; `tools/ci-audit/`; `tools/*-audit/`; `tools/{purity-check,build-wasm,build-wasm-gluesql,build-fe,test-fe}.sh`; `tools/lib/`; `tools/mcp-server/`; `tools/wasm-bench/`; `tools/hooks/` |
| `internal/specs/*` | the work item's own target area (named in the spec) |
| `internal/runbooks/0011-object-kind-prefix-mismatch.md` | `backend/crates/api/src/type_cache.rs`; `backend/crates/api/src/id.rs` |
| `internal/runbooks/0012-connector-gate-ssrf-encodings.md` | `backend/crates/api/src/connectors_core.rs`; `backend/crates/api/src/mysql_loader.rs` |
| `internal/runbooks/0023-polars-0.54-wasm-fork.md` | `backend/Cargo.toml`; `backend/crates/data/`; `tools/purity-check.sh` |
| `internal/runbooks/objects-scope-parent-idor.md` | `backend/crates/api/src/objects.rs`; `backend/crates/api/tests/objects_idor.rs` |
| `decisions/target-architecture.md` | `backend/crates/api/src/{objects,types}.rs`; `backend/migrations/` |
| `decisions/object-model.md` | `backend/crates/api/src/{objects,types,pipeline}.rs`; `backend/migrations/` |
| `internal/auth/dev-user.md` | `backend/crates/api/src/{auth,bootstrap,state}.rs` |
| `internal/auth/google.md` | `backend/crates/api/src/{auth,session}.rs` |
| `internal/runbooks/0007-column-drag-reorder-cluster.md` | `frontend/framework/redtable/`; `frontend/framework/grid-view/` |
| `internal/runbooks/0009-cleaning-type-coercion-regression.md` | `backend/crates/data/src/{clean,steps/util,steps/cells}.rs` |
| `internal/runbooks/0010-rbac-admin-nest-privilege-escalation.md` | `backend/crates/api/src/{admin,monitoring,rbac}.rs` |
| `internal/runbooks/0022-admin-scope-registry-list.md` | `backend/crates/api/src/{objects,rail}.rs` |

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
  decisions/   locked architectural decisions
  archive/     retired docs (history only — e.g. the graduated ROADMAP)
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
