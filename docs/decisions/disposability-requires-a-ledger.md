# Disposability requires a ledger

RedPash treats code as disposable — *"what we build now is already obsolete; we should be
able to delete anything at minimal cost"* — and has rebuilt the whole tree more than once.
That instinct is a strength, but it has a failure mode the `lean` graduation exposed: a
rebuild that re-lands **from memory** silently loses whatever no one remembered.

## The incident that locked this

The `lean` graduation (`fbd9f5e`, 2026-06-16) wiped the prerelease-derived tree and
re-landed a clean rebuild from memory. A 2026-06-20 parity review
([`../internal/parity-review-2026-06-20.md`](../internal/parity-review-2026-06-20.md))
found a real, silent gap: the connector / codec / validation lineage (`codec_registry`,
`codec_avro`, the Kafka/Postgres loaders, the `/api/connectors` surface, the validators,
`redact`, the `db_query` capture writer) was dropped with no record. It survived only
because someone happened to ask. *"If I don't remember about something, it's literally
lost."*

## The rule (locked — changing it is an Em-level decision)

1. **No capability lives only in memory.** Every capability is recorded in the capability
   ledger ([`../internal/capability-ledger.md`](../internal/capability-ledger.md)) as a
   stable key. Adding a capability without a ledger entry is incomplete work.
2. **A rebuild reconciles against the ledger, not memory.** Before any graduation/slim/
   rewrite drops a tree, diff the ledger against the new tree — every dropped capability is
   an explicit, recorded decision (`[gap]` with a reason), never a silent loss.
3. **The ledger is machine-enforced, not asserted.** `tools/capability-audit/` extracts the
   live manifest and fails CI on a DROPPED capability (live in the ledger, gone from the
   tree) or an UNDOCUMENTED one (in the tree, not in the ledger) — ratcheted via
   `ci-audit` (`baseline.json: "capability"`). The floor is the guarantee; the doc is the
   index.

This is the *audit-everything / encode-the-fix-once* reflex applied to institutional
memory — the same loop as the privacy register and the planned governance layer
(assess → standing register → reproducible audit). Disposability stays cheap **because**
the ledger makes deletion a reconciliation, not a gamble.
