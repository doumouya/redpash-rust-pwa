# wasm perf verdict — is client-side the default?

*From the 1k→500k wasm-vs-native sweep (wide 20-col corpus), adversarially
verified. Numbers are dev-box/WSL2, node host — **read the shape + the ratio**,
not the absolute ms. See `results-wide.md` for the full tables.*

## The answer

**Yes — client-side wasm is a sound default for the interactive surface** (page,
filter, sort, and search-with-a-spinner) to ~250–500k rows on a desktop. The
on-device engine is genuinely competitive: **sort — the one fully fair op
(single-threaded on *both* surfaces) — wasm *wins* at every size** (49ms vs
100ms @500k). Page is windowed and flat (~1ms forever). The fast path is real.

**The binding constraint is MEMORY, not op latency.** A resident workbook is
**~3.3 MB per 1k wide rows and only ever grows within a tab** (wasm linear memory
is never released), so the session high-water hits the wasm32 ~2–4 GB ceiling
near **~500–650k wide rows on a 4 GB device — and far sooner on phones** — a hard
OOM *before any op runs*. 500k×20 = **1.67 GB**.

## The two cliffs (don't conflate them)

1. **HARD wall — wasm32 linear memory.** The real cap. Reached at allocation time,
   device-dependent. → gate on **estimated cells (rows×cols)** at parse time.
2. **SOFT wall — `score()`** (cleanness profiling: summarize + cleanness_report +
   find_sentinels). Crosses 1s at **~68k rows on BOTH surfaces (~1.0× ratio)** —
   an *op-design* problem, **not a wasm deficiency**. 8.5s @500k. → move it **off
   the interactive path** (Web Worker / incremental / sampled), not a row cap.

`parse` (2.0×) and `search` (2.7×) *look* like wasm taxes but are mostly a
**14-thread-native-vs-1-thread-wasm** artifact (native polars carries rayon; wasm
has none) — quote the **absolute** wasm latencies (parse ~1s, search ~1.6s @500k),
not the ratios.

## Cap recommendation (provisional)

- **Do not lock a hard `ROW_CAP` from this iteration.** Gate the server fallback
  on **estimated linear memory in cells**: `est ≈ rows × cols × ~165 KB/1k-cells`
  (calibrated from 500k×20 → 1.67 GB). Budget = `min(navigator.deviceMemory-safe
  ceiling, wasm32 ceiling)`. Lands ~**400–500k wide** on desktop, ~**100–150k** on
  a low-memory device.
- **Move `score()` off the main thread** regardless of size (worker/incremental) —
  cheaper and more correct than a row cap.
- Treat `parse`/`search` crossing 100ms at ~30–45k as a **show-spinner**
  threshold, not a fall-back.
- The exact cap is the crossover where the **data-never-leaves-device** guarantee
  stops outweighing the CPU/memory tax — a product call, not a pure measurement.

## Headline numbers

| signal | value | reading |
|---|---|---|
| **memory (binding)** | 1.67 GB @500k×20 (~3.3 MB/1k rows, monotonic) | OOM-walls a 4 GB tab ~500–650k, phones far sooner |
| **sort (fair op)** | wasm **wins** every size, 0.49× @500k | the on-device engine is real |
| **score (soft wall)** | 8.5s @500k, ~1.0× both surfaces | move off the interactive path everywhere |
| **page (windowed)** | ~1ms at every size | no row limit, never a cliff |
| **parse / search** | 2.0× / 2.7× @500k | **threading artifact** — quote absolutes (1s / 1.6s) |

## Confidence + the caveats that would move it

Moderate-high on the **shape**; **low on any locked numeric cap** from one
dev-box / node-host run. Before changing `ROW_CAP`:

- **Node has no main thread** — the freeze the cap exists to prevent was never
  observed. A real-browser long-task probe is the missing measurement.
- **Threading asymmetry** — a `POLARS_MAX_THREADS=1` native re-run isolates the
  true engine delta from core-count.
- **Low-selectivity predicate** — `filter "id contains 1"` matches 52.8%; that's
  worst-case full-scan, not selective-filter UX.
- **Wide-only / dev-box-only / `-Oz`** — narrow shape unmeasured (cap must be
  cells), no low-end device, size-optimized build (an `-O3` would narrow the gaps).

## Follow-ons (priority order)

1. **Browser main-thread freeze probe** (gating) — run score/search/parse on a
   real page main thread at 50k/100k/250k; record long-task ms + "page
   unresponsive". The one thing node can't measure.
2. **Web-worker offload spike** — postMessage/structured-clone cost per size;
   decides cap-vs-offload (if cheap, `score` stops gating and the cap is memory-only).
3. **Narrow (5-col) sweep** — `SHAPE=narrow sh run.sh`; refit the cap as cells.
4. **`POLARS_MAX_THREADS=1` native + selective predicate** — fair engine delta +
   realistic filter/search UX.
5. **Low-end device pass** (or a conservative `navigator.deviceMemory` gate).
6. **Decompose `score()`** into its 3 stages — may move the ceiling more than any
   build/worker change.
7. **`-O3` wasm variant** — quantify ship-size vs ship-speed.
8. **Cold-instantiation** — fetch+compile+initSync of the ~27 MB module for the
   true time-to-first-result picture.
