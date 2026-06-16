#!/usr/bin/env node
/* aggregate — pair the wasm + native JSONL rows per size into the deliverable:
   results-<shape>.json (structured) + results-<shape>.md (per-op scaling tables,
   the wasm/native ratio, memory, the JS-side marshal cost, and the per-op cliff).
   Usage: node aggregate.mjs <raw.jsonl> <shape> */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , rawPath, shape = "wide"] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });

const rows = readFileSync(rawPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const bySize = {};
for (const r of rows) (bySize[r.rows] ??= {})[r.surface] = r;
const sizes = Object.keys(bySize).map(Number).sort((a, b) => a - b);

const OPS = ["parse", "page", "filter", "search", "sort", "score"];
const num = (n) => (n == null ? "—" : n.toLocaleString());

const table = sizes.map((n) => {
  const w = bySize[n].wasm, nat = bySize[n].native;
  const row = { rows: n, cols: w?.cols ?? nat?.cols ?? null };
  for (const op of OPS) {
    const wv = w?.[`${op}_ms`] ?? null;
    const nv = nat?.[`${op}_ms`] ?? null;
    row[`${op}_wasm`] = wv;
    row[`${op}_native`] = nv;
    row[`${op}_ratio`] = wv != null && nv ? +(wv / nv).toFixed(2) : null;
  }
  row.wasm_mem_mb = w?.wasm_mem_mb ?? null;
  row.wasm_rss_mb = w?.rss_mb ?? null;
  row.native_rss_mb = nat?.rss_mb ?? null;
  row.json_parse_ms = w?.json_parse_ms ?? null;
  return row;
});

// the cliff: first size where a wasm op median crosses the threshold.
const cliff = (op, thr) => table.find((r) => (r[`${op}_wasm`] ?? 0) >= thr)?.rows ?? null;
const cliffs = Object.fromEntries(OPS.map((op) => [op, { ms100: cliff(op, 100), ms1000: cliff(op, 1000) }]));

writeFileSync(join(outDir, `results-${shape}.json`), JSON.stringify({ shape, generated_rows: sizes, table, cliffs }, null, 2));

let md = `# wasm vs native — RedPash data engine (${shape} corpus)\n\n`;
md += `One engine, two surfaces. **wasm = \`-Oz\` (the *shipped* build) in a node host**; `;
md += `**native = \`--release\`** (opt-level 3, multi-threaded). Each cell is the **median** of K warmed runs `;
md += `(K=6, 4 at ≥250k; W=2 warmup). Windowed ops include \`Page::to_json().to_string()\` on BOTH surfaces `;
md += `(marshal parity). Absolutes are machine-relative (WSL2) — **read the ratio**, not the milliseconds.\n\n`;
md += `> Caveats baked in: node ≠ a real browser main thread (no render contention / freeze) — the cap decision needs a browser pass. `;
md += `\`-Oz\` is size-optimized; an \`-O3\` wasm would narrow the ratio (named follow-on). The wasm number carries the JS↔wasm boundary the native number can't.\n\n`;

for (const op of OPS) {
  md += `### ${op}\n\n| rows | wasm \`-Oz\` (ms) | native (ms) | wasm / native |\n|--:|--:|--:|--:|\n`;
  for (const r of table) {
    const ratio = r[`${op}_ratio`] == null ? "—" : `${r[`${op}_ratio`]}×`;
    md += `| ${num(r.rows)} | ${r[`${op}_wasm`] ?? "—"} | ${r[`${op}_native`] ?? "—"} | ${ratio} |\n`;
  }
  md += `\n`;
}

md += `### memory + JS-side marshal\n\n`;
md += `| rows | wasm linear mem (MB) | wasm proc rss (MB) | native rss (MB) | \`JSON.parse\` a page (ms) |\n|--:|--:|--:|--:|--:|\n`;
for (const r of table) {
  md += `| ${num(r.rows)} | ${r.wasm_mem_mb ?? "—"} | ${r.wasm_rss_mb ?? "—"} | ${r.native_rss_mb ?? "—"} | ${r.json_parse_ms ?? "—"} |\n`;
}
md += `\n### cliffs — first size where the **wasm** op median crosses\n\n| op | ≥ 100 ms | ≥ 1 s |\n|--|--:|--:|\n`;
for (const op of OPS) md += `| ${op} | ${num(cliffs[op].ms100)} | ${num(cliffs[op].ms1000)} |\n`;
md += `\nROW_CAP = 500,000 (the client buffer + server clamp). The binding cap is set by the **full-scan ops (parse, score)**, not the windowed ones (page).\n`;

writeFileSync(join(outDir, `results-${shape}.md`), md);
process.stdout.write(md);
