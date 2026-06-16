#!/usr/bin/env node
/* Purpose: detect page-bound FE-framework duplication — functions defined in
 * ≥2 source files (the copy-paste a shared framework layer would collapse),
 * ranked by reuse = the evidence-based extraction order for CAS_9E4F134B.
 * Doc: docs/internal/code/tools/audit-suite/fe-framework-audit.md
 *
 * The alarm Em named ([[no-code-debt]]): a "framework" living inside a page
 * closure gets re-implemented per page/app instead of imported from a shared
 * layer. This audit turns the hand-compiled candidate table into measured,
 * ranked data + the durable guard (drift fails the tool, not the user —
 * [[process-oriented]]). Read-only; Acorn AST is the static-analysis carve-out
 * from the no-frameworks rule ([[feedback-acorn-allowed-for-static-analysis]]).
 *
 * Signal: a function NAME defined in ≥2 distinct files under the lean FE roots
 *   (frontend/framework + frontend/apps).
 *   - identical normalised body across files → true copy-paste (extract now)
 *   - same name, divergent bodies            → parallel impls (likely extract)
 * severity = number of files = extraction priority. A name shared between two
 * apps (apps/studio/… ↔ apps/admin/…), or between an app and a not-yet-shared
 * helper, is the page-bound-framework smell this tool exists to surface.
 *
 * LEAN ADAPTATION: prerelease scanned the single flat frontend/scripts/ tree
 * (since retired). The lean cut splits JS across frontend/framework/<component>
 * and frontend/apps/<app>/<page>; both are scanned and findings are reported
 * relative to frontend/ so the framework-vs-app origin stays legible. The AST
 * logic, hashing, ranking, pair-rollup, and console/JSON output are unchanged
 * from prerelease.
 *
 * Usage: node tools/fe-framework-audit/audit.js
 *        ./audit.json — canonical findings payload (ingest-ready; not yet
 *        whitelisted in audit.sh / explode — follow-up).
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const REPO = path.resolve(__dirname, '..', '..');
const FE = path.join(REPO, 'frontend');
// Lean FE JS homes (frontend/scripts was retired in the lean cut). Each root is
// scanned recursively; paths are reported relative to frontend/ so a
// `framework/…` vs `apps/<app>/<page>/…` origin is visible in every finding.
const ROOTS = [path.join(FE, 'framework'), path.join(FE, 'apps')].filter((d) => fs.existsSync(d));
const OUT = path.join(__dirname, 'audit.json');

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && /\.js$/i.test(e.name) && !/\.min\.js$/i.test(e.name)) acc.push(full);
  }
  return acc;
};
const walkAst = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walkAst(c, visit));
    else if (v && typeof v.type === 'string') walkAst(v, visit);
  }
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

// name -> [{ file, bodyHash, bytes }]
const defs = {};
const files = ROOTS.flatMap((r) => walk(r)).sort();
for (const full of files) {
  // Report relative to frontend/ → "framework/rail/rail.js", "apps/studio/workspace/workspace.js"
  const rel = path.relative(FE, full).split(path.sep).join('/');
  const text = fs.readFileSync(full, 'utf8');
  let ast;
  try { ast = acorn.parse(text, { ecmaVersion: 2024, sourceType: 'module' }); }
  catch { continue; } // unparseable (e.g. wasm glue) — skip, not the target
  walkAst(ast, (n) => {
    let name = null, bodyNode = null;
    if (n.type === 'FunctionDeclaration' && n.id) { name = n.id.name; bodyNode = n.body; }
    else if (n.type === 'VariableDeclarator' && n.id && n.id.name && n.init &&
             (n.init.type === 'ArrowFunctionExpression' || n.init.type === 'FunctionExpression')) {
      name = n.id.name; bodyNode = n.init.body;
    }
    if (!name || !bodyNode) return;
    const body = norm(text.slice(bodyNode.start, bodyNode.end));
    (defs[name] = defs[name] || []).push({ file: rel, bodyHash: hash(body), bytes: body.length });
  });
}

const findings = [];
for (const [name, occ] of Object.entries(defs)) {
  const fileSet = [...new Set(occ.map((o) => o.file))];
  if (fileSet.length < 2) continue; // single-home = not duplicated
  const identical = new Set(occ.map((o) => o.bodyHash)).size === 1;
  findings.push({
    kind: 'page_bound_framework',
    finding_key: name,
    severity: fileSet.length,
    detail: { name, files: fileSet, identical_body: identical, occurrences: occ.length,
              avg_bytes: Math.round(occ.reduce((a, o) => a + o.bytes, 0) / occ.length) },
  });
}
findings.sort((a, b) =>
  b.severity - a.severity ||
  (b.detail.identical_body === a.detail.identical_body ? 0 : (b.detail.identical_body ? 1 : -1)) ||
  b.detail.avg_bytes - a.detail.avg_bytes ||
  a.finding_key.localeCompare(b.finding_key));

// File-pair rollup: which two files share the most duplicated helpers. The
// top pair = the framework to extract first (one shared layer collapses N
// reinvented helpers). This is the actionable "extract first" signal.
const pairCount = {};
for (const f of findings) {
  const fl = f.detail.files;
  for (let i = 0; i < fl.length; i++)
    for (let j = i + 1; j < fl.length; j++) {
      const key = [fl[i], fl[j]].sort().join('  ↔  ');
      (pairCount[key] = pairCount[key] || []).push(f.finding_key);
    }
}
const pairs = Object.entries(pairCount)
  .map(([pair, fns]) => ({ pair, shared: fns.length, fns }))
  .filter((p) => p.shared >= 2)
  .sort((a, b) => b.shared - a.shared);

const stats = {
  files: files.length,
  duplicated_names: findings.length,
  identical_copies: findings.filter((f) => f.detail.identical_body).length,
  top_pairs: pairs.slice(0, 8).map((p) => ({ pair: p.pair, shared: p.shared })),
};
fs.writeFileSync(OUT, JSON.stringify({ tool: 'fe-framework', ran_at: new Date().toISOString(), stats, findings, pairs }, null, 2));

console.log(`\nTop file-pairs by shared helpers — the extract-first signal:\n`);
console.log('  shared  file pair');
console.log('  ' + '-'.repeat(72));
for (const p of pairs.slice(0, 8)) {
  console.log(`    ${String(p.shared).padStart(2)}    ${p.pair}`);
}

console.log(`\nFE framework duplication — ${findings.length} fn names defined across ≥2 files  (${files.length} files scanned)\n`);
console.log('  files  body  function                         defined in');
console.log('  ' + '-'.repeat(82));
for (const f of findings.slice(0, 45)) {
  const glyph = f.detail.identical_body ? '════' : ' ~~ ';
  console.log(`   ${String(f.severity).padStart(3)}   ${glyph}  ${f.finding_key.padEnd(30)} ${f.detail.files.join(', ')}`);
}
if (findings.length > 45) console.log(`   … +${findings.length - 45} more (see audit.json)`);
console.log(`\n  ════ identical body across files (copy-paste → extract)   ~~ same name, divergent impl`);
console.log(`  ${stats.identical_copies} identical-copy frameworks · json -> ${path.relative(REPO, OUT)}`);
