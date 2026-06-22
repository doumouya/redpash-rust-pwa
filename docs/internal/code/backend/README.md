# Backend — the three-crate workspace

The backend is one Cargo workspace of three crates, split by responsibility so the
same engine can run on the server and in the browser:

- **`api`** — the Axum edge. Mounts the `/api` routers (`backend/crates/api/src/main.rs`),
  owns sessions/RBAC/CSRF, hydrates frames per `rid`, and serves the static frontend
  as a fallback. All io/http/state lives here. The `/api` router carries two layers —
  a CSRF **origin guard** (`middleware::origin_guard`, on state-changing methods) and a
  256 MiB body limit — and requests trace as structured JSON; the DB pool + the
  load-bearing startup order live in `state.rs` (schema.md → Connection & startup).
- **`data`** — pure compute over Polars. Cleaning steps, group-by/reports, the
  canonical `FilterNode`, and the page view. **No io/http/threads/time** — that
  purity is what lets it compile to wasm32 and run client-side, byte-identical to
  the server (`tools/purity-check.sh` guards it).
- **`shared`** — the DTOs both sides serialize (`ReportSpec`, `FilterNode`,
  `QuerySpec`, …), so the wire shape has exactly one definition.

The contract both surfaces speak is the **page shape** `{ columns, rows, total }`
(`rows` = arrays of stringified cells aligned to `columns`) — emitted identically
by `data::view::page` on the server and by the wasm `Workbook` in the browser.

This README is the index. The detail lives in the sibling topic docs below
(split out from the former `frontend/backend.md` monolith).

## Topic docs

| Doc | Covers |
|---|---|
| [`api-routes.md`](api-routes.md) | The `api` crate's HTTP surface — the full `/api` route catalog (auth, `/me`, files + steps/undo/redo/export/sql/joins, `group/preview`, rail/search/settings/types/objects/projects/cases/monitoring/admin/health), the page-shape contract, and the auth/RBAC model (opaque `rp_session` cookie, leak-free 404 denials). |
| [`data-engine.md`](data-engine.md) | The `data` crate (compute) — the `steps::apply` cleaning-op dispatch, `group_by::execute` + `ReportSpec`, the canonical recursive `FilterNode`, and the `data::wasm` resident client engine (`Workbook`). |
| [`connectors.md`](connectors.md) | Ingest paths feeding the one file write-path — how external sources reach `pipeline::upload_csv` through the framework layer (RBAC, audit, post-upload cascade) rather than the storage layer. |
| [`cases.md`](cases.md) | The `/api/cases` surface — the agent-handoff workflow engine (workflows-as-DATA, transition map keyed by `source`, PATCH enforces `to ∈ transitions[from]` → 422), the 5 case endpoints + `GET /workflows`, and metadata-only attachments (no customer bytes in Postgres; sealed `pipeline::upload_attachment`; per-attachment IDOR guard). |
| [`objects.md`](objects.md) | The polymorphic object registry — `/api/objects/:type[/:rid]` as ONE handler set over every registered type; the `entity_data` JSONB store vs the org-builtin TYPED tables on one wire shape, the generic CRUD path + the `scope_parent_id` IDOR guard, read-only registry types (file/project/case) with `registry_display_fields` + the `HIDDEN_COLUMNS` denylist, the reach-scoped list shape, and the field gate (RBAC depth in `rbac.md`). |
| [`schema.md`](schema.md) | The Postgres data model — the entity-registry spine, the data-driven type registry (`type_definitions`/`type_fields`), the polymorphic `entity_data` store vs. typed subtype tables, the file pipeline tables + derived views, `memberships` as the RBAC substrate, and the `audit`/observability system schemas. |
| [`rbac.md`](rbac.md) | The authorization model — the entity+membership spine, reach resolution via `type_definitions.scope_parents`, `require_action`/`require_rule` + the day-one #3 IDOR guard, the leak-free 404 invariant, platform-admin bypass, and the per-role field-permission layer (`PermClass` + sparse overrides). |
| [`monitoring.md`](monitoring.md) | The in-app audit trail — the `audit` schema (run/finding/`run_diff`), the `redpash-audit-ingest` bin (explode contract + count-only gap), and the four platform-admin `/api/monitoring/*` endpoints. |

## DC3 needs NO new backend

DC3 ships entirely on the surface above — no new routes, no new wasm wrappers:

- **Reports** → `POST /api/group/preview` with a `ReportSpec`.
- **Every clean op** → `POST /api/files/:rid/steps` with `{kind, params}` — `kind`
  is free-form text, so a new op needs no DB/DTO/route change; it routes through
  the existing `data::steps::apply` dispatch.
- **Nested AND/OR filters** → the recursive `FilterNode`, consumed identically by
  `/files/:rid/page`, the `filter_rows` step, `group/preview`'s pre-filter, and
  wasm `filter_page` — so DC3c's nesting is a frontend-only change.
