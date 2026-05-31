---
title: tools/kafka-spike/
source: ./
owner: Torv
section: Internal · Code · Tools
last modified date: 2026-06-01
---

# kafka-spike

## Purpose

CAS_ACAA76AA meta-codec resolver spike. Produces real-data on the 6 reversal-expensive design calls for the v1.1 codec registry (CAS_75A0D1FD), against Em's actual Confluent Schema Registry + Kafka cluster — not mocks.

Per [[data-decides]] + [[try-fail-iterate]] discipline: spike-first when the design is reversal-expensive, ship the design with data not opinion. Output feeds CAS_75A0D1FD's wire-shape decision.

## What the spike measures (6 design calls)

1. **Cache strategy** — per-process LRU vs unbounded (schemas immutable per ID) vs TTL.
2. **Cold-resolve failure mode** — registry unreachable on first sight of a schema_id. Fail the read? Serve bytes + `_codec_meta_unresolved: true`? Queue retry?
3. **Schema mutation invariant** — Confluent guarantees schema_id → schema is immutable. Does our codec contract require it or accommodate versioned `(schema_id, version)`?
4. **Retry policy** — exponential backoff? Circuit breaker per endpoint?
5. **Multi-registry support** — single endpoint per codec, or per-field `codec_meta.schema_url` override?
6. **FE-side resolution** — FE editor-registry resolves schemas, or editing of meta-codec fields is backend-mediated?

## How to run

### 1. Drop credentials in `.env`

`tools/kafka-spike/.env` is gitignored. Copy `.env.example` → `.env` and fill in the values. The Confluent VS Code extension exposes the Schema Registry URL + API key in your cluster's "API keys" section (Cluster overview → Cluster settings → API keys / Schema Registry settings → API keys).

```sh
cp tools/kafka-spike/.env.example tools/kafka-spike/.env
$EDITOR tools/kafka-spike/.env       # populate values
```

### 2. Install deps

```sh
cd tools/kafka-spike && npm install
```

Single dep: `@kafkajs/confluent-schema-registry` (wraps avsc + Confluent magic-byte wire format). The lib is spike-scoped — production codec usage is a separate v1.1 decision based on spike data.

### 3. Run the spike

```sh
node tools/kafka-spike/spike.mjs                # all phases
node tools/kafka-spike/spike.mjs phase1         # only subject discovery
node tools/kafka-spike/spike.mjs phase2         # only cold-resolve latency
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
