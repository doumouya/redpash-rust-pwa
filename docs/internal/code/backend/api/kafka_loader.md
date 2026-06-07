---
title: backend/crates/api/src/kafka_loader.rs
source: ../../../../../backend/crates/api/src/kafka_loader.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-07
---

# kafka_loader.rs

## Purpose

The **Kafka loader** — the **L** of ETL for the first connector
(`connectors/kafka-confluent-rc`, JLR Account stream; CAS_75A0D1FD follow-on).
One-shot batch: consume → decode → load.

```
rskafka consume (Confluent Cloud, SASL_SSL/PLAIN; all partitions, earliest)
  → per-record: read schema VERSION from the Kafka header
  → codec_avro::decode against THAT version's contract (never a fixed default)
  → records_to_csv      (decoded JSON records → tabular CSV, UNION of all versions' fields)
  → pipeline::upload_csv (the framework upload path — RBAC + audit, NOT db:: directly)
  → a project_files row (a File, per [object-model])
```

**Routes through the framework, not the storage layer** (`CAS_A4448B94…`,
`[[connector-through-framework]]`). `ingest_csv` hands the CSV to
[`pipeline::upload_csv`](pipeline.md) AS `KAFKA_AS_USER` with `caller_is_admin=false`,
so the load is RBAC-checked (the as-user must hold ≥Member write-reach on the
target project) and emits a `file_upload` audit event — exactly like a UI upload.
A connector can no longer silently land data in a project the caller can't reach.

**Version comes from the header, never a default.** Each record's writer schema
version is read from its Kafka headers (`header_version` — explicit
`KAFKA_VERSION_HEADER` key, else auto-detect a key containing "version"). The
record is decoded against `contracts/{subject}-v{version}.json` for THAT version.
A record with no resolvable version (or no contract file for it) is **skipped +
logged, never decoded against a guessed schema** — raw Avro is schema-shaped, so
a wrong version silently misaligns every field after an add/delete. CSV columns
are the UNION of all decoded records' fields, so a field deleted in a newer
version just yields empty cells (no misalignment). The first record's full
headers are logged each run so the version-source key is always visible.

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

`KAFKA_CONTRACT` now only locates the contracts **dir** (its parent) + the
subject base; the actual schema per record is resolved by VERSION from the
header. Optional: `KAFKA_MAX_RECORDS` (500); `KAFKA_VERSION_HEADER` (explicit
header key — omit to auto-detect a "version" key). The runner
`connectors/kafka-confluent-rc/load.sh` wires all of this + tees to
`results/load-<UTC>.log`, and logs the first record's headers so the version key
is visible.

## Public surface

- `pub struct Cfg` + `from_env()` — all loader config from `KAFKA_*` env, incl.
  `as_user` (`KAFKA_AS_USER`, REQUIRED — the RBAC-checked upload identity).
- `pub async fn Cfg::from_connection(pool, connection_id)` — build from a
  persisted connection (a `CON_` rid). The user-CHOSEN destination (project +
  as_user) come from the `connectors` row. **Non-secret TRANSPORT now rides the
  `config` JSONB (the established connector pattern), env as fallback:**
  `config.bootstrap` (else `KAFKA_BOOTSTRAP`), `config.security_protocol` (default
  `SASL_SSL`, validated by `validate_security_protocol` — any other value is a LOUD
  error, never a silent plaintext downgrade), topic = the `topic` column → `config.topic`
  → `KAFKA_TOPIC`. **SASL creds:** the username (`config.sasl_user`) is plaintext config,
  the **secret is ENCRYPTED at rest** (`config.sasl_secret_enc`) and decrypted via
  [`secrets::decrypt`](secrets.md) — a present-but-undecryptable secret is a LOUD error,
  never a silent skip; both fall back to the `.env` `KAFKA_KEY`/`KAFKA_SECRET` when the
  config keys are absent (legacy RC). The Avro contract still rides `.env` (flagged
  follow-up). Guards `kind == "kafka"`. `main.rs` uses this when
  `REDPASH_KAFKA_CONNECTION` is set, else `from_env` (the legacy hardcode).
- `fn validate_security_protocol(Option<&str>)` — only `SASL_SSL` is wired
  (`consume_raw` mandates TLS); absent → ok (default), anything else → loud error.
- `pub fn load_contract_schema(path)` — the Avro schema JSON from a Confluent
  envelope's `.schema` (or a bare schema file).
- `pub fn schema_field_names(schema)` — top-level field names IN ORDER (the CSV
  column order, matching the producer's schema).
- `pub fn records_to_csv(records, columns)` — flatten decoded records to CSV;
  scalars → cells, nested arrays/objects → compact JSON string; RFC-4180 quoting.
- `pub async fn ingest_csv(pool, data_dir, caller, project, filename, csv)` — the L:
  hands the CSV to `pipeline::upload_csv` AS `caller` (`caller_is_admin=false`),
  which does RBAC + blob + parse + summarize + insert + audit → returns the rid.
- `pub async fn run(pool, data_dir, cfg) -> Result<Option<String>>` — orchestrate
  consume → decode → csv → ingest, with a logged summary. Returns the new file rid
  (`Some`) so the in-app sync handler can report it, or `None` when 0 records were
  decoded (nothing loaded — the sync handler maps that to a clear "no records" response,
  not a file). The CLI mode discards it.

- `pub async fn probe(cfg) -> Result<()>` — the "Test connection" action
  (`POST /api/connectors/:rid/test`): reuses `build_client` + `list_topics`, verifies
  `cfg.topic` is visible to the creds, **consumes no records** (the kafka analogue of
  mysql's `SELECT 1`).

Private: `build_client` (the single-copy SASL_SSL + mandatory-TLS rskafka client build,
shared by `consume_raw` + `probe` — never fork the fail-closed TLS path);
`consume_raw` (rskafka fetch across the topic's partitions, earliest→high-watermark).

## Drift-prone areas

- **Live consume is operator-run.** The E hop talks to a real Confluent cluster
  and pulls PII; it's verified by a run against the cluster, not in CI. The T+L
  core (`records_to_csv`, `schema_field_names`, decode→csv→parse) is unit-tested
  offline.
- **Nested → JSON-string cells.** Account's `telephone[]`/`email[]`/… land as a
  JSON string in their column (the redtable/cleaner can expand later). If a
  consumer needs columnar nested data, that's a transform-step decision, not a
  loader change.
- **All-partitions, earliest-offset, one-shot.** `consume_raw` discovers the
  topic's partitions via `list_topics()` and walks EACH from its real earliest
  offset (`get_offset(Earliest)`) to latest. This is required, not optional: the
  data is spread across partitions (a single-partition fetch finds nothing —
  `high_watermark: -1`) and `offset 0` is `OffsetOutOfRange` once retention prunes
  (the first live run hit both). Resume-across-runs (persisted per-partition
  checkpoint) + consumer-group rebalancing are deferred — this is a one-shot
  batch; revisit at streaming scale.
- **TLS is mandatory + fail-closed.** SASL PLAIN sends credentials in cleartext,
  so the client MUST ride TLS (Confluent Cloud = SASL_SSL). `consume_raw` builds a
  rustls `ClientConfig` (ring provider, webpki-roots CA store) and passes it via
  `.tls_config(...)` BEFORE `.sasl_config(...)`; there is **no plaintext fallback**
  — if TLS setup fails the run errors out rather than leaking creds. Needs
  rskafka's `transport-tls` feature + a `rustls 0.23` dep mirroring rskafka's
  (default-features off, `ring`). (Flagged by the commit security review — the
  first cut omitted TLS.)
- **rskafka 0.6 API**: `SaslConfig::Plain(Credentials::new(...))`,
  `tls_config(Arc<rustls::ClientConfig>)` (transport-tls feature),
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
