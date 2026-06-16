#!/usr/bin/env node
/* Find the wasm memory ceiling: parse a corpus, report the wasm linear-memory
   high-water; on OOM (memory.grow fails / RangeError) catch it and report the
   failure instead of crashing. Run per-size in a FRESH child process so each
   size starts from a clean linear memory. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [, , corpusPath, rowsArg] = process.argv;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wasmDir = join(root, "frontend", "wasm");
const wf = readdirSync(wasmDir).find((f) => /^data_bg\.[0-9a-f]+\.wasm$/.test(f));
const mod = await import(join(wasmDir, "data.js"));
const wasm = mod.initSync({ module: readFileSync(join(wasmDir, wf)) });

const bytes = new Uint8Array(readFileSync(corpusPath));
const csv_mb = +(bytes.byteLength / 1048576).toFixed(0);
try {
  const wb = mod.Workbook.from_csv(bytes, undefined);
  const total = wb.rows();
  const cols = JSON.parse(wb.page(0, 1)).columns.length;
  const mem = +(wasm.memory.buffer.byteLength / 1048576).toFixed(0);
  console.log(JSON.stringify({ rows: total, cols, csv_mb, ok: true, wasm_mem_mb: mem, mb_per_1k: +(mem / (total / 1000)).toFixed(2) }));
} catch (e) {
  console.log(JSON.stringify({ rows: +rowsArg, csv_mb, ok: false, failure: String(e.message || e).slice(0, 100) }));
}
