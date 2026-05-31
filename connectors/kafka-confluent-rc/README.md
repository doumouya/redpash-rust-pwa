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

### 3. Run the spike

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

## Related

- Parent case: CAS_ACAA76AA683E4E0099D29A1B8BB33D8C
- Grandparent: CAS_75A0D1FD65694E03BF13E6679403AB34 (v1.1 codec registry, consumes spike output)
- Keystone: [[data-format-open-ended]] / [[etl-elt-roadmap]] / [[data-decides]]
- Reference: Confluent Schema Registry API — https://docs.confluent.io/platform/current/schema-registry/develop/api.html
- Reference: Confluent Avro deserializer wire format — https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/serdes-avro.html
