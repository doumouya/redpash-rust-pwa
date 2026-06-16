# Handling 4GB-on-device, properly — the memory ceiling + the plan

**Why this matters:** a 4GB CSV is *millions of rows*, in a browser tab, on the
user's machine — and **nobody on the market ships it.** Sheets taps out ~10M
cells, Excel needs the desktop, every web data tool round-trips to a server long
before that. Owning the on-device ceiling cleanly is a capability the market
structurally can't match (and it's the governance moat: the data never leaves).
So: nail *up to* the wall before chasing past it.

## The measurement (parse-to-resident, fresh process per size)

Tool: `ceiling-finder.mjs` (parse one corpus → report wasm linear-memory
high-water; catch OOM). `-Oz` engine, node host (browser is the real target —
see caveat). None OOM'd through these sizes:

| corpus | resident wasm mem | per 1k rows |
|---|--:|--:|
| wide 750k (20-col) | 619 MB | 0.83 MB |
| wide 1.0M | 1037 MB | 1.04 MB |
| wide 1.2M | 1117 MB | 0.93 MB |
| narrow 2.0M (5-col) | 490 MB | 0.24 MB |
| narrow 4.0M | 975 MB | 0.24 MB |

## The reframe — parse is cheap; the *peak op* is the wall

The earlier headline "500k wide = 1.67 GB" was the high-water **after running all
6 ops**, not the resident frame. **Parsed and resident the frame is ~3–4× smaller**
(~1 MB / 1k wide, ~0.24 MB / 1k narrow). So:

- **Capacity (hold):** ~**4M wide / ~16M narrow rows fit in 4 GB.** Multiples of
  the old 500k implication. 4 GB of CSV → millions of rows, comfortably resident.
- **The binding constraint isn't parse — it's the peak operation.** A heavy op
  (especially `score`: cleanness report + summarize + sentinels) transiently
  allocates ~3× the frame, and **wasm linear memory never shrinks back** — it
  plateaus at the peak op's footprint (~3.3 MB / 1k wide → ~1.2M wide with
  `score`). *Interactive heavy use* on a big frame is what approaches 4 GB, not
  holding the data.

So **"handle 4 GB properly" = isolate the peak op, not shrink the data.**

## The plan

1. **Measure the wall** — ✅ done (above). Resident ≈ 1 MB/1k wide, 0.24 narrow →
   ~4M wide / ~16M narrow. Peak-op (with `score`) ≈ 3.3 MB/1k wide → ~1.2M wide.
2. **Worker offload (the keystone)** — resident frame stays main-thread (cheap);
   heavy ops (`score`, big sort/aggregate) run in a **Web Worker** → no main-thread
   freeze **and** the worker is **killable to reclaim** the peak-op footprint,
   decoupling the working high-water from the resident ceiling. Unlocks the full
   ~4M-wide capacity for real use, not just parse.
3. **Memory-aware cap** — replace flat `ROW_CAP = 500k` with an estimate off the
   **resident** cost (~1 MB/1k wide, by column count), device-budgeted
   (`navigator.deviceMemory`). Admit right up to the wall.
4. **Graceful at the edge** — estimate the frame size at parse time, refuse/route
   *before* `memory.grow` fails, catch the OOM, never crash the tab.

## Open / caveats

- **Failure mode unmeasured (on purpose).** Stopped before forcing OOM — a 4 GB+
  allocation could take the WSL dev box down. The graceful-`RangeError`-vs-tab-crash
  test belongs in an **isolated browser tab** (safe), as a follow-on.
- **Node ≠ browser.** Node is the reproducible proxy; the device-RAM limit (lower
  than the wasm 4 GB address ceiling on low-RAM machines) is the real cap — confirm
  the wall + the failure mode in a real browser on a representative device.
- **`memory64` / wasm64** would lift the 4 GB address ceiling eventually — not
  stable across browsers yet.

*Artifacts: `ceiling-finder.mjs`, corpus under `corpus/` (gitignored).*
