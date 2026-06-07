---
title: REST API — internal
section: Internal
last modified date: 2026-06-07
---

# REST API

The HTTP surface of the backend (`backend/crates/api`, axum). One area for
every `/api/*` resource: the **route table is generated** from the live code,
the **conventions and per-resource WHY are hand-written**.

> Migrating in from the public `docs/api/*` tier (CAS_701CF65E). Per-resource
> docs land here in Phase C; the generated route table lands in Phase B.

## Generated route table

The full method × path × handler × RBAC-gate inventory, generated from
`tools/lib/rust-routes.js` (the same extractor `crossing-audit` /
`list-endpoint-rbac-audit` / `api-doc-audit` consume — one source of truth).

<!-- doc-gen:api:index START -->
_(generated — run `node tools/doc-gen/gen.js --api`)_
<!-- doc-gen:api:index END -->

## Conventions (hand-written)

- **Auth** — session cookie; `is_platform_admin` gate on admin routes; the
  RBAC gate per route is shown in the generated table.
- **Pagination** — `{ items, total, page, size }` envelope.
- **Errors** — `AppError` → wire shape; see [`code/backend/api/error.md`](../code/backend/api/error.md).
- **IDs** — RedPash-ID prefixes (`USR_`, `PRJ_`, `CAS_`, …); see [`stack/db`](../stack/index.md).

## Per-resource

_(one `<resource>.md` per API resource — ported from `docs/api/*` in Phase C.)_

## Source files

- [`code/backend/api/`](../code/index.md) — the route handlers (the survival-layer deep dives).
