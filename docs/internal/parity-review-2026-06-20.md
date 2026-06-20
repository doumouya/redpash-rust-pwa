# Prerelease → lean parity review (2026-06-20)

The `lean` graduation (`fbd9f5e`, 2026-06-16) wiped the prerelease-derived tree and
re-landed a clean rebuild **from memory**. This is the dated diagnostic: what the
rebuild actually dropped vs what it merely refactored. The evergreen source of truth it
seeds is [`capability-ledger.md`](capability-ledger.md); the rule it motivates is
[`decisions/disposability-requires-a-ledger.md`](../decisions/disposability-requires-a-ledger.md).

## Method (and the load-bearing caveat)

`prerelease` (`7dc2f80`) is lean's **ancestor**; `lean` = +64 commits including the
graduation wipe. The comparison is **concept/capability-level, human-verified against the
lean tree** — NOT a route/module/file set-diff.

**Why not a set-diff:** it over-reports massively — it reads *refactor · consolidate ·
rename* as "removed." A naive pass flagged ~14 "critical losses" that all **exist in
lean**: the object registry (`type_definitions`/`type_fields`/`entity_data`),
`company_rbac`, `field_permissions`, the `connectors`/`connector_jobs` tables,
`request_log`/`db_query_log`/`events`; the per-entity routes (`/api/users,/teams,
/companies,/members`) were *consolidated* into the generic `/api/objects/:type` handler;
`secrets` became `crypto.rs`. **This is the whole reason the ledger (not memory, not a
naive tool) is required.**

Each prerelease capability is classified: **in-lean** (same/refactored/renamed/
consolidated) · **genuinely-lost** · **intentionally-dropped** · **net-new-in-lean** ·
**deferred**.

## Genuinely lost (the real backlog)

The losses form one coherent cluster — the **connector/codec/validation lineage** — plus
the doc archive. Disposition (re-land / drop / defer) is roadmap-dependent and is Em's
per-item call; left **deferred** here pending that.

| Capability | Significance | Verified state in lean | Disposition |
|---|---|---|---|
| `codec_registry` + `codec_avro` (pluggable codec system + Avro meta-codec) | High | absent — the only `codec`/`avro` hits are `data/src/parse` + `encoding.rs` (CSV/encoding, not the codec system) | deferred |
| `kafka_loader`, `postgres_loader` (connector loaders) | High | absent — lean has only `connectors_core.rs` (SSRF/TLS gate) + `mysql_loader.rs` (stub) | deferred |
| `/api/connectors` **feature surface** (CRUD / test / sync / jobs routes + UI) | High | **schema-ready but UNWIRED** — the `connectors` + `connector_jobs` tables + the gate + a MySQL stub exist; no `/connectors` route is mounted in `main.rs` | deferred |
| `validate_expr` / `validate_rules` / `field_validate` (standalone validators) | Med | absent — `objects.rs` has inline registry field-validation only; the validator layer is gone | deferred |
| `redact` (sensitive-data redaction) | Med | absent — **also the privacy F-I "data_class-keyed log redaction" go-live follow-up (same gap, two lenses)** | deferred |
| `db_query` capture module (query-observability writer) | Med | partial — the `db_query_log` table exists + `retention.rs` reaps it; the **writer that populated it is gone** | deferred |

## Refactored / renamed (NOT losses — corrected false positives)

`dedup.rs` → `distinct.rs`. Plus the naive-diff false positives above: the object
registry, `company_rbac`, `field_permissions`, the `connectors`/`connector_jobs` tables,
`request_log`/`db_query_log`/`events` tables — all present; per-entity routes →
`/api/objects/:type`; `secrets` → `crypto.rs`.

## Intentionally dropped (deliberate graduation cuts)

- `opfs-spike` + the `wasm-bench` perf experiments — Low (experiments, reproducible).
- The 100+ archived **specs / decision / flow / investigation docs** — Med, *knowledge*
  at risk (not capability): esp. the object-metadata specs, `datasource-trait`,
  `monitoring-schemas`. Recoverable from the `prerelease` ref / `lean-pre-graduation` tag;
  consider salvaging the load-bearing specs into the ledger's references.

## Net-new in lean (not a regression — a different tree)

cases · messaging · designer · monitoring + the `audit.*` Postgres trail · the privacy
layer (`privacy-audit` + `crypto`/rotation/retention bins) · the apps/pages FE refactor
(6 apps) · the object-registry-served generic CRUD.

## Outcome

The concern is valid but **bounded and nameable** — a focused ~6-item cluster, not the
14 the raw diff produced. Nothing here is committed as a re-land; the durable fix is the
[capability ledger](capability-ledger.md) + the reproducible parity audit, so the next
rebuild reconciles against a record instead of memory. Re-land decisions: Em, per-item,
roadmap-driven (connectors first if they're returning). Tracked on CAS_1D79.
