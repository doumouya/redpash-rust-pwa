#!/usr/bin/env node
/* Purpose: theme-coverage audit — hardcoded colours that won't recolour on theme switch.
 * Doc: docs/internal/code/tools/audit-suite/theme-coverage-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash theme-coverage audit
   ---------------------------------------------------------------------------
   The design language is 4 themes on ONE `--rp-*` semantic-token API. An element
   only re-themes if its colours come from `var(--rp-*)`. A literal colour
   (hex / rgb / rgba / hsl) hardcodes ONE theme's value, so the element stays
   that colour in the other 3 themes — "not covered by the framework".

   This scans every .css under the styles dir and flags each colour LITERAL that
   is not a `var(--rp-*)` reference. tokens.css is the legitimate definer (it maps
   the literals per theme) and is skipped. Known catppuccin-mocha literals are
   mapped to the semantic token that should replace them.

   Usage:  node audit.js [stylesDir]
   Output: ./audit.html  + console summary; exit 1 if any leak (gate for audit.sh).
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const STYLES_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '..', 'frontend', 'styles');

// The legit definer (declares the palette per theme) — never a leak.
const SKIP = new Set(['tokens.css']);

// Known literals → the semantic token they should be. Catppuccin-mocha is the
// palette the atoms were first authored against, so its values leak most.
//   accent #f38ba8 · warn #f9e2af · info/accent-2 #89b4fa · ok #a6e3a1
// severity 'leak' = a semantic colour that MUST recolour (gates the build);
// 'warn' = theme-neutral (black shadow / dark scrim) — tracked, not gated.
const KNOWN = [
  { re: /#f38ba8|243,\s*139,\s*168/i, token: '--rp-accent-soft', note: 'mocha accent (pink)',  sev: 'leak' },
  { re: /#f9e2af|249,\s*226,\s*175/i, token: '--rp-warn-soft',   note: 'mocha warn (yellow)',  sev: 'leak' },
  { re: /#89b4fa|137,\s*180,\s*250/i, token: '--rp-info-soft',   note: 'mocha info/accent-2 (blue)', sev: 'leak' },
  { re: /#a6e3a1|166,\s*227,\s*161/i, token: '--rp-ok-soft',     note: 'mocha ok (green)',     sev: 'leak' },
  { re: /#cdd6f4|205,\s*214,\s*244/i, token: '--rp-text',        note: 'mocha text',           sev: 'leak' },
  { re: /rgba?\(\s*0[,\s]+0[,\s]+0|#000\b/i, token: '--rp-shadow*', note: 'black shadow/inset', sev: 'warn' },
];

// A colour literal as a value: #rgb[a]/#rrggbb[aa], rgb()/rgba(), hsl()/hsla().
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
// Literals that are theme-neutral by nature — not a leak.
const NEUTRAL = /^#0000|transparent|currentcolor|inherit/i;

/** Strip /* *\/ comments so a colour in a comment isn't flagged. */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

function classify(lit) {
  for (const k of KNOWN) if (k.re.test(lit)) return k;
  return { token: '(review)', note: 'non-token colour', sev: 'warn' };
}

function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const noComments = stripComments(raw).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = noComments[i] || '';
    let m;
    COLOR.lastIndex = 0;
    while ((m = COLOR.exec(line)) !== null) {
      const lit = m[0];
      if (NEUTRAL.test(lit)) continue;
      const c = classify(lit);
      out.push({ line: i + 1, literal: lit, token: c.token, note: c.note, sev: c.sev, text: lines[i].trim().slice(0, 90) });
    }
  }
  return out;
}

function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (e.name.endsWith('.css') && !SKIP.has(e.name)) files.push(p);
  }
  return files;
}

const files = walk(STYLES_DIR).sort();
const findings = [];
for (const f of files) {
  const rel = path.relative(path.dirname(STYLES_DIR), f);
  for (const hit of scanFile(f)) findings.push({ file: rel, ...hit });
}

// ── console summary ──────────────────────────────────────────────────────
const leaks = findings.filter(f => f.sev === 'leak');   // gate: semantic colours that must recolour
const warns = findings.filter(f => f.sev === 'warn');   // theme-neutral shadows / overlays / review
const byToken = {};
for (const f of leaks) byToken[f.token] = (byToken[f.token] || 0) + 1;
console.log(`\nTHEME-COVERAGE AUDIT — ${leaks.length} colour LEAK(s) (gate) + ${warns.length} warn (shadow/overlay, tracked)`);
console.log('a LEAK is a semantic colour hardcoded to one theme — it will NOT recolour on theme switch\n');
for (const [tok, n] of Object.entries(byToken).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  → ${tok}`);
}
console.log('');
console.log('\n  LEAKS (gate):');
const byFile = {};
for (const f of leaks) (byFile[f.file] ||= []).push(f);
if (!leaks.length) console.log('    — none — every surviving element recolours via --rp-* tokens ✓');
for (const [file, hits] of Object.entries(byFile)) {
  console.log(`  ${file}  (${hits.length})`);
  for (const h of hits) console.log(`      :${h.line}  ${h.literal}  → ${h.token}  [${h.note}]`);
}

// ── HTML report ──────────────────────────────────────────────────────────
const rows = findings.map(f =>
  `<tr><td>${f.file}</td><td class=n>${f.line}</td><td><code>${f.literal.replace(/</g, '&lt;')}</code></td>` +
  `<td><code>${f.token}</code></td><td>${f.note}</td><td class=src>${f.text.replace(/</g, '&lt;')}</td></tr>`).join('\n');
const html = `<!doctype html><meta charset=utf-8><title>theme-coverage audit</title>
<style>body{font:13px/1.5 system-ui;margin:2rem;background:#15171b;color:#e6e8ec}
h1{font-size:1.2rem}table{border-collapse:collapse;width:100%}th,td{padding:.35rem .6rem;border-bottom:1px solid #2a2e37;text-align:left;vertical-align:top}
th{color:#a0a6b0;font-size:.75rem;text-transform:uppercase}.n{text-align:right;color:#6b7280}code{color:#f5b14c}.src{color:#6b7280}</style>
<h1>Theme-coverage audit — ${findings.length} hardcoded-colour leak(s)</h1>
<p>Each is a colour that bypasses the <code>--rp-*</code> tokens, so the element does not recolour across the 4 themes.</p>
<table><thead><tr><th>sheet</th><th>line</th><th>literal</th><th>should be</th><th>note</th><th>rule</th></tr></thead>
<tbody>${rows}</tbody></table>`;
fs.writeFileSync(path.join(__dirname, 'audit.html'), html);

// Gate on colour LEAKS only; shadows/overlays are theme-neutral warnings.
process.exit(leaks.length > 0 ? 1 : 0);
