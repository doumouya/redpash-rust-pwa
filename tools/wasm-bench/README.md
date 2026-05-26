# `tools/wasm-bench/` — WASM Phase C bench harness

Measures parse-on-wasm vs server round-trip on a representative CSV.
Deliverable contract: `docs/internal/architecture/roadmap-webassembly.md`
§5 Phase C ("an honest perf + size delta").

## What's here

| File | Purpose |
|---|---|
| `generate.py` | Generates 3 deterministic clean CSV shapes into `corpus/` |
| `generate-tricky.py` | Generates a chaos-at-scale CSV (70% clean + 30% mixed trap shapes) into `corpus/` |
| `corpus/` | Output dir (gitignored — regenerable) |
| `fixtures/` | Hand-curated permanent regression fixtures (tracked) |
| `README.md` | This doc |

The bench **page** lives at `frontend/wasm-bench.html` (served by Axum
at `/wasm-bench.html`). It's outside `partials/` because it's a
standalone measurement tool, not part of the SPA router.

## Run

    # 1. boot the backend (serves /api/demo/parse + /wasm/*)
    cargo run -p api

    # 2. (one-shot, or whenever the schema changes) regenerate the corpus
    python3 tools/wasm-bench/generate.py
    python3 tools/wasm-bench/generate-tricky.py        # chaos-at-scale, 100k rows
    # python3 tools/wasm-bench/generate-tricky.py 1000000   # 1M-row variant

    # 3. (if wasm.rs or the data crate changed) rebuild the bundle
    sh tools/build-wasm.sh

    # 4. open the bench page, drop one of the corpus files
    open http://localhost:8080/wasm-bench.html

The page reports parse-time per lane (wasm vs server) over N iterations
(default 3). First wasm iter includes cold engine load; subsequent
iters reuse the cached engine.

## Corpus

| File | Rows | Cols | Size | Role |
|---|---|---|---|---|
| `small.csv` | 178 | 10 | ~16 KB | parser fixed-cost floor |
| `medium.csv` | 10,000 | 20 | ~2 MB | the §5 Phase C target |
| `large.csv` | 431,000 | 5 | ~19 MB | size-budget edge (temps shape) |
| `tricky-100k.csv` | 100,000 | 6 | ~8 MB | lenient-mode chaos at scale — 70% clean + 30% trap mix (commas, multi-line, wrap, missing/extra cols, UTF-8, quote soup) |

Schema is deterministic — same `SEED` yields the same bytes — so
repeated bench runs are comparable across sessions. The medium file's
20-column mix exercises every dtype branch (int / float / string /
date / datetime / bool / enum) so `dtype::summarize` and
`stats::cleanness_report` have real inference work to do.

## Known cliffs

- **Server demo endpoint caps at 4 MiB** (`DEMO_MAX_BYTES` in
  `routes/demo.rs`). `large.csv` will get a 413 from the server lane —
  that's a real datapoint, not a bug. The wasm lane has no such cap
  but is subject to the page's `DEMO_CAP_BYTES = 5 MB` (in
  `wasm-engine.js`); bypassing that for bench purposes means using
  the bench page directly which calls `engine.parse_csv` without the
  gate.
- **Encoding** is sniffed via `chardetng` on the wasm side too. The
  bench corpus is UTF-8 so encoding detection is a fixed cost; testing
  encoding-sniff perf on a non-UTF-8 file requires a separate corpus
  (out of scope for §5 Phase C).

## Fixtures (hand-curated regression tests)

Unlike `corpus/` (regenerable, gitignored, perf-focused),
`fixtures/` holds small hand-written files that pin specific edge
cases. They're tracked in git so they survive `python3 generate.py`
and any future corpus changes; they exist to catch behavior
regressions, not to measure throughput.

| File | Rows × Cols | Size | What it pins |
|---|---|---|---|
| `ultimate-tricky.csv` | 15 × 5 | ~0.7 KB | Multi-shape torture: commas-in-quoted-fields, doubled-quote (`""`) escape, multi-line cells, missing/extra columns, partial-wrap (rows 6+15), unescaped/mismatched quotes, backslash-escape (`\"`), UTF-8 mojibake (`JosÃ©`), leading/trailing whitespace. Rescue should NOT fire (whole-file wrap signature fails). |

These fixtures double as **lane-parity probes** — both wasm and
server should produce identical metrics on each (modulo the rescue
delta documented in `docs/internal/specs/wasm-phase-c-spike.md`).
Adding a new fixture: drop the file in `fixtures/`, add a row to
the table above noting what it pins + the expected behavior. The
bench page picks it up automatically via drag-drop.

## Reusability

Per [[feedback-process-oriented]] (Gus 2026-05-25): the bench harness
is its own deliverable, separate from the snapshot results. Future
Phase D/E spikes (browser-side step engine, group_by, joins) reuse
the same generator + page shell; add per-operation lanes to the
table as new wasm wrappers land.
