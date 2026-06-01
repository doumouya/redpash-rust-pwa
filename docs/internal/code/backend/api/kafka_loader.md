---
title: backend/crates/api/src/kafka_loader.rs
source: ../../../../../backend/crates/api/src/kafka_loader.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-01
---

# kafka_loader.rs

## Purpose

The **Kafka loader** — the **L** of ETL for the first connector
(`connectors/kafka-confluent-rc`, JLR Account stream; CAS_75A0D1FD follow-on).
One-shot batch: consume → decode → load.

```
rskafka consume (Confluent Cloud, SASL_SSL/PLAIN)
  → codec_avro::decode  (the avro meta-codec; schema from the saved contract)
  → records_to_csv      (decoded JSON records → tabular CSV)
  → data::parse + db::insert_file  (the existing upload/import pipeline)
  → a project_files row (a File, per [object-model])
```

**Runs as a MODE of the main binary**, not a `src/bin`: a `src/bin` can't see
`main.rs`'s `codec_avro`/`db` modules, and the loader needs both. `main.rs`
checks `REDPASH_KAFKA_LOAD` early and runs the loader instead of serving HTTP,
then exits. Maximal reuse: the decoded records ride the same battle-tested
import path as a CSV upload.

Decisions: **rskafka** (Em 2026-06-01 — rdkafka needs cmake/librdkafka, absent;
rskafka is pure-Rust + SASL_SSL-capable). Schema from the connector's saved
`contracts/*.json` (data-contract-first), not a runtime registry. Rust-central
decode (js-rust-boundary) — the connector is thin transport.

## Run recipe

```sh
REDPASH_KAFKA_LOAD=1 \
DATABASE_URL=postgres://… REDPASH_DATA_DIR=./data \
KAFKA_BOOTSTRAP=… KAFKA_KEY=… KAFKA_SECRET=…        # reuse connector .env
KAFKA_TOPIC=topic_account_jlr \
KAFKA_TARGET_PROJECT=PRJ_… \
KAFKA_CONTRACT=connectors/kafka-confluent-rc/contracts/topic_account_jlr-value-v2.json \
KAFKA_WIRE_FORMAT=raw \                              # Em's producer; default confluent
  ./target/debug/redpash-api
```

Optional: `KAFKA_PARTITION` (0), `KAFKA_MAX_RECORDS` (500), `KAFKA_START_OFFSET` (0).

## Public surface

- `pub struct Cfg` + `from_env()` — all loader config from `KAFKA_*` env.
- `pub fn load_contract_schema(path)` — the Avro schema JSON from a Confluent
  envelope's `.schema` (or a bare schema file).
- `pub fn schema_field_names(schema)` — top-level field names IN ORDER (the CSV
  column order, matching the producer's schema).
- `pub fn records_to_csv(records, columns)` — flatten decoded records to CSV;
  scalars → cells, nested arrays/objects → compact JSON string; RFC-4180 quoting.
- `pub async fn ingest_csv(pool, data_dir, project, filename, csv)` — the L:
  write the blob + `data::parse::from_csv_bytes` + `data::dtype::summarize` +
  `db::insert_file` → returns the new file rid.
- `pub async fn run(pool, data_dir, cfg)` — orchestrate consume → decode → csv →
  ingest, with a logged summary.

Private: `consume_raw` (rskafka SASL_SSL fetch from one partition).

## Drift-prone areas

- **Live consume is operator-run.** The E hop talks to a real Confluent cluster
  and pulls PII; it's verified by a run against the cluster, not in CI. The T+L
  core (`records_to_csv`, `schema_field_names`, decode→csv→parse) is unit-tested
  offline.
- **Nested → JSON-string cells.** Account's `telephone[]`/`email[]`/… land as a
  JSON string in their column (the redtable/cleaner can expand later). If a
  consumer needs columnar nested data, that's a transform-step decision, not a
  loader change.
- **Single-partition, offset-based, one-shot.** v1 fetches one partition from
  `KAFKA_START_OFFSET`. Resume-across-runs (persisted checkpoint) + multi-partition
  + consumer-group rebalancing are deferred (rskafka's simple consume fits v1;
  revisit at streaming scale).
- **rskafka 0.6 API**: `SaslConfig::Plain(Credentials::new(...))`,
  `fetch_records(offset, bytes_range, max_wait_ms) -> (Vec<RecordAndOffset>, hwm)`,
  `record.value: Option<Vec<u8>>`. Pin checks here if the crate bumps.
- **Mode-of-main**, not a bin — because the loader needs `codec_avro`/`db`. If a
  lib crate is ever extracted, the loader could become a proper bin.

## Related

- [codec_avro.rs](codec_avro.md) — the decode the loader's T hop calls.
- [codec_registry.rs](codec_registry.md) — the open codec mechanism (`avro` is_meta).
- [main.rs](main.md) — the `REDPASH_KAFKA_LOAD` mode branch.
- [db/mod.rs](db.md) / [routes/files](routes/files/mod.md) — `insert_file` + the import path reused.
- [connectors/kafka-confluent-rc](../../../../connectors/kafka-confluent-rc/) — the transport + the saved `contracts/`.
