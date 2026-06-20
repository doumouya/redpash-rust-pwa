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

**bin** — `bin:redpash-api` `bin:redpash-audit-ingest` `bin:redpash-retention`
`bin:redpash-rotate-secrets`

**data-mod** — `data-mod:clean` `data-mod:distinct` `data-mod:dtype` `data-mod:encoding`
`data-mod:error` `data-mod:export` `data-mod:filter` `data-mod:group_by` `data-mod:joins`
`data-mod:parse` `data-mod:search` `data-mod:sentinels` `data-mod:sort` `data-mod:sql`
`data-mod:stats` `data-mod:steps` `data-mod:structure` `data-mod:view` `data-mod:wasm`

**db-table** — `db-table:audit.finding` `db-table:audit.run` `db-table:case_attachments`
`db-table:case_comments` `db-table:cases` `db-table:channel_reads` `db-table:channels`
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
Recorded here so they're remembered, not lost. Re-land is Em's per-item, roadmap call;
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
