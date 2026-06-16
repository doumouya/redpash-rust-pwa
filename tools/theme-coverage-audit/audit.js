#!/usr/bin/env node
/* Purpose: theme-coverage audit — hardcoded colours that won't recolour on theme switch.
 * Doc: tools/theme-coverage-audit/ (this dir) — see the header block below. */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash theme-coverage audit  (LEAN tree)
   ---------------------------------------------------------------------------
   The design language is 2 themes on ONE `--rp-*` semantic-token API
   (new-dark default + new-light; Catppuccin dropped). An element only
   re-themes if its colours come from `var(--rp-*)`. A literal colour
   (hex / rgb / rgba / hsl) hardcodes ONE theme's value, so the element stays
   that colour in the other theme — "not covered by the framework".

   This scans every authored .css under frontend/ and flags each colour LITERAL
   that is not a `var(--rp-*)` reference. tokens.css is the legitimate definer
   (it maps the literals per theme) and is skipped. Known new-dark literals are
   mapped to the semantic token that should replace them.

   LEAN ADAPTATION (2026-06-16): the prerelease original assumed one central
   styles/ dir (with framework/ + page *.css subdirs) and the Catppuccin-mocha
   palette as the leak source. The lean tree differs on both axes, so:
     • Scan root is frontend/ (not frontend/styles): CSS is co-located —
       framework/<component>/<component>.css + apps/<app>/<page>/<page>.css,
       with the foundation sheets under styles/. Keys are frontend-relative.
     • vendor/ wasm/ wasm-src/ tests/ dist/ node_modules/ are skipped (vendored
       or non-authored CSS isn't ours to token-gate — bootstrap-icons etc.).
     • KNOWN maps the LEAN palette (the new-dark literals from styles/tokens.css,
       the theme authored against) to their `--rp-*` tokens — the retired
       catppuccin-mocha literals are gone from the tree, so mapping them would
       flag nothing. Black-shadow / white-overlay rgba stay theme-neutral warns.
     • Definer skip-set is tokens.css (declares the palette) + prefs.css
       (density/theme attr retunes — no colour literals to gate).
     • Emits audit.json (ingest-compatible — same shape as css-audit /
       doc-coverage-audit / rs-audit) alongside audit.html + console summary.

   Usage:  node tools/theme-coverage-audit/audit.js [scanDir]   (default ../../frontend)
   Output: ./audit.html + ./audit.json (next to this script) + console summary;
           exit code = leak count (gate for tools/ci.sh).
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

// Scan root: the whole authored frontend tree (CSS is co-located, not pooled
// under styles/). Default ../../frontend; an explicit arg overrides for spikes.
const SCAN_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '..', 'frontend');

// Frontend-relative key for a scanned file (e.g. framework/rail/rail.css).
const rel = (f) => path.relative(SCAN_DIR, f).replace(/\\/g, '/');

// Definer sheets — declare the palette / retune attrs; never a leak.
const SKIP_FILE = new Set(['tokens.css', 'prefs.css']);
// Non-authored subtrees: vendored CSS + build outputs + tests aren't ours.
const SKIP_DIR = new Set(['vendor', 'wasm', 'wasm-src', 'tests', 'dist', 'node_modules', '.git']);

// Known literals → the semantic token they should be. The lean atoms were
// first authored against the new-dark palette (styles/tokens.css), so those
// literals are the ones that leak; a hardcoded #15171b stays dark in new-light.
//   accent #f04438 · ok #2dd4a7 · warn #f5b14c · info #5b8def · danger #ff5c5c
// severity 'leak' = a semantic colour that MUST recolour (gates the build);
// 'warn' = theme-neutral (black shadow / white overlay) — tracked, not gated.
const KNOWN = [
  // structural (surface / border / text) — new-dark values
  { re: /#0c0d10\b/i,                          token: '--rp-bg',         note: 'new-dark bg',        sev: 'leak' },
  { re: /#15171b\b/i,                          token: '--rp-surface',    note: 'new-dark surface',   sev: 'leak' },
  { re: /#1c1f25\b/i,                          token: '--rp-surface-2',  note: 'new-dark surface-2', sev: 'leak' },
  { re: /#2a2e37\b/i,                          token: '--rp-border',     note: 'new-dark border',    sev: 'leak' },
  { re: /#e6e8ec\b/i,                          token: '--rp-text',       note: 'new-dark text',      sev: 'leak' },
  { re: /#a0a6b0\b/i,                          token: '--rp-text-dim',   note: 'new-dark text-dim',  sev: 'leak' },
  { re: /#6b7280\b/i,                          token: '--rp-text-mute',  note: 'new-dark text-mute', sev: 'leak' },
  // semantic palette — shared / new-dark values
  { re: /#f04438|240,\s*68,\s*56/i,            token: '--rp-accent',     note: 'accent (red)',       sev: 'leak' },
  { re: /#2dd4a7|45,\s*212,\s*167/i,           token: '--rp-ok',         note: 'new-dark ok (green)', sev: 'leak' },
  { re: /#f5b14c|245,\s*177,\s*76/i,           token: '--rp-warn',       note: 'new-dark warn (amber)', sev: 'leak' },
  { re: /#5b8def|91,\s*141,\s*239/i,           token: '--rp-info',       note: 'new-dark info (blue)', sev: 'leak' },
  { re: /#ff5c5c|255,\s*92,\s*92/i,            token: '--rp-danger',     note: 'danger',             sev: 'leak' },
  // theme-neutral by nature — black shadows / white overlays (the --rp-shadow,
  // --rp-glass, --rp-hover tokens are built FROM these) → tracked, not gated.
  { re: /rgba?\(\s*0[,\s]+0[,\s]+0|#000\b/i,   token: '--rp-shadow*',    note: 'black shadow/scrim', sev: 'warn' },
  { re: /rgba?\(\s*255[,\s]+255[,\s]+255/i,    token: '--rp-glass*',     note: 'white overlay/glass', sev: 'warn' },
];

// A colour literal as a value: #rgb[a]/#rrggbb[aa], rgb()/rgba(), hsl()/hsla().
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
// Literals that are theme-neutral by nature — not a leak.
const NEUTRAL = /^#0000|transparent|currentcolor|inherit/i;

/** Strip CSS comments so a colour inside a comment isn't flagged. */
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
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      files.push(...walk(path.join(dir, e.name)));
    } else if (e.name.endsWith('.css') && !SKIP_FILE.has(e.name)) {
      files.push(path.join(dir, e.name));
    }
  }
  return files;
}

const files = walk(SCAN_DIR).sort();
const findings = [];
for (const f of files) {
  for (const hit of scanFile(f)) findings.push({ file: rel(f), ...hit });
}

// ── partition ──────────────────────────────────────────────────────────────
const leaks = findings.filter(f => f.sev === 'leak');   // gate: semantic colours that must recolour
const warns = findings.filter(f => f.sev === 'warn');   // theme-neutral shadows / overlays / review
const byToken = {};
for (const f of leaks) byToken[f.token] = (byToken[f.token] || 0) + 1;

// ── console summary ──────────────────────────────────────────────────────
console.log(`\nTHEME-COVERAGE AUDIT — ${leaks.length} colour LEAK(s) (gate) + ${warns.length} warn (shadow/overlay/review, tracked)`);
console.log('a LEAK is a semantic colour hardcoded to one theme — it will NOT recolour on the new-dark/new-light switch\n');
for (const [tok, n] of Object.entries(byToken).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  → ${tok}`);
}
console.log('\n  LEAKS (gate):');
const byFile = {};
for (const f of leaks) (byFile[f.file] ||= []).push(f);
if (!leaks.length) console.log('    — none — every surviving element recolours via --rp-* tokens ✓');
for (const [file, hits] of Object.entries(byFile)) {
  console.log(`  ${file}  (${hits.length})`);
  for (const h of hits) console.log(`      :${h.line}  ${h.literal}  → ${h.token}  [${h.note}]`);
}

// ── audit.json (ingest-compatible — same shape as css-audit / doc-coverage) ──
const json = {
  generatedAt: new Date().toISOString(),
  scanDir: SCAN_DIR,
  model: 'lean-two-theme-rp-tokens',
  stats: {
    filesScanned: files.length,
    totalFindings: findings.length,
    leaks: leaks.length,
    warns: warns.length,
    byToken,
  },
  findings: findings.map(f => ({
    kind: f.sev === 'leak' ? 'theme_leak' : 'theme_neutral',
    severity: f.sev === 'leak' ? 'high' : 'low',
    file: f.file,
    line: f.line,
    literal: f.literal,
    expected: f.token,
    note: f.note,
    snippet: f.text,
  })),
};
fs.writeFileSync(path.join(__dirname, 'audit.json'), JSON.stringify(json, null, 2) + '\n');

// ── HTML report ──────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rows = findings.map(f =>
  `<tr class="${f.sev}"><td>${esc(f.file)}</td><td class=n>${f.line}</td><td><code>${esc(f.literal)}</code></td>` +
  `<td><code>${esc(f.token)}</code></td><td>${esc(f.note)}</td><td class=sev>${f.sev}</td><td class=src>${esc(f.text)}</td></tr>`).join('\n');
const html = `<!doctype html><meta charset=utf-8><title>theme-coverage audit</title>
<style>body{font:13px/1.5 system-ui;margin:2rem;background:#15171b;color:#e6e8ec}
h1{font-size:1.2rem}p{color:#a0a6b0}table{border-collapse:collapse;width:100%}
th,td{padding:.35rem .6rem;border-bottom:1px solid #2a2e37;text-align:left;vertical-align:top}
th{color:#a0a6b0;font-size:.75rem;text-transform:uppercase}.n{text-align:right;color:#6b7280}
code{color:#f5b14c}.src{color:#6b7280}tr.leak .sev{color:#ff5c5c;font-weight:600}tr.warn .sev{color:#6b7280}</style>
<h1>Theme-coverage audit — ${leaks.length} leak(s) + ${warns.length} warn</h1>
<p>A <b>leak</b> is a colour that bypasses the <code>--rp-*</code> tokens, so the element does not recolour across the new-dark / new-light themes. Warns are theme-neutral shadows / overlays / non-token colours (tracked, not gated).</p>
<table><thead><tr><th>sheet</th><th>line</th><th>literal</th><th>should be</th><th>note</th><th>sev</th><th>rule</th></tr></thead>
<tbody>${rows}</tbody></table>`;
fs.writeFileSync(path.join(__dirname, 'audit.html'), html);

// Gate on colour LEAKS only; shadows/overlays/review are theme-neutral warnings.
process.exit(leaks.length > 0 ? 1 : 0);
