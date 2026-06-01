# Edge-vs-Server benchmark — reconstructed 2026-06-01

Rebuilds the "edge-compute ingestion" POC lost in the Ubuntu 22.04→26.04
migration. The *engine* survived (the `data` crate + wasm wrappers + the
`data::structure` rescue heuristic), so this is reconstruction, not
rediscovery. Numbers are **real and current** (this machine, today's engine),
not the original 22.04 figures.

**Why this exists:** the north-star is **data governance** — raw user data
never leaves the device; compute comes to the data via WASM. The benchmark
proves it: above the demo cap the server *can't accept the file at all*,
while the edge processes it on-device in sub-second.

## Corpus

`python3 tools/wasm-bench/generate-edge-corpus.py <out>` (seeded = reproducible):

| File | Size | Shape |
|---|---|---|
| `ultimate_tricky.csv` | 709 B | 15 rows, every CSV trap (wrapped rows, embedded newlines, unescaped/backslash quotes, missing+extra cols, emoji, quote-soup) |
| `mega_tricky_100k.csv` | 7.16 MB | 100k rows, 70% clean / 30% chaos (11 trap kinds) |
| `type_truth_100k.csv` | 3.94 MB | 100k rows, **exactly 1000** planted type violations (250 each int/bool/float/date), all at rows ≥5000 |

## Results (2026-06-01, dev machine)

Edge = WASM `parse_csv` in-browser (warm), measured via dynamic-import of
`/scripts/wasm-engine.js` + `performance.now()`. Server = `POST
/api/demo/parse` (same engine, server-side), measured via `curl -w time_total`
(includes network).

| Test | File | Edge (on-device) | Server (`/api/demo/parse`) | Note |
|---|---|---|---|---|
| Malformed micro | `ultimate_tricky` 709 B | **0.6 ms** ✅ 5 cols / 15 rows | 27 ms ✅ (20 ms parse + net) | rescue identical; edge ~33–45× |
| **Chaotic 100k** | `mega_tricky` 7.16 MB | **648.9 ms** ✅ 100k rows | **HTTP 413 FAILED** — body-limit (>5 MB demo cap) exceeded | **edge is the ONLY path above the cap** |
| Type-stress 100k | `type_truth` 3.94 MB | **169 ms** ✅ 100k rows | 1.32 s ✅ (168 ms parse + ~1.15 s net) | edge ~8× wall-clock (network-bound) |

*(Test 1 "large-clean 101k" — pending a committed clean-100k fixture; the
dossier file covers it ad-hoc at ~similar volume.)*

## Findings

1. **No parser regression.** Zero failures across all torture files (Em's
   prediction). The rescue reasoned correctly on `ultimate_tricky`:
   `rescue_reason = "no_whole_file_wrap_signature"` — it detected that only
   *individual* rows (6, 15) are wrapped, not the whole file, and correctly
   declined a whole-file unwrap.
2. **Governance moat, measured.** `mega_tricky` (7.16 MB) is rejected by the
   server with **HTTP 413** (over the 5 MB cap) but parses on-device in
   ~650 ms. Above the cap the edge isn't merely faster — it's the only path,
   and the data never crosses the wire.
3. **"One engine, two surfaces" proven.** `type_truth` edge parse = **169 ms**
   vs server parse = **168 ms** — identical compute (same Rust). The edge's
   entire advantage is *no network + no size limit*, exactly the thesis.
4. **Type-detection DEPTH gap (shared-engine, not a runtime regression).**
   `type_mismatches` reads **1**, not the planted **1000** — because dtype
   sniffing samples the first 100 rows (`dtype::SAMPLE_SIZE`) and every trap
   sits at rows ≥5000. SAME on edge + server (parity holds). The cleanness
   score (99.9) only faintly reflects the 0.2% bad cells. Reproducing the old
   "1000 detected" Test 4 needs a **full-scan validation pass** (the
   TypeDefinition validator / `try_cast_count` surfaced as a count), not the
   sampled parse-preview. → candidate follow-up.

## SIMD experiment (`-C target-feature=+simd128`) — tested & reverted

Rebuilt the wasm with `RUSTFLAGS=… -C target-feature=+simd128` and re-ran the
edge parse:

| File | Scalar (shipped) | SIMD | Δ |
|---|---|---|---|
| `mega_tricky_100k` 7.16 MB | 648.9 ms | 623.8 ms | ~4% faster |
| `type_truth_100k` 3.94 MB | 169 ms | 159.9 ms | ~5% faster |

Binary ~1% smaller (12.17 vs 12.32 MB). **Reverted** — two reasons: (1) ~5% on
parse is marginal and doesn't touch the real bottleneck (the main-thread
marshaling freeze; SIMD speeds Polars compute, not `serde_json`); (2)
`+simd128` needs a modern browser (Chrome 91+/Safari 16.4+), so old WebViews on
low-end devices ([[gtm-africa-first]]) couldn't instantiate the engine at all —
losing reach on the exact target market for a 5% gain. Revisit only as a
feature-detected dual-build (simd for capable, scalar fallback) if compute ever
becomes the bottleneck. `build-wasm.sh` left scalar.

## Real bottleneck (from Em's 22.04 history + this run)

The 50k cap is an artifact of a **main-thread freeze**, not a compute ceiling.
Scrolling 100k was always smooth (virtualized grid never touches the whole
set). The freeze hit when an *operation* ran over the full buffer — opening a
side panel or `snake_case` = one synchronous WASM call doing `rows_to_df` +
`df_to_rows` over 100k rows **on the UI thread** → tab locks → close-browser.
50k was the empirical line where that block stayed tolerable.

Two fixes lift the cap (neither is SIMD):
1. **Web Worker** — run the engine off the main thread; a heavy op shows a
   spinner, never freezes the tab.
2. **Stateful handle** — operate on a held `DataFrame`, return only the visible
   page (~50 rows), so an op marshals 50 rows back, not 100k.

## How to re-run

1. `python3 tools/wasm-bench/generate-edge-corpus.py /tmp/edge-corpus`
2. Edge: serve the corpus (e.g. copy under the dev `frontend/` root), then in
   a browser console / Playwright on an authed page:
   `const m = await import('/scripts/wasm-engine.js'); const e = await m.getEngine();`
   `const b = new Uint8Array(await fetch(URL).then(r=>r.arrayBuffer()));`
   `e.parse_csv(b); /* warm */ t0=performance.now(); JSON.parse(e.parse_csv(b)); performance.now()-t0;`
3. Server: `curl -s -w "%{http_code} %{time_total}\n" -X POST $BASE/api/demo/parse --data-binary @FILE`
