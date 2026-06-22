# Capability ledger — what RedPash (lean) has

The **source of truth for what exists**, so disposability (cheap rebuilds) can't lose
things to memory. Every capability is one stable key `category:name`. The
[`capability-audit`](../../tools/capability-audit/audit.js) tool extracts the live
manifest from the tree and **diffs it against this file**, ratcheted in CI:

- a key here marked **live** but absent from the tree → **DROPPED** (a regression);
- a tree capability not here → **UNDOCUMENTED** (add it — nothing lives only in memory);
- a `[gap]` key that reappears in the tree → **RECOVERED** (promote it to live).

**Refresh after an intentional change:** `node tools/capability-audit/audit.js --init`
prints the current manifest; reconcile this file, then `--update-baseline`. The rule
behind this file: [`decisions/disposability-requires-a-ledger.md`](../decisions/disposability-requires-a-ledger.md).
The dated diagnostic that seeded it: [`parity-review-2026-06-20.md`](parity-review-2026-06-20.md).

## Present in lean (live)

**api-mod** — `api-mod:admin` `api-mod:auth` `api-mod:bootstrap` `api-mod:cases`
`api-mod:connectors_core` `api-mod:crypto` `api-mod:db` `api-mod:designer`
`api-mod:error` `api-mod:event` `api-mod:field_perms` `api-mod:files` `api-mod:group`
`api-mod:id` `api-mod:me` `api-mod:messaging` `api-mod:middleware` `api-mod:monitoring`
`api-mod:mysql_loader` `api-mod:objects` `api-mod:pipeline` `api-mod:projects`
`api-mod:rail` `api-mod:rbac` `api-mod:search` `api-mod:session` `api-mod:settings`
`api-mod:state` `api-mod:type_cache` `api-mod:types`

**api-route** — `api-route:admin` `api-route:auth` `api-route:cases` `api-route:channels`
`api-route:charts` `api-route:dashboards` `api-route:files` `api-route:group`
`api-route:me` `api-route:messages` `api-route:monitoring` `api-route:objects`
`api-route:projects` `api-route:rail` `api-route:search` `api-route:settings`
`api-route:types`

**bin** — `bin:redpash-api` `bin:redpash-audit-ingest` `bin:redpash-commit-ingest` `bin:redpash-retention`
`bin:redpash-rotate-secrets`

**data-mod** — `data-mod:clean` `data-mod:distinct` `data-mod:dtype` `data-mod:encoding`
`data-mod:error` `data-mod:export` `data-mod:filter` `data-mod:group_by` `data-mod:joins`
`data-mod:parse` `data-mod:search` `data-mod:sentinels` `data-mod:sort` `data-mod:sql`
`data-mod:stats` `data-mod:steps` `data-mod:structure` `data-mod:view` `data-mod:wasm`

**db-table** — `db-table:audit.finding` `db-table:audit.run` `db-table:case_attachments`
`db-table:case_comments` `db-table:case_docs_reconciled` `db-table:cases` `db-table:channel_reads` `db-table:channels`
`db-table:companies` `db-table:company_rbac` `db-table:connector_jobs`
`db-table:connectors` `db-table:db_query_log` `db-table:entities` `db-table:entity_data`
`db-table:events` `db-table:field_permissions` `db-table:memberships` `db-table:messages`
`db-table:project_files` `db-table:project_steps` `db-table:projects`
`db-table:request_log` `db-table:sessions` `db-table:settings` `db-table:teams`
`db-table:type_definitions` `db-table:type_fields` `db-table:type_scope_roles`
`db-table:user_preferences` `db-table:user_sentinels` `db-table:users`

**fe-page** — `fe-page:admin/cases` `fe-page:admin/console` `fe-page:admin/monitoring`
`fe-page:admin/registry` `fe-page:auth/login` `fe-page:messaging/messaging`
`fe-page:settings/settings` `fe-page:studio/designer` `fe-page:studio/workspace`

**skill** — `skill:polars-upgrade` `skill:redpash-frontend` `skill:rust-data-engine`
`skill:rust-object-registry-design`

**tool** — `tool:admin-scope-audit` `tool:api-doc-audit` `tool:auth-audit`
`tool:capability-audit` `tool:case-coverage-audit` `tool:class-count-audit`
`tool:claude-refs-audit`
`tool:connectors-audit` `tool:crossing-audit` `tool:css-audit` `tool:css-cross-page-audit`
`tool:css-tab-compare-audit` `tool:doc-coverage-audit` `tool:fe-framework-audit`
`tool:hooks` `tool:html-audit` `tool:js-audit` `tool:list-endpoint-rbac-audit`
`tool:mcp-server` `tool:observability-audit` `tool:page-structure-audit`
`tool:privacy-audit` `tool:rail-create-audit` `tool:redtable-audit`
`tool:retired-class-audit` `tool:rs-audit` `tool:rs-perf-audit` `tool:theme-coverage-audit`
`tool:ui-doc-audit` `tool:ui-fork-audit` `tool:ui-runtime-audit` `tool:ui-snapshot-audit`
`tool:uniformity-audit` `tool:wasm-bench`

## Known gaps (recorded — in prerelease, not yet in lean)

The genuine losses from the graduation (see [parity-review-2026-06-20](parity-review-2026-06-20.md)).
Recorded here so they're remembered, not lost. Re-land is Em's per-item call;
until then they are `[gap]` (expected-absent — not a regression). The connector schema
(`db-table:connectors`/`connector_jobs` + `api-mod:connectors_core`) IS live — what's
missing is the loaders/codecs/route/UI on top of it.

- `api-mod:codec_registry` `[gap]` — pluggable codec registry (string/int/.../enum/datetime/rid). High.
- `api-mod:codec_avro` `[gap]` — Avro meta-codec (Confluent + raw framing). High.
- `api-mod:kafka_loader` `[gap]` — Kafka ingestion loader (ETL L-hop). High.
- `api-mod:postgres_loader` `[gap]` — Postgres table-extraction loader. High.
- `api-route:connectors` `[gap]` — the `/api/connectors` feature surface (CRUD/test/sync/jobs). High. *(schema-ready, unwired)*
- `api-mod:validate_expr` `[gap]` — expression validator. Med.
- `api-mod:validate_rules` `[gap]` — rule validator. Med.
- `api-mod:field_validate` `[gap]` — codec-delegating field validator. Med. *(objects.rs has inline registry field-validation only)*
- `api-mod:redact` `[gap]` — sensitive-data redaction. Med. *(also privacy F-I "data_class-keyed log redaction")*
- `api-mod:db_query` `[gap]` — query-observability capture writer. Med. *(the `db_query_log` table + retention reaper are live; the writer is gone)*

### The connector vision (folded from the retired roadmap, Phase 4)

The cluster above isn't a pile of modules — it's one design the graduation dropped: a
connector is a **self-describing async job**, not in-request ETL. Re-landing means
(a) `connectors_core`'s SSRF/TLS host gate (12 tested bypass encodings) stays the entry
point — already live; (b) every credential is AEAD-encrypted via `crypto.rs` (the codec
shipped — see [`code/backend/schema.md`](code/backend/schema.md)), not plaintext JSONB;
(c) sync runs as `connector_jobs` rows (status poll/SSE), the loader extracting to a temp
file then through the SEALED `pipeline::upload_csv` (never `insert_file` directly — the
bypass class CAS_A4448B94); (d) the codec registry + Avro meta-codec decode the wire
format, the validators gate the fields. Order if they return: `connectors_core` (live) →
codecs → loaders → `/api/connectors` route + jobs runner → UI.

## Recoverable design references (prerelease archive)

The load-bearing **design specs** the graduation left in the prerelease archive — the
*why* behind the shipped lean code. **Reference-only**: the lean code is authoritative;
these are recoverable from the `prerelease` branch (the salvage the
[parity-review](parity-review-2026-06-20.md) flagged), not restored into the live spine.
Each names what it specced → where lean now implements it → its archive path (read with
`git show prerelease:<path>`). Verified against the lean tree 2026-06-22.

- `object-registry-framework` — the staged 0→3 arc making a new object type a data insert (custom CRUD + RBAC + audit, zero new code); lean-authoritative in `objects.rs` (the generic `/api/objects/:type` handler), `type_cache.rs` (registry-driven `object_kind` + cascade), `types.rs`, and the `type_definitions`/`type_fields`/`type_scope_roles`/`entity_data` tables. Self-service `POST /api/admin/types` registration is DEFERRED (a type is added by a DB-row insert; `admin.rs` exposes only `/fields`). Recoverable from `prerelease` at `docs/internal/archive/legacy/specs/object-registry-framework.md`.
- `type-definition` — the runtime-typed object contract (the TypeDefinition wire shape + the `perm_class`-derived field matrix + `data_type` write-validation); lean-authoritative in the `type_definitions`/`type_fields` tables, `type_cache.rs`, `types.rs` (`GET /api/types`), `field_perms.rs` (`PermClass`), and `objects.rs::validate_payload`. The v2 §8 field-validation pipeline (`ValidateRule`/`validate_expr`/`FieldDetector`) is DEFERRED — only the unconsumed `type_fields.validate jsonb` placeholder column exists. Recoverable from `prerelease` at `docs/internal/archive/legacy/specs/type-definition.md`.
- `rbac/permission-contract` — the per-company versioned-JSONB policy layer (horizontal team × object-type c/r/u/d grants) over the tier graph, read by one `require_action` evaluator plus the field-depth axis; lean-authoritative in `rbac.rs` (`Contract`, `require_action`, `evaluate`, `load_contract`) + `field_perms.rs`, the `company_rbac` & `field_permissions` tables, now endpoint-wired. Recoverable from `prerelease` at `docs/internal/archive/legacy/specs/rbac/permission-contract.md`.
- `rbac/entity-membership-model` — the polymorphic entity→entity→role edge + one reach-split resolver + one gate as the RBAC foundation; lean-authoritative in the `memberships` table (PK `object,member,role,context_role`), `entities`→`type_definitions`, the `enforce_one_department()` trigger, and `rbac.rs` (`resolve_grant`/`require_action`/`require_rule`). Lean evolved the spec's `require_grant`/`require_view` into `require_action` + the horizontal Contract. Recoverable from `prerelease` at `docs/internal/archive/legacy/specs/rbac/entity-membership-model.md`.
- `monitoring-schemas` — the observability tables (events, request_log, audit.run/finding, project_steps) + their DTOs/endpoints; lean-authoritative in `init.sql` (events/request_log/db_query_log) + `audit_monitoring.sql` (audit.run/finding + the `run_diff` fn) + `monitoring.rs` + `bin/audit_ingest.rs`. Diverges: `monitoring.rs` is audit-only (no `/events` or `/requests` endpoints), and pagination is ad-hoc `{items,total,page,size}`, not the spec's `Page<T>`. Recoverable from `prerelease` at `docs/internal/archive/legacy/specs/monitoring-schemas.md`.
- `datasource-trait` — **DEFERRED** (with the connector gap cluster above): a VFS-style multi-source abstraction (`Source`/`Entity`/`Reader` traits + push-down `Capabilities`) to unify files/Postgres/Sheets/S3/API behind one redtable query AST; NOT built on lean. What exists instead: the SSRF/TLS admission gate `connectors_core.rs` (`#![allow(dead_code)]`) + a `mysql_loader` stub + the schema-ready-but-unwired `connectors`/`connector_jobs` tables. Recoverable from `prerelease` at `docs/internal/archive/legacy/specs/datasource-trait.md`.
