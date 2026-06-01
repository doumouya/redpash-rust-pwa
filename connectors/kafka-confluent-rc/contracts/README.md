# contracts

Canonical schema artifacts for the `kafka-confluent-rc` connector. Each file is a producer-published Avro schema (or future protobuf / json-schema), checked into the connector dir so the codec can resolve it WITHOUT a runtime Schema Registry fetch.

## Why files, not just registry-fetch

Em 2026-06-01: *"maybe it would have been easier to decode if we asked for this file to consumer"* — exactly right for the single-topic single-connector case. The Schema Registry pattern earns its complexity at scale (multi-tenant central registry, schema-evolution governance, producer/consumer decoupling); for a connector we control end-to-end, the contract file beats it on every axis (zero cold-resolve, no auth, no retry, no failure-mode budget).

See [[feedback-data-contract-first]] memory + CAS_75A0D1FD codec registry design call #5 (multi-registry support) for the v1.1 design implication: `codec_meta.inline_schema` becomes first-class alongside `codec_meta.schema_id + registry`.

## Files

| File | Topic / subject | Producer | What it carries |
|------|----------------|----------|-----------------|
| `topic_account_jlr-value-v2.json` | `topic_account_jlr` value (subject: `topic_account_jlr-value`, version 2) | JLR data-stream | JLR Account record: 21 top-level scalars (PII) + 4 nested-record arrays (telephone / email / accountRole / accountAddress). schema id=100003. |

## Format

Files store the **Confluent Schema Registry export envelope** — `{subject, version, id, guid, schemaType, metadata, schema}` — so the file is round-trippable with the registry. The actual Avro schema is the `schema` field (a JSON-encoded string of the Avro JSON schema, per Confluent's convention).

To extract just the Avro schema for tooling that wants it bare:

```sh
jq -r '.schema | fromjson' contracts/topic_account_jlr-value-v2.json
```

## When to use file-source vs registry-fetch

| Use file (this dir) | Use registry-fetch |
|---------------------|---------------------|
| Single connector, single topic | Multi-tenant central registry |
| Schema rarely changes | Frequent schema evolution |
| Want zero startup-latency | Schemas owned by upstream team |
| Don't want auth/network deps | Need cross-team governance |
| Air-gapped or offline deploys | Streaming high-throughput multi-schema |

Both paths land at the same codec — only the schema-source plumbing differs.
