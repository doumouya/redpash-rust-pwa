---
title: tools/connectors-audit/audit.js
source: ../../../../../tools/connectors-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-05
---

# connectors-audit

## Purpose

The structural guard for **connector-through-framework** (`CAS_A4448B94`). The
Kafka loader once called `db::insert_file` directly, bypassing RBAC, the
`file_upload` audit event, and the org-rule cascade. The fix routes every
producer through [`pipeline::upload_csv`](../backend/api/pipeline.md); this audit
makes that fix **sticky** — it fails `sh tools/audit.sh` if any connector reaches
for the storage layer again, so the next connector can't quietly reintroduce the
bypass.

## Public surface

(What it scans + the rule it enforces — this audit has no exported API; its
"surface" is the scan scope + verdict below.)

### What it scans

Every `.rs` file under `backend/crates/` or `connectors/` whose path is under
`connectors/` **or** whose basename contains `loader` / `connector`
(`kafka_loader.rs` today; `*_loader.rs`, `*_connector.rs`, connector crates
tomorrow). Name-based + broad on purpose: a new connector is caught the day it
lands, no registry to maintain.

**Excluded:** the connector-REGISTRY management layer — `routes/connectors.rs` +
`db/connectors.rs` (both basename `connectors.rs`) — which legitimately CRUDs the
`connectors` table itself (`db::insert_connector` is the connector's OWN config
row, not file-data). It's not a loader/transport, so it's out of scope; the guard
targets producers that could write FILE data past `pipeline::upload_csv` (the
`*_loader.rs` files + the `connectors/` RC packages).

## The rule

A connector must NOT call a storage **mutation** directly —
`db::(insert|update|delete|ensure)_*`. Those carry the policy invariants that
live in the framework. A connector is thin transport: consume + decode, then
hand bytes to `pipeline::upload_csv`. Reads (`db::list_*` / `get_*` / `find_*`)
are fine.

- **green** — routes through `pipeline::` and has no `db::` mutation. ✓
- **yellow** — neither mutates nor routes (pure consumer / not yet ingesting) → read it.
- **red** — calls a `db::` mutation directly (the bypass). **BUG CLASS** → exit 1.

Framework code that legitimately calls `db::insert_file` (`pipeline.rs`, the
upload / join / snapshot route handlers) is not a connector by name, so it's not
scanned — the gate is connector-scoped by design.

## Drift-prone areas

- **Heuristic, not a parser** — regex + comment-strip (like `rs-audit` /
  `auth-audit`). Comments are stripped position-preserving, so a doc line that
  mentions `db::insert_file` is not a hit. A connector that builds SQL by hand
  (no `db::` helper) would slip; if that pattern appears, widen `MUTATION_RE`.
- **Connector detection is name-based.** A connector that doesn't match
  `loader`/`connector` and isn't under `connectors/` won't be scanned. Keep the
  naming convention, or add a marker if it ever drifts.
- **Mutation list** is `insert|update|delete|ensure`. A new storage-mutating
  `db::` verb (e.g. `db::upsert_*`) must be added to `MUTATION_RE`.

## Related

- [pipeline.rs](../backend/api/pipeline.md) — the path connectors must route through.
- [kafka_loader.rs](../backend/api/kafka_loader.md) — the first (green) connector.
- [list-endpoint-rbac-audit](list-endpoint-rbac-audit.md) — sibling structural RBAC detector.
