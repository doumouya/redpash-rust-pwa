/* window-source — the pluggable WINDOW behind the grid.

   One interface, two sources, the SAME QuerySpec:
     { kind, ready, window(spec, offset, limit) → page, score() → report|null, destroy() }
   where page = { columns, rows, total } and spec = { filter?, search?, sort? } | null.

   · serverSource(rid) — POST /page. Stateless: re-reads the .bin + runs the
     pipeline on every call. The source of truth, and the fallback for frames
     past the client memory budget.
   · clientSource(rid) — a resident wasm Workbook in a Worker. Parse ONCE on
     open, then warm windows + the score cliff off-main. Measured on the real
     389k×9 file: page 1.6 ms · filter 8 ms · sort 36 ms · search 380 ms — 3–10×
     the server, and the page never freezes (load 274 ms one-time, score 1.6 s
     off-thread). The data stays on the device.

   The grid composes a source and calls window()/score() — it never knows which.
   pickSource() routes by a rows×cols budget: client where it fits, server for
   the genuinely huge tail (where stateless is fine — nobody hand-scrubs millions
   of rows, and wasm32 caps linear memory at 4 GB). */

import { api } from "../boot/api.js";

export function serverSource(rid) {
  return {
    kind: "server",
    ready: Promise.resolve(),
    window: (spec, offset, limit) => api.post(`/files/${rid}/page`, { offset, limit, ...(spec || {}) }),
    sql: (query) => api.post(`/files/${rid}/sql`, { sql: query }), // table `t` = this file
    score: async () => null, // the server's score arrives via the file summary, not per-window
    destroy() {},
  };
}

/* spawnEngine — one wasm engine in its own Worker, plus the request/response
   plumbing ({id,op,payload} → {id,ok,result|error}). Backs BOTH roles of the
   client source: the long-lived RESIDENT engine (holds the parsed frame for the
   file's lifetime) and the throwaway PEAK-OP engine (one heavy op, then killed).
   Same engine-worker.js script either way; the lifetime is the orchestration's
   job, not the worker's. */
function spawnEngine() {
  const worker = new Worker(new URL("/framework/engine/engine-worker.js", location.origin), { type: "module" });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    // a worker crash (e.g. OOM on the peak op) rejects every in-flight call so
    // the caller can fall back to the server source — the tab never dies.
    for (const p of pending.values()) p.reject(new Error(e.message || "engine worker crashed"));
    pending.clear();
  };
  return {
    call(op, payload, transfer) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, payload }, transfer || []);
      });
    },
    // terminate reclaims the worker's linear memory wholesale (wasm memory never
    // shrinks in place) and rejects anything still in flight.
    terminate() {
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("engine terminated"));
      pending.clear();
    },
  };
}

export function clientSource(rid, { tld } = {}) {
  // resolve the wasm URL on the MAIN thread (honours the import map → hashed in
  // the release build); workers can't see the map, so hand them the final URL.
  const dataUrl = (() => {
    try { return import.meta.resolve("/wasm/data.js"); }
    catch { return new URL("/wasm/data.js", location.origin).href; }
  })();
  // the export the View tab serves — the parse source for both engines. NOT
  // service-worker-cached (/api rides HTTP freshness), so the peak-op re-parse
  // re-fetches; fine because pickSource keeps the client path under the cell
  // budget (~600 MB), where fetch + re-parse is sub-second.
  const exportUrl = `/api/files/${rid}/export?format=csv`;

  async function loadFrame(engine) {
    await engine.call("init", { dataUrl });
    const res = await fetch(exportUrl);
    if (!res.ok) throw new Error(`export ${res.status}`);
    const buf = await res.arrayBuffer();
    return engine.call("load", { bytes: buf, tld }, [buf]); // transfer = zero-copy
  }

  // RESIDENT engine — parse ONCE on open, then answer warm windows + sql. It
  // never runs the peak op, so its linear memory stays at ~resident size and the
  // capacity ceiling is the resident one (~4M wide rows), not the peak op's.
  const resident = spawnEngine();
  const ready = loadFrame(resident);

  // PEAK-OP engine — at most one alive. A heavy op (score, big aggregate)
  // transiently allocates ~3× the frame and that high-water sticks for the
  // engine's life; running it in a throwaway engine and terminating means the OS
  // reclaims that footprint, decoupling the working peak from the resident floor.
  let peakEngine = null;
  async function runPeakOp(op, payload) {
    if (peakEngine) peakEngine.terminate(); // a newer heavy op supersedes the old
    const engine = (peakEngine = spawnEngine());
    try {
      await loadFrame(engine); // re-parse: frames aren't transferable across linear memories
      return await engine.call(op, payload || {});
    } finally {
      engine.terminate(); // reclaim the peak-op footprint
      if (peakEngine === engine) peakEngine = null;
    }
  }

  return {
    kind: "client",
    ready,
    async window(spec, offset, limit) {
      await ready;
      return JSON.parse(await resident.call("view", { spec: spec ? JSON.stringify(spec) : null, offset, limit }));
    },
    // read-only SQL over the resident frame as table `t` (single-table; multi-file
    // joins route to the server source). Same { columns, rows, total } shape as window.
    async sql(query) {
      await ready;
      return JSON.parse(await resident.call("sql", { query }));
    },
    // the peak op runs in a killable engine so its high-water never sticks to the
    // resident frame. (Not yet UI-wired — the cleaner is score's first consumer.)
    async score() {
      await ready; // resident parse first: confirms the frame is valid + within budget
      return JSON.parse(await runPeakOp("score", {}));
    },
    destroy() {
      resident.terminate();
      if (peakEngine) peakEngine.terminate();
    },
  };
}

/* pickSource — the rows×cols budget. `cells` = rows × cols; the threshold is a
   first cut (≈389k×9 = 3.5M cells / 245 MB sits well under). Tune against the
   memory sweep, not row count alone — 9 narrow cols and 50 wide ones differ. */
export function pickSource(rid, { rows = 0, cols = 0, tld } = {}) {
  const CELL_BUDGET = 12_000_000;
  return rows && cols && rows * cols > CELL_BUDGET
    ? serverSource(rid)
    : clientSource(rid, { tld });
}
