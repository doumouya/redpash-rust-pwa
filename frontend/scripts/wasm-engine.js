/* Purpose: see doc for details.
 * Doc: docs/internal/code/frontend/scripts/wasm-engine.md */
// Lazy loader for the `data` crate's wasm build — main-thread AND worker-backed.
//
// The wasm bundle (~3.46 MB gzipped over-the-wire) lazy-loads only
// when `getEngine()` is first awaited — page-cold visitors pay 0
// bytes. The browser stream-compiles the .wasm, so engine ops become
// callable before the download finishes.
//
// `getEngine()` returns the engine bound to the CURRENT thread (sync calls).
// `getWorkerEngine()` / `workerSort()` / `workerCall()` run the SAME engine in
// a dedicated Web Worker, so a heavy op (parse/sort over a full buffer) shows a
// spinner instead of freezing the tab — the edge-bench "fix #1" (the 50k client
// cap was that main-thread freeze, not a compute ceiling). The worker keeps the
// JSON marshaling (stringify + parse) on its own thread too, returning only the
// minimal payload (e.g. the sort permutation), not the re-serialized rows.
//
// Source of truth: backend/crates/data/src/wasm.rs (six wrappers
// — apply_filter, apply_sort, auto_clean, step_preview, parse_csv,
// parse_csv_compare). Regenerate after a data-crate change:
// `sh tools/build-wasm.sh`.
// Architecture: docs/internal/roadmap-webassembly.md §5 Phase B + C.

/** Demo upload cap. Files larger than this go through the sign-up CTA
 *  instead of loading the wasm engine. 5 MB — generous for "try it",
 *  cheap for in-browser parse, and the bound is honest: bigger files
 *  legitimately do need an account (multi-step cleaning, persisted
 *  projects, etc.) — it's not artificial scarcity. */
export const DEMO_CAP_BYTES = 5 * 1024 * 1024;

/** The six wrappers `wasm.rs` exports — one source of truth shared by the
 *  main-thread engine and the worker proxy so the two can't drift. */
const ENGINE_METHODS = [
  "apply_filter", "apply_sort", "auto_clean",
  "step_preview", "parse_csv", "parse_csv_compare",
];

let _enginePromise = null;

/** Lazy-load + initialize the wasm engine on the CURRENT thread. Subsequent
 *  calls return the cached engine instantly. First call triggers fetch +
 *  stream-compile of `/wasm/data_bg.wasm` via the wasm-bindgen `data.js` glue.
 *  Methods are SYNCHRONOUS — fine off the main thread (in `engine.worker.js`);
 *  on the main thread a heavy call blocks the tab, so prefer the worker API. */
export async function getEngine() {
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const mod = await import("/wasm/data.js");
    await mod.default(); // wasm-bindgen init — fetches + instantiates data_bg.wasm
    const eng = {};
    for (const m of ENGINE_METHODS) eng[m] = mod[m];
    return eng;
  })();
  return _enginePromise;
}

// ── worker-backed engine ───────────────────────────────────────────────
// One dedicated module worker hosts the engine; calls are correlated by an
// incrementing id. Spawned lazily on first use. A worker-level error rejects
// every in-flight call so callers can fall back (workspace sort falls back to
// the main-thread engine, then to buffer order — a sort gesture never blanks).
let _worker = null;
let _seq = 0;
const _pending = new Map();

function _ensureWorker() {
  if (_worker) return _worker;
  _worker = new Worker("/scripts/engine.worker.js", { type: "module" });
  _worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = _pending.get(id);
    if (!p) return;
    _pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  _worker.onerror = () => {
    for (const p of _pending.values()) p.reject(new Error("engine worker crashed"));
    _pending.clear();
    _worker = null; // let the next call respawn
  };
  return _worker;
}

function _post(op, payload) {
  const w = _ensureWorker();
  const id = ++_seq;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, op, payload });
  });
}

/** Warm the worker's engine off the main thread so the first real op is
 *  instant. Fire-and-forget; replaces the old main-thread `getEngine()`
 *  warm-up so the wasm compiles where the ops will actually run. */
export function warmWorkerEngine() {
  _ensureWorker();
  _post("__warm").catch(() => { /* warm-up best-effort */ });
}

/** Stable multi-key sort of `rows` (array of typed row objects, each carrying a
 *  `__p` buffer-position marker) by `specs` ([{ col, desc }], applied
 *  least-significant key first). Resolves to the `__p` permutation array only —
 *  all JSON + wasm runs in the worker, so the UI never freezes and only ~N ints
 *  cross back, not the re-serialized rows. */
export function workerSort(rows, specs) {
  return _post("sort", { rows, specs });
}

/** Generic worker-backed call to a string-in/string-out engine method
 *  (parse_csv, auto_clean, …). Resolves to the method's JSON string. */
export function workerCall(method, ...args) {
  return _post("call", { method, args });
}

/** Throws RangeError if the file exceeds the demo cap; returns the file
 *  unchanged otherwise. The caller decides what to render on rejection
 *  (sign-up CTA, error toast, etc.) — this function makes no UI
 *  assumption beyond what the error message says. */
export function gateBySize(file) {
  if (file.size > DEMO_CAP_BYTES) {
    const limitMb = (DEMO_CAP_BYTES / 1024 / 1024).toFixed(0);
    const sizeMb  = (file.size      / 1024 / 1024).toFixed(2);
    throw new RangeError(
      `file is ${sizeMb} MB; demo limit is ${limitMb} MB. ` +
      `Sign up for a free account to handle any size.`
    );
  }
  return file;
}
