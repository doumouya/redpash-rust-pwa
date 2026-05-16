---
title: API overview
section: API
order: 0
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

| Page                       | Route prefix             | What's there |
|----------------------------|--------------------------|--------------|
| [Health](health.md)        | `/api/health`            | Liveness probe. |
| [Me](me.md)                | `/api/me`                | Session user profile + `resolve_user_rid` resolver spec. |
| [Auth](auth.md)            | `/api/auth/*`            | Google OAuth code flow + logout. |
| [Projects](projects.md)    | `/api/projects`          | Workspace list + project-scoped file list. |
| [Companies](companies.md)  | `/api/companies/*`       | Company CRUD + membership management (the multi-tenancy layer). |
| [Files](files.md)          | `/api/files/*`           | Upload, paged rows, cleaning steps, undo/redo, joins, snapshots. |
| [Reports](reports.md)      | `/api/reports/*`         | CRUD + live preview / run; the polymorphic source resolver. |
| [Dashboards](dashboards.md)| `/api/dashboards/*`      | Dashboard CRUD; widgets fetch data through `/api/reports`. |
| [Users](users.md)          | `/api/users/*`           | User directory + dev-permissive CRUD (powers Objects' Users tab + owner-reassign picker). |

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
| `missing_source`    | 400  | `/reports/preview` with neither `source_file_id` nor `source_report_id` |
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
| `/api/me`                 | Session cookie → user; OAuth-disabled → bootstrap `dev_user`; OAuth-enabled + no session → 401. `PATCH /api/me` updates the session user only. |
| `/api/projects`, `/api/reports`, `/api/dashboards` (list) + `/api/files/upload` | Same resolver as `/api/me`. |
| Everything else (`/api/{projects,reports,dashboards,files}/:rid/*`) | Resolves the user via `resolve_user_rid` **and** calls `routes::ensure_owner` against the matching `db::*_owner(rid)` lookup. 404 with `kind="not_found"` on miss *or* owner mismatch — same message either way so existence isn't leaked. |
| Cross-resource handlers (`/reports` create + update, `/reports/preview`, `/files/:rid/joins` POST, `/dashboards` create) | Gate on the ownership of **every** referenced RID, not just the path. |

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

List endpoints (`/api/projects`, `/api/reports`, `/api/dashboards`)
return `{ "items": [...] }` without paging — user-owned counts are
bounded.

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

## What's not here

- **`/api/docs`** — the frontend's docs viewer calls `/api/docs` and
  `/api/docs/:slug`, but the backend route isn't wired yet. Today the
  docs page falls back to serving static markdown via `ServeDir`; the
  rendered-HTML endpoint is planned (the `data::render::doc` helper +
  `pulldown-cmark` + `syntect` + `gray_matter` deps are already in
  place, just not mounted).
