#!/usr/bin/env node
/* wasm-smoke — load the built engine in a NODE host (no browser), enumerate
   every export (the introspection surface), and exercise parse_score
   including a lazy-collect path. This is what caught the predecessor's
   .enable_time runtime panic that a green cargo check hid. */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = join(root, "frontend", "wasm");
const wasmFile = readdirSync(wasmDir).find((f) => /^data_bg\.[0-9a-f]+\.wasm$/.test(f));
if (!wasmFile) {
  console.error("wasm-smoke: no built engine (run tools/build-wasm.sh)");
  process.exit(1);
}

const mod = await import(join(wasmDir, "data.js"));
mod.initSync({ module: readFileSync(join(wasmDir, wasmFile)) });

const exports = Object.entries(mod)
  .filter(([k, v]) => typeof v === "function" && k !== "default" && !k.startsWith("__"))
  .map(([k]) => k);
console.log(`exports (${exports.length}): ${exports.join(", ")}`);

const csv = "id,name,amount\n1,Alice,10\n2,Bob,20\n2,Bob,20\n3,inconnu,N/A\n";
const out = JSON.parse(mod.parse_score(new TextEncoder().encode(csv), undefined));
console.log(`parse_score: rows=${out.rows} cols=${out.cols} score=${out.score?.toFixed(2)} encoding=${out.encoding}`);
if (out.rows !== 4 || out.cols !== 3 || out.score == null) {
  console.error("wasm-smoke: unexpected result");
  process.exit(1);
}

/* Workbook — the resident client engine. Construct from CSV bytes, then page,
   filter_page (a real filter that DROPS rows), and score. filter_page is the
   lazy-collect path (apply_filter → df.lazy().filter().collect()) inside the
   single-threaded node host — this is the check that catches a fork/thread
   panic that a green cargo check would hide. */
if (typeof mod.Workbook?.from_csv !== "function") {
  console.error("wasm-smoke: Workbook.from_csv export missing");
  process.exit(1);
}
const wb = mod.Workbook.from_csv(new TextEncoder().encode(csv), undefined);
if (wb.rows() !== 4 || wb.cols() !== 3) {
  console.error(`wasm-smoke: Workbook shape wrong rows=${wb.rows()} cols=${wb.cols()}`);
  process.exit(1);
}

const fullPage = JSON.parse(wb.page(0, 100));
console.log(`Workbook.page: total=${fullPage.total} cols=[${fullPage.columns.join(",")}] rows=${fullPage.rows.length}`);
if (fullPage.total !== 4 || fullPage.columns.length !== 3 || fullPage.rows.length !== 4) {
  console.error("wasm-smoke: Workbook.page unexpected");
  process.exit(1);
}

/* A real filter that drops rows: amount = "20" → 2 of the 4 rows. */
const filter = {
  node: "group",
  op: "and",
  children: [{ node: "pred", col: "amount", op: "eq", value: "20" }],
};
const filtered = JSON.parse(wb.filter_page(JSON.stringify(filter), 0, 100));
console.log(`Workbook.filter_page: total=${filtered.total} rows=${filtered.rows.length} cols=[${filtered.columns.join(",")}]`);
if (filtered.total >= fullPage.total) {
  console.error(`wasm-smoke: filter did not drop rows (filtered=${filtered.total} full=${fullPage.total})`);
  process.exit(1);
}
if (filtered.total !== 2) {
  console.error(`wasm-smoke: expected 2 filtered rows, got ${filtered.total}`);
  process.exit(1);
}
/* Columns must survive the filter intact (same names, same order). */
if (JSON.stringify(filtered.columns) !== JSON.stringify(fullPage.columns)) {
  console.error("wasm-smoke: filter_page columns drifted from page columns");
  process.exit(1);
}

/* An empty (match-all) group must return the whole frame. */
const all = JSON.parse(wb.filter_page(JSON.stringify({ node: "group", op: "and", children: [] }), 0, 100));
if (all.total !== fullPage.total) {
  console.error(`wasm-smoke: empty filter not match-all (got ${all.total}, want ${fullPage.total})`);
  process.exit(1);
}

/* view — the unified QuerySpec window { filter?, search?, sort? } -> page. Covers
   the toolbar search (free-text across every column), sort, and their compose. */
if (typeof wb.view !== "function") {
  console.error("wasm-smoke: Workbook.view export missing");
  process.exit(1);
}
/* sort-only: name desc reorders without changing the count. */
const sorted = JSON.parse(wb.view(JSON.stringify({ sort: [{ col: "name", descending: true }] }), 0, 100));
console.log(`Workbook.view sort: total=${sorted.total} first=${sorted.rows[0]?.[1]}`);
if (sorted.total !== fullPage.total || sorted.rows[0][1] !== "inconnu") {
  console.error(`wasm-smoke: view sort desc by name wrong (total=${sorted.total} first=${sorted.rows[0]?.[1]})`);
  process.exit(1);
}
/* search: "bob" hits the two Bob rows (case-insensitive, any column). */
const searched = JSON.parse(wb.view(JSON.stringify({ search: "bob" }), 0, 100));
console.log(`Workbook.view search "bob": total=${searched.total}`);
if (searched.total !== 2) {
  console.error(`wasm-smoke: view search "bob" expected 2 rows, got ${searched.total}`);
  process.exit(1);
}
/* search matches NUMERIC columns as text: "20" is in amount 20 (the 2 Bob rows). */
const searchNum = JSON.parse(wb.view(JSON.stringify({ search: "20" }), 0, 100));
if (searchNum.total !== 2) {
  console.error(`wasm-smoke: view search "20" expected 2 rows (amount=20), got ${searchNum.total}`);
  process.exit(1);
}
/* filter + search compose (AND): amount=20 AND "bob" → the 2 rows. */
const composed = JSON.parse(wb.view(JSON.stringify({ filter, search: "bob" }), 0, 100));
if (composed.total !== 2) {
  console.error(`wasm-smoke: view filter+search expected 2 rows, got ${composed.total}`);
  process.exit(1);
}
/* empty query {} is byte-identical to the bare page. */
const bare = JSON.parse(wb.view(JSON.stringify({}), 0, 100));
if (bare.total !== fullPage.total || bare.rows.length !== fullPage.rows.length) {
  console.error("wasm-smoke: view {} != page");
  process.exit(1);
}

const wbScore = JSON.parse(wb.score());
console.log(`Workbook.score: score=${wbScore.score?.toFixed(2)} cols=${wbScore.cols}`);
if (wbScore.score == null || wbScore.cols !== 3) {
  console.error("wasm-smoke: Workbook.score unexpected");
  process.exit(1);
}

console.log("wasm-smoke: OK");
