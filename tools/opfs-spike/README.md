# OPFS / Web-Worker spike — result (2026-06-01)

Throwaway spike for the edge-stack plan (`elegant-munching-tiger.md`, OPFS layer).
Question: on a **desktop** browser, does OPFS + a Web Worker give RedPash a viable
on-device storage + compute path for the offline, data-sovereign enterprise ETL product
— and does the worker move kill the main-thread parse freeze the edge bench measured?

**Verdict: yes, decisively** — with one load-bearing caveat (`persist()` is not auto-granted
in a plain browser tab, so on-device storage MUST stay a re-derivable cache).

## How to run

Harness needs the served `/wasm/data.js` + `/scripts/wasm-engine.js`, so it runs from the
frontend root on a dev server:

```sh
cp tools/opfs-spike/opfs-spike.html tools/opfs-spike/opfs-spike-worker.js frontend/
# start the api (serves ../frontend), then open on localhost (secure context required for OPFS):
#   http://localhost:<port>/opfs-spike.html
# read window.__spikeResult ; then delete the two copies from frontend/
```

(Kept out of `frontend/` so it never ships; copy in only for a run.)

## Result (Playwright Chromium, dev machine, 100k-row / 6.93 MB synthetic CSV)

| Metric | Main thread | Web Worker |
|---|---|---|
| `parse_csv` time | 419.9 ms | 314.2 ms |
| **max rAF frame gap (= UI freeze)** | **400.2 ms** 🔴 | **16.8 ms** 🟢 |
| OPFS read | 11.8 ms (async `getFile`) | **5.2 ms** (sync access handle) |

- **OPFS round-trip ✓** — wrote 6,934,452 B to OPFS in **67.9 ms** (sync access handle in the
  worker), read back the exact byte count. OPFS is a working on-device byte store on desktop.
- **Worker kills the freeze ✓** — identical parse, but the main thread froze for **~400 ms**
  (rAF stalled) while the worker run kept the UI at ~60 fps (16.8 ms max gap). Fix #1 from the
  edge bench, confirmed.
- **`persist()` NOT granted ⚠️ — confirmed in a real INSTALLED Edge PWA.** In Playwright's plain
  tab `persist()` returned false (quota 10.25 GB, usage 11.75 MB). Then tested on Em's actual
  **installed, aged, engaged Edge PWA**: `persisted() = false`, `persist() = false` — Chromium/Edge
  denied persistent storage **even installed** (the "installed ⇒ persistent" hypothesis is
  empirically false on Chromium). → the **re-derivable-cache invariant is MANDATORY**: on-device
  storage is never the sole copy, always reconstructable from server/source, re-sync on eviction.
  Deterministic durable on-device storage is a **Firefox-only path** (Firefox `persist()` is a user
  prompt; Chromium's is an opaque heuristic) → the only browser route to guaranteed offline
  durability for air-gapped data-sovereignty is a Firefox-based runtime (PWAsForFirefox / firefox-rp).

## Findings that change the design

1. **Feature-detect `createSyncAccessHandle` IN A WORKER, not the main thread.** The main-thread
   probe `'createSyncAccessHandle' in FileSystemFileHandle.prototype` returned **false**, yet the
   worker used it successfully (the 67.9 ms write + 5.2 ms read prove it). It's spec'd Worker-only;
   the capability probe must run in worker scope or it will false-negative.
2. **`parse_csv`'s freeze is compute, not marshaling** (`marshalMs = 0` — it returns a small summary,
   not rows). The ~400 ms is the synchronous Polars parse. The rows-in/rows-out ops
   (`apply_sort`/`auto_clean`/`step_preview` — `rows_to_df`+`df_to_rows` over the full set) add
   marshaling on top → an even stronger case for the worker. Both are fixed by moving off-thread.
3. **The worker move is the highest-value, lowest-cost change** and needs **no crate fork** — stock
   OPFS + a module worker + the existing `getEngine()`/`parse_csv`. The `createSyncAccessHandle`
   *write* fork (the `opfs` crate gap) is only relevant later if on-device frame *writes* go
   load-bearing; reads + parse don't need it.

## Next (per plan)

- Make RedPash installable as a standalone desktop app (manifest + install path) and **re-measure
  `persist()` in the installed context** (expected: granted, deterministically on Firefox/PWAsForFirefox).
- Evaluate PWAsForFirefox end-to-end (real runtime download size, deterministic grant, LRU exemption).
- Productionize the worker move for the workspace engine ops (the actual freeze in the app).
