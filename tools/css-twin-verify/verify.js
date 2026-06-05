#!/usr/bin/env node
/* Purpose: decide, per rule in a page sheet, whether an rt-* rule is a byte-equivalent
   framework rp-* duplicate (safe DELETE), unique to the page (RENAME), or DIVERGES
   (manual) — the data that drives a design-language last-consumer cleanup.
   Doc: docs/internal/code/tools/css-twin-verify/verify.md
   Usage: node tools/css-twin-verify/verify.js <page.css> <framework-dir> */
'use strict';
const fs = require('fs');
const path = require('path');

// crude-but-sufficient CSS rule splitter: pairs (selectorList, declBlock), skips @media
// nesting by treating @-blocks' inner rules individually. Good enough for these flat sheets.
function rules(css) {
  const out = [];
  // strip comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;       // skip @keyframes/@media headers
    const decl = m[2].split(';').map(s => s.trim()).filter(Boolean).sort().join('; ');
    out.push({ sel, decl });
  }
  return out;
}
const norm = s => s.replace(/\b(rt|rp)-/g, 'X-');   // canonical: prefix-agnostic selector

const [pageCss, fwDir] = process.argv.slice(2);
const page = rules(fs.readFileSync(pageCss, 'utf8'));
const fw = new Map();                                 // normSel -> Set(decl)
for (const f of fs.readdirSync(fwDir).filter(f => f.endsWith('.css'))) {
  for (const r of rules(fs.readFileSync(path.join(fwDir, f), 'utf8'))) {
    const k = norm(r.sel);
    if (!fw.has(k)) fw.set(k, new Map());
    fw.get(k).set(r.decl, f);
  }
}

const del = [], rename = [], diverge = [];
for (const r of page) {
  const k = norm(r.sel);
  if (fw.has(k)) {
    if (fw.get(k).has(r.decl)) del.push(r.sel + '   [' + fw.get(k).get(r.decl) + ']');
    else diverge.push(r.sel + '  (fw has selector, DIFFERENT decls: ' + [...fw.get(k).values()].join(',') + ')');
  } else {
    rename.push(r.sel);
  }
}
const tag = process.argv[2].split('/').pop();
console.log(`\n=== ${tag}: ${page.length} rules vs framework ===`);
console.log(`\n--- DELETE (byte-equivalent framework twin) : ${del.length} ---`);
del.forEach(s => console.log('  ✓ ' + s));
console.log(`\n--- DIVERGE (twin selector, DIFFERENT decls — MANUAL) : ${diverge.length} ---`);
diverge.forEach(s => console.log('  ⚠ ' + s));
console.log(`\n--- RENAME (unique to page, no framework twin) : ${rename.length} ---`);
rename.forEach(s => console.log('  → ' + s));
