---
title: connectors/kafka-confluent-rc/
source: ./
owner: Torv
section: Internal · Code · Connectors
last modified date: 2026-06-01
---

# kafka-confluent-rc

**RedPash Connector** (the `-rc` suffix) — Kafka topic + Confluent Schema Registry source. The first concrete embodiment of [[datasource-trait]] (Gus's sketch); validates the connector trait shape against real production infrastructure.

## Origin: a spike that became a connector

Filed as a meta-codec resolver spike (CAS_ACAA76AA) to inform the v1.1 codec registry (CAS_75A0D1FD). After it ran against Em's actual Confluent Schema Registry + Kafka cluster (commit c0d6930), the framing shifted (2026-06-01) — the 5 phases ARE the shape of an extract-and-decode connector: schema discovery + read + decode + failure-mode contract + caching. Promoted from `connectors/kafka-confluent-rc/` to `connectors/kafka-confluent-rc/` to match its actual role. See [[etl-elt-roadmap]] memory update for the strategic reframing.

## Status

- **Working today**: phases 1-5 run end-to-end against the live cluster (schema discovery, cold-resolve latency, warm cache hit, failure modes, dual-decode of one message).
- **Missing for productionization**: load step (E**T**L → E**TL** — write decoded records into `project_files` rows via the v1.1 codec registry's wire-as-string contract); offset/checkpoint state for resume-across-runs; multi-partition consume.

When CAS_75A0D1FD codec registry ships, a 50-100 LOC sidecar around `spike.mjs` becomes a one-shot Kafka → RedPash loader. Em's call when to greenlight.

## What the spike measures (informed 7 design calls for v1.1 codec registry)

1. **Cache strategy** — per-process LRU vs unbounded (schemas immutable per ID) vs TTL.
2. **Cold-resolve failure mode** — registry unreachable on first sight of a schema_id. Fail the read? Serve bytes + `_codec_meta_unresolved: true`? Queue retry?
3. **Schema mutation invariant** — Confluent guarantees schema_id → schema is immutable. Does our codec contract require it or accommodate versioned `(schema_id, version)`?
4. **Retry policy** — exponential backoff? Circuit breaker per endpoint?
5. **Multi-registry support** — single endpoint per codec, or per-field `codec_meta.schema_url` override?
6. **FE-side resolution** — FE editor-registry resolves schemas, or editing of meta-codec fields is backend-mediated?
7. **NEW (surfaced by spike run 1)** — **wire-format detection**. Real producers use different framings (Confluent `{magic, schema_id}` vs raw Avro). Codec contract needs `wire_format: "confluent" | "raw"`.

## What the spike measures (6 design calls)

1. **Cache strategy** — per-process LRU vs unbounded (schemas immutable per ID) vs TTL.
2. **Cold-resolve failure mode** — registry unreachable on first sight of a schema_id. Fail the read? Serve bytes + `_codec_meta_unresolved: true`? Queue retry?
3. **Schema mutation invariant** — Confluent guarantees schema_id → schema is immutable. Does our codec contract require it or accommodate versioned `(schema_id, version)`?
4. **Retry policy** — exponential backoff? Circuit breaker per endpoint?
5. **Multi-registry support** — single endpoint per codec, or per-field `codec_meta.schema_url` override?
6. **FE-side resolution** — FE editor-registry resolves schemas, or editing of meta-codec fields is backend-mediated?

## How to run

### 1. Drop credentials in `.env`

`connectors/kafka-confluent-rc/.env` is gitignored. Copy `.env.example` → `.env` and fill in the values. The Confluent VS Code extension exposes the Schema Registry URL + API key in your cluster's "API keys" section (Cluster overview → Cluster settings → API keys / Schema Registry settings → API keys).

```sh
cp connectors/kafka-confluent-rc/.env.example connectors/kafka-confluent-rc/.env
$EDITOR connectors/kafka-confluent-rc/.env       # populate values
```

### 2. Install deps

```sh
cd connectors/kafka-confluent-rc && npm install
```

Deps: `@kafkajs/confluent-schema-registry` (wraps avsc + Confluent magic-byte wire format) + `kafkajs` (the consumer). The libs are connector-scoped — production codec usage is a separate v1.1 decision based on spike data. When backend codec registry ships, the FE bundle does NOT consume these (backend-mediated decode per design call 6).

### 3. Bootstrap contracts + drift detection

```sh
node spike.mjs bootstrap-contracts       # fetch + cache all schemas locally
node spike.mjs bootstrap-contracts diff  # compare local to registry, surface drift
```

**`bootstrap-contracts`** walks every (subject, version) on the registry with your `.env` credentials and saves each as `contracts/<subject>-v<n>.json` (envelope) + `contracts/<subject>-v<n>.avsc` (bare Avro schema) + `contracts/index.json`. After this runs once, the codec resolves schemas FILE-BASED at runtime with zero registry calls.

**`bootstrap-contracts diff`** is the **first write-aware capability** — compares the registry's current state to local files + surfaces:
- subjects added in registry (new producer schemas)
- subjects removed from registry (deleted upstream)
- versions added per subject (schema evolution we haven't pulled yet)
- content drift on a specific (subject, version) (shouldn't happen given Confluent's immutability invariant, catches local edits)

Read-only — does NOT modify either side. Run periodically (or wire into a cron / CI hook) to catch upstream schema changes.

**Why both modes exist** ([[data-contract-first]] memory): Schema Registry credentials are a **stewardship mandate**, not just a read pass. When a user grants us key+secret, they're delegating us to manage their schemas on their behalf. `bootstrap-contracts` is the read side; `bootstrap-contracts diff` is the drift-detection side; future `push <file>` will be the write side when we have a concrete trigger.

Re-run `bootstrap-contracts` (without `diff`) to refresh local from registry. Never ask the producer team to email schema files — use the credentials we already have.

### 4. Run the spike

```sh
node connectors/kafka-confluent-rc/spike.mjs                # all phases
node connectors/kafka-confluent-rc/spike.mjs phase1         # only subject discovery
node connectors/kafka-confluent-rc/spike.mjs phase2         # only cold-resolve latency
```

Results land in `results/run-<ISO>.json` (gitignored — they may contain schema content).

## Spike phases

| Phase | What it does | Design call answered |
|-------|--------------|---------------------|
| 1. Subject discovery | List subjects + schema count per subject | Sanity check (registry reachable + auth correct) |
| 2. Cold-resolve latency | Fetch N schemas with empty cache; time each | (1) Cache value: how much warm caching saves |
| 3. Warm cache hit | Re-fetch same N from cache | (1) Confirm cache is the right answer |
| 4. Failure-mode survey | Wrong URL / wrong auth / non-existent ID | (2) What does each failure look like, how do we handle it |
| 5. End-to-end Avro decode | Fetch schema + decode a sample message | Decode latency vs fetch latency |
| 6. Versioned schemas (if subjects have multiple versions) | Fetch v1 vs v2 of same subject | (3) Versioning behavior in practice |

Phases 4–6 surface depending on data availability; phases 1–3 always run.

## Status

Scaffolding shipped 2026-06-01. Awaiting `.env` population + initial run. Results sequence to addendum on CAS_ACAA76AA.

## Production runtime — SHIPPED 2026-06-01 (commits 4578509 + feef608)

The Node tooling here is the **ops layer** — bootstrap, drift detection, future push/compat/sync. The **runtime layer** ships as a MODE of the main backend binary (`REDPASH_KAFKA_LOAD` env), consuming the same `contracts/` files this directory generates.

**First successful end-to-end run 2026-06-01T01:33Z**: connect 1.15s → consume 1 message → decode 2ms via codec_avro → load 18ms into `FIL_E9F50710...` (project `PRJ_D32D474B...`). Real Confluent Cloud, real JLR Account schema, real row in `project_files`. The first ETL connector is OPERATIONAL.

**Canonical Rust crates (as-built)**:

| Crate | Role | Why it was chosen |
|-------|------|-------------------|
| **`rskafka`** | Kafka consumer (pure Rust, no native deps) | **Em's call**: `rdkafka` needs cmake + librdkafka (C lib); rskafka is pure-Rust + no system deps + idiomatic async. Confluent's official docs recommend `rdkafka` because they ship librdkafka, but the engineering optimum for a Rust-native stack is `rskafka`. Third instance today of [[decades-of-innovation]] vendor-docs-as-unreliable-narrator pattern. |
| `apache-avro` 0.21 | Avro schema parser + binary decoder | Reads our `contracts/*.json` envelopes + decodes message buffers. Consumed by `codec_avro.rs` in the codec registry (CAS_75A0D1FD s2). |
| `rustls` 0.23 + `webpki-roots` 1 | TLS for SASL_SSL | Pure-Rust TLS via ring provider. **No native dep on OpenSSL.** Added during the security-review pass (commit feef608) when the first cut had SASL PLAIN over PLAINTEXT — fail-closed: TLS-setup failure errors the run rather than leaking creds. |
| `tokio` | Async runtime | Standard. |
| `serde_json` | Parse contract envelopes | Standard. |

**Critical security note**: SASL_SSL + PLAIN over TLS is **mandatory**, not optional. Confluent Cloud requires it. The first cut (commit before feef608) used SASL PLAIN with no TLS — a security review caught it; rustls TLS config now fail-closes on setup failure rather than falling back to plaintext.

**What we DON'T need at runtime** (because [[data-contract-first]]):

- `schema-registry-converter` — community crate that does `{magic_byte, schema_id}` → registry lookup at runtime. Skipped because our schemas are local files.

**Auth shape**: SASL_SSL + PLAIN mechanism. Same `.env` values as the Node spike + bootstrap-contracts. rskafka config: `.tls_config(rustls_config).sasl_config(SaslConfig::Plain { username, password }).bootstrap_brokers(...)`.

**Loader architecture** (commit 4578509):

- Runs as `REDPASH_KAFKA_LOAD=1` mode of the main binary (not `src/bin` — a binary can't reach `codec_avro` + `db` modules; mode-of-main reuses them).
- `consume_raw` → rskafka single-partition fetch.
- `codec_avro::decode` → JSON records.
- `records_to_csv` → tabular CSV; nested arrays/objects flatten to compact JSON strings per cell; RFC-4180 quoted.
- `ingest_csv` → existing upload/import pipeline (`data::parse::from_csv_bytes` + `db::insert_file`). **Decoded Kafka data flows through the SAME pipeline as CSV uploads** — `disposability-design-principle` reuse: no new ingest infra, just plumbing.
- Result: a `project_files` row with the decoded Account record(s), queryable via the existing redtable + workspace surfaces.

**Future restructuring (planned, not now)**:

```
connectors/kafka-confluent-rc/
├── README.md
├── ops/                 # Node: bootstrap, diff, push, compat, sync (today)
│   ├── package.json
│   └── spike.mjs
├── contracts/           # shared — generated by ops, consumed by runtime
└── results/             # ops + loader outputs (gitignored)
```

The runtime currently lives in `backend/crates/api/src/kafka_loader.rs` (mode of main binary). If a future restructure splits it into its own crate, the `contracts/` dir stays the contract surface between ops + runtime regardless.

## Related

- Parent case: CAS_ACAA76AA683E4E0099D29A1B8BB33D8C
- Grandparent: CAS_75A0D1FD65694E03BF13E6679403AB34 (v1.1 codec registry, consumes spike output)
- Keystone: [[data-format-open-ended]] / [[etl-elt-roadmap]] / [[data-decides]] / [[data-contract-first]]
- Reference: Confluent Schema Registry API — https://docs.confluent.io/platform/current/schema-registry/develop/api.html
- Reference: Confluent Avro deserializer wire format — https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/serdes-avro.html
- Reference: Confluent Rust client examples — https://docs.confluent.io/platform/current/clients/examples/rust.html (thin — Schema Registry integration NOT covered, doc points at GitHub repo `clients/cloud/rust/src/consumer.rs` for full code)
- Crate refs: [rdkafka](https://crates.io/crates/rdkafka) · [apache-avro](https://crates.io/crates/apache-avro) · [tokio](https://crates.io/crates/tokio)
