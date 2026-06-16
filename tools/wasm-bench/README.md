# wasm-bench — is client-side wasm fast enough to be the default?

The data engine (`backend/crates/data`) compiles twice — native (server) and
wasm32 (browser). This harness times the **same ops on both surfaces** across a
row-count sweep so we can answer, with numbers, two questions:

1. **The wasm tax** — for each op, how much does the wasm path cost vs native?
   (read the **ratio**, not the machine-relative ms).
2. **The cliff** — at what row count does each op cross ~100 ms / ~1 s, i.e.
   where should the client path hand off to the server (the over-cap fallback)?

## Ops & surfaces

`parse` · `page` (window) · `filter` (single-column) · `search` (free-text, all
columns) · `sort` · `score` (cleanness report) — each the median of K warmed
runs. Windowed ops serialize `Page::to_json().to_string()` on **both** surfaces
(marshal parity, so the ratio doesn't flatter native).

- **wasm**: the `-Oz` shipped engine loaded in a node host (`bench-wasm.mjs`,
  reusing the `wasm-smoke` loader). One fresh node process per size — wasm linear
  memory only grows within a process, so a shared process would corrupt the
  per-size peak.
- **native**: `cargo`-built `bench_native` bin, `--release`.

## Run

```sh
sh tools/build-wasm.sh                                   # the -Oz engine
cargo build -p api --release --bin bench_native          # the native side
sh tools/wasm-bench/run.sh                                # full sweep 1k..500k
# subset / shape:
SIZES="1000 10000 100000" SHAPE=narrow sh tools/wasm-bench/run.sh
```

Output: `results/results-<shape>.md` (per-op tables + ratio + memory + cliffs) and
`results/results-<shape>.json`. Corpus CSVs + raw JSONL are gitignored.

## Read it honestly (the caveats baked into results.md)

- **node ≠ browser.** Node has no main-thread freeze / render contention. Node is
  the reproducible throughput proxy; the *cap* decision needs a browser pass
  (Playwright follow-on). If they disagree, the browser governs.
- **`-Oz` vs `-O3`.** The shipped engine is size-optimized (`-Oz`, slower). These
  are the honest *shipped-UX* numbers; an `-O3` rebuild narrows the ratio — a
  named follow-on, not the headline.
- **WSL2.** Absolutes are VM-relative; the wasm/native **ratio** cancels most of
  it. Re-run on target hardware before moving `ROW_CAP`.
- **single-thread tax.** wasm runs sort/filter/score on one thread; native uses
  rayon. The ratio *widens* with size on those ops — structural, not a bug.

## Files

- `generate.py` — parametric corpus (`--rows N --shape {wide|narrow}`), ported
  from the prerelease, deterministic per seed.
- `bench-wasm.mjs` — one size, the wasm surface, JSON line out.
- `../../backend/crates/api/src/bin/bench_native.rs` — one size, native, JSON out.
- `run.sh` — the sweep orchestrator (fresh child per size).
- `aggregate.mjs` — JSONL → `results/results-<shape>.{json,md}`.
