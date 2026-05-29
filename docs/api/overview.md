---
title: API overview
section: API
order: 0
last modified date: 2026-05-29
---

# API overview

All endpoints are JSON, prefixed with `/api`, mounted on the Axum
router in [`crates/api/src/routes/mod.rs`](../../backend/crates/api/src/routes/mod.rs).
Static frontend assets are served from the same port via
`tower_http::ServeDir`, so `cargo run -p api` brings the whole app up
on `:8080`.

This page is the **map**. Each resource has its own page with full
request/response detail.

---

## Resources

| Page                         | Route prefix             | What's there |
|------------------------------|--------------------------|--------------|
| [Health](health.md)          | `/api/health`            | Liveness probe. |
| [Me](me.md)                  | `/api/me`                | Session user profile + memberships + prefs + `resolve_user_rid` resolver spec. |
| [Auth](auth.md)              | `/api/auth/*`            | Google OAuth code flow + logout + (dev) login-as. |
| [Projects](projects.md)      | `/api/projects`          | Workspace list + project-scoped file list. Ownership is a `memberships` row now. |
| [Companies](companies.md)    | `/api/companies/*`       | Company CRUD + member management (multi-tenancy layer; members live in the unified `memberships` table). |
| [Files](files.md)            | `/api/files/*`           | Upload, paged rows, cleaning steps, undo/redo, joins, snapshots. |
| [Charts](charts.md)          | `/api/charts/*`          | Saved-chart CRUD — chart-typed `project_files` rows (`CHT_…`). Replaces the retired Reports surface. |
| [Dashboards](dashboards.md)  | `/api/dashboards/*`      | Dashboard CRUD; dashboards are now dashboard-typed `project_files` rows (`DSH_…` preserved). |
| [Cases](cases.md)            | `/api/cases/*`           | Cases + comments (the Jira-flow workstream). Reporter + case-owner live in `memberships`. |
| [Users](users.md)            | `/api/users/*`           | User directory + dev-permissive CRUD. |
| [Events](events.md)          | `/api/events/*`          | Runtime observability log — BE 4xx/5xx + lifecycle, FE `POST /api/events`. |
| [Monitoring](monitoring.md)  | `/api/monitoring/*`      | Requests / events / db_query_log / audit-runs / audit-findings / optimization / user-activity / case-categories — the Monitoring page surface. |
| [Admin](admin.md)            | `/api/admin/*`           | Admin reads — paginated users/companies/memberships/steps lists with stats. |
| [Reports](reports.md)        | *(retired)*              | The `reports` table was dropped in `drop_reports` (mig 016); reports are now derived views over csv-typed `FIL_…`. Saved charts moved to [Charts](charts.md). The page is kept for historical reference. |
| Docs (no per-page doc)       | `/api/docs/*`            | Public — serves the markdown tree under `docs/` as an index (`GET /api/docs`) + rendered HTML per slug (`GET /api/docs/:slug`). Drives the in-app docs viewer at `#/docs`. |

---

## Cross-cutting

### Error shape

Every error response uses the same JSON envelope (`shared::ApiError`):

```json
{ "error": "report RPT_… does not exist", "kind": "not_found" }
```

`kind` is a snake-case discriminant the frontend's `api.js` switches
on. The full set (from `api::error::AppError` + `From<DataError>`):

| `kind`              | HTTP | Where it comes from |
|---------------------|------|---------------------|
| `not_found`         | 404  | RID missing |
| `bad_request`       | 400  | Generic shape error |
| `invalid_spec`      | 400  | `data::DataError::InvalidSpec` — column refs in filter/sort/agg don't resolve |
| `invalid_csv`       | 400  | `data::DataError::Polars` — Polars couldn't parse/process the frame |
| `encoding_failed`   | 400  | `data::DataError::Encoding` — chardetng / encoding_rs failed |
| `invalid_encoding`  | 400  | User-supplied encoding label isn't recognised by `encoding_rs` |
| `unauthenticated`   | 401  | OAuth enabled, `rp_session` missing/expired |
| `oauth_disabled`    | 503  | `GOOGLE_OAUTH_*` env vars not all set, but an `/auth/google/*` route was called |
| `oauth_denied` / `oauth_no_code` / `oauth_no_state` / `oauth_no_state_cookie` / `oauth_state_mismatch` / `oauth_token_rejected` | 400 | Various OAuth callback failures |
| `oauth_token_request` / `oauth_token_decode` / `oauth_userinfo_*` | 500 | Network/decode failures against Google |
| `missing_source`    | 400  | Chart preview with no `source_file_id` (legacy — was also raised by `/reports/preview`, which retired with mig 016) |
| `missing_file` / `multipart` / `too_large` | 400 | Upload validation |
| `db`                | 500  | Postgres error |
| `io`                | 500  | Disk read/write error |
| `join`              | 500  | `tokio::task::spawn_blocking` panic |
| `internal`          | 500  | Catch-all (`From<anyhow::Error>`) |

### Auth

| Endpoint family           | Auth model |
|---------------------------|------------|
| `/api/health`             | Public. |
| `/api/auth/*`             | Public (mints the session). |
| `/api/me`                 | Session cookie → user; OAuth-disabled → bootstrap `dev_user`; OAuth-enabled + no session → 401. `PATCH /api/me` / `PATCH /api/me/prefs` update the session user only. |
| `/api/projects`, `/api/charts`, `/api/dashboards`, `/api/cases` (list) + `/api/files/upload` | Same resolver as `/api/me`. |
| Everything else (`/api/{projects,charts,dashboards,files,cases}/:rid/*`) | Resolves the user via `resolve_user_rid` **and** calls `routes::ensure_owner` against the matching `db::*_owner(rid)` lookup. Owner resolution reads from `memberships WHERE role='owner'` (post-mig 024) — there's no `owner_id` column anymore. 404 with `kind="not_found"` on miss *or* owner mismatch — same message either way so existence isn't leaked. |
| Cross-resource handlers (`/charts` create + update, `/files/:rid/joins` POST, `/dashboards` create) | Gate on the ownership of **every** referenced RID, not just the path. |

### Cookies

| Cookie             | Set by              | Max-Age   | Flags                                |
|--------------------|---------------------|-----------|--------------------------------------|
| `rp_oauth_state`   | `/auth/google/start`   | 600s   | HttpOnly · Path=/ · SameSite=Lax     |
| `rp_session`       | `/auth/google/callback`| 2592000s | HttpOnly · Path=/ · SameSite=Lax    |

`Secure` is off in dev. See [auth.md](auth.md) for the toggle when
deploying behind HTTPS.

### Pagination envelope

The redtable page endpoint follows `shared::Page<T>`:

```jsonc
{
  "rows":        [...],
  "total":       137,
  "all_count":   101234,
  "page":        1,
  "size":        25,
  "pages":       6,
  "ms":          12,
  "row_indices": [...]
}
```

List endpoints (`/api/projects`, `/api/charts`, `/api/dashboards`,
`/api/companies/:rid/members`) return `{ "items": [...] }` without paging —
user-owned counts are bounded. Paginated endpoints (`/api/cases`,
`/api/admin/*`, `/api/monitoring/*`, the redtable page endpoint) use the
`Page<T>` envelope.

### Body & rate limits

- **Body limit:** 256 MiB (`DefaultBodyLimit::max` in [`routes/mod.rs`](../../backend/crates/api/src/routes/mod.rs)).
- **Rate limiting:** none today. The plan is to add a simple per-user
  ceiling when public sign-up lands (Phase 4c+).

### Layers (outside-in)

1. `CompressionLayer` — brotli / gzip for JSON + static assets.
2. `CorsLayer::permissive()` — tightened via env in prod (TODO).
3. `TraceLayer::new_for_http()` — structured access logs via `tracing`.
4. `DefaultBodyLimit::max(256 MiB)` on the `/api` subtree.

---

