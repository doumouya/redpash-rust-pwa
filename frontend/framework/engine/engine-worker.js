/* engine-worker — a wasm data engine, OFF the main thread.

   Holds ONE wasm Workbook and answers ops against it; the page never freezes
   (parse, every window `view`, the score cliff ≈1.6 s on a 389k frame all run
   here, not on the UI thread). window-source.js runs this script in two roles:
   a long-lived RESIDENT engine (parse-once → windows + sql) and a throwaway
   PEAK-OP engine it spawns + terminates per heavy op (score) to reclaim the
   transient high-water — see clientSource. The script is identical; only the
   lifetime differs, so this file stays role-agnostic.

   Module worker. The wasm URL is handed in at `init` rather than imported by a
   literal — workers don't see the page's import map, so a hard-coded
   "/wasm/data.js" would 404 against the hashed release name. The main thread
   resolves it (import.meta.resolve honours the map) and passes the final URL.

   Protocol: { id, op, payload } in → { id, ok, result } | { id, ok:false, error } out.
   `view`/`score` return the engine's JSON STRING verbatim — the main thread parses
   (keeps the heavy stringify→parse marshal symmetrical with the server path). */

let mod = null; // the wasm-bindgen module (one per worker)
let wb = null;  // the resident Workbook for the open file

const HANDLERS = {
  async init({ dataUrl }) {
    if (!mod) {
      mod = await import(dataUrl);
      await mod.default(); // streams + compiles the (service-worker-cached) wasm
    }
    return { ready: true };
  },
  async load({ bytes, tld }) {
    wb = mod.Workbook.from_csv(new Uint8Array(bytes), tld);
    return { rows: wb.rows(), cols: wb.cols() };
  },
  // QuerySpec window — (filter AND search) → sort → page, byte-identical to /page.
  async view({ spec, offset, limit }) {
    return wb.view(spec ?? undefined, offset, limit);
  },
  // read-only SQL over the resident frame (table `t`) — same engine + guard as /sql.
  async sql({ query }) {
    return wb.sql(query);
  },
  // the cleanness report over the resident frame (the slow one — that's the point).
  async score() {
    return wb.score();
  },
};

self.onmessage = async (e) => {
  const { id, op, payload } = e.data;
  try {
    const handler = HANDLERS[op];
    if (!handler) throw new Error(`unknown op: ${op}`);
    self.postMessage({ id, ok: true, result: await handler(payload || {}) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
