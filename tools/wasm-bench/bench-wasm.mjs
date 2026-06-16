#!/usr/bin/env node
/* bench-wasm — time the engine ops on ONE corpus file in a node host (the wasm
   surface). Emits one JSON line of results for that size to stdout.

   Run as a FRESH CHILD PROCESS per size (the orchestrator does this): wasm
   linear memory only grows within a process, so reusing one process across
   sizes would carry an earlier (smaller) size's high-water into a later peak —
   or a later (bigger) size's into an earlier one. One process = one size = one
   honest peak.

   Reuses the wasm-smoke loader (find data_bg.<hash>.wasm, import data.js,
   initSync) and the same op call-shapes the engine exposes.

   Usage: node bench-wasm.mjs <corpus.csv> <rows> <build_flag>   (e.g. Oz) */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

const [, , corpusPath, rowsArg, buildFlag = "Oz"] = process.argv;
if (!corpusPath) {
  console.error("usage: bench-wasm.mjs <corpus.csv> <rows> <build_flag>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wasmDir = join(root, "frontend", "wasm");
const wasmFile = readdirSync(wasmDir).find((f) => /^data_bg\.[0-9a-f]+\.wasm$/.test(f));
if (!wasmFile) {
  console.error("bench-wasm: no built engine (run tools/build-wasm.sh)");
  process.exit(1);
}

const mod = await import(join(wasmDir, "data.js"));
// initSync returns the wasm exports — `.memory` is the linear memory we peak.
const wasm = mod.initSync({ module: readFileSync(join(wasmDir, wasmFile)) });

const bytes = new Uint8Array(readFileSync(corpusPath));

// W warmup runs (discarded — JIT + caches), then K measured; report the median
// (robust to GC/JIT outliers that a mean would smear). Smaller K for the big
// sizes keeps the total sweep reasonable without hurting the median.
const rows = Number(rowsArg);
const K = rows >= 250_000 ? 4 : 6;
const W = 2;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function bench(fn) {
  for (let i = 0; i < W; i++) fn();
  const t = [];
  for (let i = 0; i < K; i++) {
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  return +median(t).toFixed(3);
}

// Resident workbook for the windowed ops (parse it ONCE; parse is timed
// separately by re-parsing the bytes).
const wb = mod.Workbook.from_csv(bytes, undefined);
const total = wb.rows();
const cols = JSON.parse(wb.page(0, 1)).columns;
const col0 = cols[0];

const FILTER = JSON.stringify({
  filter: { node: "group", op: "and", children: [{ node: "pred", col: col0, op: "contains", value: "1" }] },
});
const SEARCH = JSON.stringify({ search: "1" }); // OR-contains across ALL columns
const SORT = JSON.stringify({ sort: [{ col: col0, descending: true }] });

// the JS-side marshal cost: JSON.parse of a full page string (wasm-only tax).
const pageStr = wb.page(0, 100);

const out = {
  surface: "wasm",
  build: buildFlag,
  rows: total,
  cols: cols.length,
  parse_ms: bench(() => mod.Workbook.from_csv(bytes, undefined)),
  page_ms: bench(() => wb.page(0, 100)),
  filter_ms: bench(() => wb.view(FILTER, 0, 100)),
  search_ms: bench(() => wb.view(SEARCH, 0, 100)),
  sort_ms: bench(() => wb.view(SORT, 0, 100)),
  score_ms: bench(() => wb.score()),
  json_parse_ms: bench(() => JSON.parse(pageStr)),
  // wasm linear-memory high-water after parse+ops (the device-memory ceiling).
  wasm_mem_mb: wasm?.memory?.buffer
    ? +(wasm.memory.buffer.byteLength / 1024 / 1024).toFixed(1)
    : null,
  rss_mb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
};

console.log(JSON.stringify(out));
