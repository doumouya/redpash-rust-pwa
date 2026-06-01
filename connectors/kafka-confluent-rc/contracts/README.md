# contracts

Canonical schema artifacts for the `kafka-confluent-rc` connector. Each file is a producer-published Avro schema (or future protobuf / json-schema), checked into the connector dir so the codec can resolve it WITHOUT a runtime Schema Registry fetch.

## Why files, not just registry-fetch

Em 2026-06-01: *"maybe it would have been easier to decode if we asked for this file to consumer"* — exactly right for the single-topic single-connector case. The Schema Registry pattern earns its complexity at scale (multi-tenant central registry, schema-evolution governance, producer/consumer decoupling); for a connector we control end-to-end, the contract file beats it on every axis (zero cold-resolve, no auth, no retry, no failure-mode budget).

See [[feedback-data-contract-first]] memory + CAS_75A0D1FD codec registry design call #5 (multi-registry support) for the v1.1 design implication: `codec_meta.inline_schema` becomes first-class alongside `codec_meta.schema_id + registry`.

## Format — two parallel forms per (subject, version)

`bootstrap-contracts` writes BOTH files for each schema, matching the Confluent VS Code extension's convention (Em 2026-06-01):

- **`<subject>-v<n>.json`** — the full Confluent Schema Registry envelope (`{subject, version, id, metadata, schema}` where `schema` is the Avro schema as a JSON-encoded string). Round-trippable with the registry; this is what `GET /subjects/X/versions/N` returns.
- **`<subject>-v<n>.avsc`** — the **bare Avro schema**, pretty-printed JSON. What `avro-tools`, the `avsc` library, code generators, and the Confluent VS Code extension consume natively. Identical content to the envelope's `schema` field, just unwrapped + pretty.

The two forms are kept in parallel so the connector can be consumed by EITHER toolchain without re-extraction.

## Files (current)

| Subject | Versions | Schema (top-level shape) |
|---------|----------|--------------------------|
| `topic_account_jlr-value` | v1 (id=100002), v2 (id=100003) | `Account` record: 21 top-level scalars (PII) + 4 nested-record arrays (telephone / email / accountRole / accountAddress containing PostalAddress) |

## When to use file-source vs registry-fetch

| Use file (this dir) | Use registry-fetch |
|---------------------|---------------------|
| Single connector, single topic | Multi-tenant central registry |
| Schema rarely changes | Frequent schema evolution |
| Want zero startup-latency | Schemas owned by upstream team |
| Don't want auth/network deps | Need cross-team governance |
| Air-gapped or offline deploys | Streaming high-throughput multi-schema |

Both paths land at the same codec — only the schema-source plumbing differs.
