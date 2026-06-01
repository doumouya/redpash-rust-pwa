// THROWAWAY OPFS spike worker — delete after measuring (OPFS/runtime spike,
// plan: elegant-munching-tiger.md). Module worker: imports the real wasm
// engine, stores/reads CSV bytes in OPFS via the fast sync-access-handle
// (Worker-only), and runs parse_csv OFF the main thread so the ~650ms/100k
// Polars parse never freezes the UI. Source of record: tools/opfs-spike/.
import { getEngine } from '/scripts/wasm-engine.js';

const DIR = 'opfs-spike';
const FILE = 'frame.csv';

async function handle(create) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(DIR, { create });
  const fh = await dir.getFileHandle(FILE, { create });
  return fh.createSyncAccessHandle();      // Worker-only fast path
}

self.onmessage = async (e) => {
  const { cmd, bytes } = e.data;
  try {
    if (cmd === 'write') {
      const t0 = performance.now();
      const h = await handle(true);
      h.truncate(0);
      h.write(bytes, { at: 0 });
      h.flush();
      h.close();
      self.postMessage({ ok: true, op: 'write', ms: performance.now() - t0, size: bytes.byteLength });
      return;
    }
    if (cmd === 'parse_from_opfs') {
      const eng = await getEngine();         // imports /wasm/data.js (off main thread)
      const tRead = performance.now();
      const h = await handle(false);
      const size = h.getSize();
      const buf = new Uint8Array(size);
      h.read(buf, { at: 0 });
      h.close();
      const readMs = performance.now() - tRead;

      const tParse = performance.now();
      const json = eng.parse_csv(buf);       // synchronous Polars parse — the freeze, now off-thread
      const parseMs = performance.now() - tParse;

      const tM = performance.now();
      const summary = JSON.parse(json);
      const marshalMs = performance.now() - tM;

      self.postMessage({
        ok: true, op: 'parse_from_opfs',
        readMs, parseMs, marshalMs, bytes: size,
        rows: summary.row_count ?? summary.rows ?? null,
        cols: Array.isArray(summary.columns) ? summary.columns.length : (summary.col_count ?? null),
      });
      return;
    }
    self.postMessage({ ok: false, error: 'unknown cmd ' + cmd });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
};
