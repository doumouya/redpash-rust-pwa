---
title: Edge-compute tradeoffs — honest framing
section: Internal
order: 36
last modified date: 2026-05-27
owner: Woz
status: snapshot — written 2026-05-27 in response to an external (Gemini) marketing-style summary of RedPash's client-side parse architecture. Records what client-side parse + rescue actually buys, what it doesn't, and what the Phase C verdict actually unlocks. Not load-bearing; rerun + supersede when Phase D lands.
---

# Edge-compute tradeoffs — what client-side parse buys (and what it doesn't)

External analyses of RedPash's WASM Phase C architecture tend to read
it as a "skip the cloud, run on the edge" pattern and pitch it on
$0-compute / zero-trust / serverless-routing framing. That framing is
inflated. This doc is the honest version, grounded in the
[wasm-phase-c-spike](../specs/wasm-phase-c-spike.md) verdict and the
[roadmap-webassembly](roadmap-webassembly.md) phasing.

The TL;DR is in one line: **the moat is the rescue heuristic, not the
WASM placement.** WASM is implementation; rescue is product.

---

## What it actually buys — backed by spike data

- **Parse + rescue happens client-side at ~45 ms/MB clean-dense
  throughput.** Measured on 13–21 MB corpora per the Phase C spike
  ([specs/wasm-phase-c-spike.md](../specs/wasm-phase-c-spike.md)).
  No server roundtrip for the parse step.
- **The `unwrap_csv` rescue heuristic is baked into the parse
  algorithm.** This is the actual product differentiator: malformed
  rows, ragged columns, and french-header / wrapped-CSV legacy
  shapes get coerced silently instead of throwing
  `Line 18: expected 6 fields, saw 8` at the user. Same algorithm
  would deliver the same UX win in plain JS; WASM is how, not why.
- **Server bypasses parse-layer DoS.** A zip-bomb CSV or a parser-
  infinite-loop crashes the attacker's browser tab, not the Rust
  backend. The frontline parse is in the attacker's own runtime.
- **The 4 MiB demo payload cap is bypassed for the parse step.** The
  WASM engine works in local browser memory; the server's payload
  caps only gate the *cleaned* upload, not the raw input.
- **Bundle is ~3.45 MB gzipped, well under the §5 gate** (10 MB
  parks Phase C; 2 MB unlocks Phase D). Phase D is unlocked.

---

## What it doesn't buy — claims the marketing framing inflates

- **"Zero-trust ingestion / data never leaves the device" is wrong.**
  Only the *parse* step is local. Cleaned data still uploads, lands
  as a `project_files` row, gets joined and reported server-side.
  The GDPR/HIPAA implication that PII never touches the server is
  not what this architecture does.
- **"Lightweight Cloud Run for routing and storage" is the wrong
  stack.** RedPash runs Rust + Postgres; the backend does joins,
  reports, dashboards, audit ingest, events. Not a thin routing
  layer. Server compute is non-trivial and stays non-trivial.
- **"Bandwidth fees solved" is marginal.** Cleaned output is often
  similar size to raw input. The real bandwidth save comes from
  rescue *rejecting* malformed rows, or from the user uploading a
  sample. For typical clean-dense CSVs, the save is small.
- **"GIGO solved → backend only sees strictly-typed perfect
  datasets" is half-true.** Parse-layer chaos is filtered. Logical-
  quality issues (wrong types in fields that *parse* fine, dirty
  values that round-trip cleanly, dupe keys, FK-style orphans) still
  flow through to the backend and have to be handled in `data::`.
- **"Expensive scaling solved by default" only applies to parse
  load.** Storage scaling, join scaling, report-eval scaling all
  remain server-side concerns. The pattern doesn't displace
  capacity planning — it shrinks one axis (parse CPU) of it.

---

## What the spike actually leaves open — the interesting question

The Phase C verdict ("gate cleared") is not the end of the story. The
follow-up the marketing framing doesn't see:

- **Phase D is unlocked. What do we build on top of client-side
  parse as a primitive?** In-browser joins preview against the
  workspace tab's source files; client-side report-spec evaluation
  against rescued data without a server roundtrip; offline-first
  cleaner. That's where the leverage compounds — the cost saved on
  one parse is small; the latency saved on every interactive
  operation is the actual win.
- **Two sub-cliffs the addendum tracks** sit between us and "Phase D
  is also clear":
  - **Sparse-wide allocator pressure on the rescue path past 100k
    rows.** Verdict-refinement, not blocker.
  - **Legacy-encoded windows-1252 + malformed-wrap handling.**
    Affects the long tail of real-world CSVs, not the bench corpus.

These are the questions worth Em's time. "Did we save server cost"
is not.

---

## Where this doc fits

This is a snapshot, not a binding contract. The binding decisions live
in:

- [roadmap-webassembly](roadmap-webassembly.md) — *when* WASM ships
  and the runtime-neutral DTO rule.
- [specs/wasm-phase-c-spike](../specs/wasm-phase-c-spike.md) — *the
  measurements*: throughput plateau, bundle size, rescue correctness,
  sub-cliff addendum.

Rerun + supersede when Phase D lands and the in-browser-derived-views
question gets a real answer.

— Woz · 48
