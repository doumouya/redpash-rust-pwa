# Backend — the three-crate workspace

The backend is one Cargo workspace of three crates, split by responsibility so the
same engine can run on the server and in the browser:

- **`api`** — the Axum edge. Mounts the `/api` routers (`backend/crates/api/src/main.rs`),
  owns sessions/RBAC/CSRF, hydrates frames per `rid`, and serves the static frontend
  as a fallback. All io/http/state lives here.
- **`data`** — pure compute over Polars. Cleaning steps, group-by/reports, the
  canonical `FilterNode`, and the page view. **No io/http/threads/time** — that
  purity is what lets it compile to wasm32 and run client-side, byte-identical to
  the server (`tools/purity-check.sh` guards it).
- **`shared`** — the DTOs both sides serialize (`ReportSpec`, `FilterNode`,
  `QuerySpec`, …), so the wire shape has exactly one definition.

The contract both surfaces speak is the **page shape** `{ columns, rows, total }`
(`rows` = arrays of stringified cells aligned to `columns`) — emitted identically
by `data::view::page` on the server and by the wasm `Workbook` in the browser.

This README is the index. The detail lives in the sibling topic docs below; the
frontend's-eye view of the same surface is in
[`../frontend/backend.md`](../frontend/backend.md) (the monolith these docs split).

## Topic docs

| Doc | Covers |
|---|---|
| [`api-routes.md`](api-routes.md) | The `api` crate's HTTP surface — the full `/api` route catalog (auth, `/me`, files + steps/undo/redo/export/sql/joins, `group/preview`, rail/search/settings/types/objects/projects/admin/health), the page-shape contract, and the auth/RBAC model (opaque `rp_session` cookie, leak-free 404 denials). |
| [`data-engine.md`](data-engine.md) | The `data` crate (compute) — the `steps::apply` cleaning-op dispatch, `group_by::execute` + `ReportSpec`, the canonical recursive `FilterNode`, and the `data::wasm` resident client engine (`Workbook`). |
| [`connectors.md`](connectors.md) | Ingest paths feeding the one file write-path — how external sources reach `pipeline::upload_csv` through the framework layer (RBAC, audit, post-upload cascade) rather than the storage layer. |

## DC3 needs NO new backend

DC3 ships entirely on the surface above — no new routes, no new wasm wrappers:

- **Reports** → `POST /api/group/preview` with a `ReportSpec`.
- **Every clean op** → `POST /api/files/:rid/steps` with `{kind, params}` — `kind`
  is free-form text, so a new op needs no DB/DTO/route change; it routes through
  the existing `data::steps::apply` dispatch.
- **Nested AND/OR filters** → the recursive `FilterNode`, consumed identically by
  `/files/:rid/page`, the `filter_rows` step, `group/preview`'s pre-filter, and
  wasm `filter_page` — so DC3c's nesting is a frontend-only change.
