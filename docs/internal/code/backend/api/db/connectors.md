---
title: backend/crates/api/src/db/connectors.rs
source: ../../../../../../backend/crates/api/src/db/connectors.rs
owner: Torv
section: Internal · Code · backend · api · db
last modified date: 2026-06-05
---

# connectors.rs

## Purpose

`connectors` table CRUD — the persisted connection (Kafka today; S3 / DB-CDC
later) that holds the **user's chosen destination project**, so the Kafka loader
reads it instead of the `load.sh` env hardcode. This is the framework half of
connector-through-framework: the connector behaves like a real UI upload, and a
UI upload asks which project (Em 2026-06-04).

A connector is a first-class entity in the polymorphic registry (`type =
'connection'`), so it follows the same invariants as projects/cases: register the
entity BEFORE the subtype row in one transaction; delete via `delete_entity`
(cascades). The cluster SASL creds stay in the connector's `.env` for the RC;
this row carries only the user-facing config (name / topic / destination project
/ as_user). RBAC on the destination is enforced at create time (the route) and at
load time (`pipeline::upload_csv`) — the same write-reach check a UI upload uses.

## Public surface

- `struct ConnectorSummary` — the list/detail DTO (Serialize → JSON for the FE).
- `struct ConnectorLoadCfg` — the loader's read shape (destination project +
  as_user + topic + kind).
- `pub fn insert_connector` — register the `connection` entity + insert the
  subtype row in one tx (mirrors `insert_project`).
- `pub fn list_connectors` — connectors the caller can reach (same reach as
  `list_projects`: platform admin / direct project membership / company cascade).
- `pub fn get_connector` — the full summary for one connector (route detail).
- `pub fn get_connector_load_cfg` — the minimal destination the loader routes
  through; `None` if the connector doesn't exist (the loader fails loudly).
- `pub fn rename_connector` — `UPDATE connectors SET name`; returns `true` if a row
  changed. Route gates on Admin+ reach.
- `pub fn delete_connector` — `DELETE FROM entities` type-guarded to a `connectors`
  row, so the subtype cascades off the registry FK and a non-connector id is a no-op
  (`false`). Mirrors `delete_project`. Route gates on Admin+ reach.

## Drift-prone areas

- **Reach must mirror `list_projects`.** A connector should appear exactly where
  its destination project does. If `db::projects::list_projects`'s reach clauses
  change (admin / direct-membership / company cascade), update `list_connectors`'
  three `EXISTS` predicates in lockstep — they were copied to keep parity.
- **Create order is load-bearing.** `register_entity` must run before the
  `connectors` INSERT (the PK FKs into `entities`); both inside the tx. Diverging
  re-introduces the FK-ordering bug the entity registry exists to prevent.
- **`config` JSONB is forward-compat, currently unused by the loader.** Kafka
  transport (bootstrap/creds/contract/wire-format) stays in `.env` for the RC;
  when those move into the connection, put them in `config` + read them in
  `kafka_loader::Cfg::from_connection` — don't add columns per kafka knob.
- **`as_user` ≠ `created_by` is allowed but unused today.** The route sets both
  to the caller; a future "service-account load" path would diverge them, at
  which point the create-time RBAC check (caller's reach) and the load-time check
  (`as_user`'s reach) become two distinct gates — keep both.

## Related

- [routes/connectors.rs](../routes/connectors.md) — the `/api/connectors` surface.
- [db/projects.rs](projects.md) — the `insert_project` pattern this mirrors + the `list_projects` reach.
- [db/entities.rs](entities.md) — `register_entity` / `delete_entity`.
- [kafka_loader.rs](../kafka_loader.md) — `Cfg::from_connection` reads `get_connector_load_cfg`.
