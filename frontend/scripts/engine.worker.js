/* Purpose: dedicated module worker hosting the wasm data engine off the main thread.
 * Doc: docs/internal/code/frontend/scripts/engine.worker.md */
// Runs the SAME `data`-crate wasm engine as `wasm-engine.js`'s `getEngine()`, but
// on its own thread — so a heavy op (parse/sort over a full buffer) never freezes
// the tab (edge-bench "fix #1"; the old 50k client cap was that main-thread freeze).
//
// Protocol: main thread posts { id, op, payload }; the worker replies
// { id, ok:true, result } or { id, ok:false, error }. `wasm-engine.js` owns the
// id correlation + the proxy API (warmWorkerEngine / workerSort / workerCall).
//
// The synchronous Polars calls run HERE (fine — it's a worker), and so does the
// JSON marshaling, so only the minimal result crosses back (e.g. the sort
// permutation, not the re-serialized rows).
import { getEngine } from "/scripts/wasm-engine.js";

const engP = getEngine(); // start compiling the wasm immediately on spawn

const ops = {
  async __warm() { await engP; return null; },

  // Stable multi-key sort, least-significant key first (the wrapper sorts one
  // column at a time; a stable sort composes them). Returns only each row's
  // `__p` marker — the whole stringify/sort/parse loop stays on this thread.
  async sort({ rows, specs }) {
    const eng = await engP;
    let cur = rows;
    for (let k = specs.length - 1; k >= 0; k--) {
      cur = JSON.parse(eng.apply_sort(JSON.stringify(cur), specs[k].col, specs[k].desc));
    }
    return cur.map((r) => r.__p);
  },

  // Generic passthrough for string-in/string-out engine methods.
  async call({ method, args }) {
    const eng = await engP;
    const fn = eng[method];
    if (typeof fn !== "function") throw new Error("unknown engine method: " + method);
    return fn(...args);
  },
};

self.onmessage = async (e) => {
  const { id, op, payload } = e.data;
  try {
    const fn = ops[op];
    if (!fn) throw new Error("unknown op: " + op);
    const result = await fn(payload || {});
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
