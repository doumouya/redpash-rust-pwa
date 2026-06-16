#!/usr/bin/env node
/* Purpose: runtime UI divergence — ?audit=2 live-DOM capture vs the static FE component enumeration.
   Doc: docs/internal/code/tools/audit-suite/ui-runtime-audit.md (pending in lean; tracked under docs/REDMAP.md) */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash ui-runtime-audit — the runtime × static divergence check.

   A static enumerator lists every component that EXISTS in the source (CSS-defined
   rp-* block roots). This tool checks that list against what the app ACTUALLY
   RENDERS — the ?audit=2 captures (snapshot.js captureInventory, driven by
   Playwright). The two-way diff is the value:

     • rendered-not-enumerated → a class the live DOM renders that the static
       scan never saw — a true completeness hole in the enumeration. HARD signal.
     • enumerated-not-rendered → a component in the source not seen in any
       captured state — a gated/dead candidate (deeper interaction needed, or
       removable). ADVISORY (can't prove dead without exhaustive driving).

   ── LEAN ADAPTATION ────────────────────────────────────────────────────────
   Prerelease delegated the static baseline to `require('../lib/fe-inventory')`
   (fe.inventory()/_scan()/blockRoot()), which scanned the single flat
   frontend/{styles,partials,scripts} + index.html tree. The lean cut RETIRED
   that layout AND never ported fe-inventory.js into this tree (no lean tool
   requires it). So this tool is now SELF-CONTAINED: it inlines the minimal
   block-root enumerator the divergence check actually needs (CSS-defined block
   roots + the climb-to-block fold), scanning the LEAN FE homes:
       frontend/framework/<component>/   (per-component css/html/js)
       frontend/apps/<app>/<page>/
       frontend/styles/{tokens,main,base,prefs}.css
       frontend/index.html               (the shell)
   The CSS namespace is rp-* only (rt-/ds-/ws- retired in lean), so ours() and
   the class-token regex match rp- alone. The two-way diff, severities,
   audit.json/report.html/console output shapes are UNCHANGED from prerelease.
   framework-sandbox.html is excluded (demo harness, not shipped) — same rule as
   the sibling class-count-audit.

   BASELINE = the inline live scan (always-current vs the source), NOT a
   gitignored snapshot — so the comparator can't drift from the true static
   enumeration.

   Read-only. No deps beyond Node core. Emits audit.json + report.html.

   Capture: open the app `?audit=2`, navigate routes/states via Playwright,
   `captureInventory(state)` → drop JSON into tools/ui-runtime-audit/captures/.
   Usage:  node tools/ui-runtime-audit/audit.js [capturesDir]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var FE = path.join(ROOT, 'frontend');

var CAPTURES_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'captures');
var OUT_JSON = path.join(__dirname, 'audit.json');
var OUT_HTML = path.join(__dirname, 'report.html');

/* Lean namespace: rp- only (rt-/ds-/ws- retired). */
function ours(c) { return /^rp-/.test(c); }

/* Class tokens: `rp-` + `-`/`__`-joined segments captured WHOLE (BEM `__element`
   kept and folded to its block; `--modifier` breaks the run, so it's stripped). */
var CLASS_TOK = /\brp-[a-z0-9]+(?:(?:-|_+)[a-z0-9]+)*/g;
var CSS_DEF   = /\.(rp-[a-z0-9]+(?:(?:-|_+)[a-z0-9]+)*)/g;   // a class as a selector subject

/* ── recursive file walk ──────────────────────────────────────────────────── */
function walk(dir, exts, out) {
  out = out || [];
  var ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'vendor' || e.name.charAt(0) === '.') return;
      walk(p, exts, out);
    } else if (exts.some(function (x) { return e.name.endsWith(x); })) {
      if (/framework-sandbox\.html$/.test(e.name)) return;   // demo harness, not shipped
      out.push(p);
    }
  });
  return out;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

/* ── lean static scan: CSS-defined block roots from the component homes ───────
   Lean ships CSS per-component (frontend/framework/<c>/*.css) + the shared
   frontend/styles + the shell index.html. We only need the set of DEFINED
   classes to fold a rendered class to its block root. */
function scan() {
  var cssFiles = walk(path.join(FE, 'framework'), ['.css'])
    .concat(walk(path.join(FE, 'apps'), ['.css']))
    .concat(walk(path.join(FE, 'styles'), ['.css']));
  var defined = Object.create(null);   // class → true (defined as a selector subject)
  cssFiles.forEach(function (f) {
    var txt = read(f), m;
    CSS_DEF.lastIndex = 0;
    while ((m = CSS_DEF.exec(txt))) { defined[m[1]] = true; }
  });
  return { defined: defined, counts: { css: cssFiles.length } };
}

/* ── block-root folding (the grouping rule, ported verbatim from fe-inventory) ─
   BEM `block__element` → block is everything before the first `_`; the block then
   climbs its `-` ancestor chain to the longest DEFINED proper ancestor (gap-skipping). */
function blockRoot(cls, defined) {
  var us = cls.indexOf('_');
  var cur = us >= 0 ? cls.slice(0, us) : cls, guard = 0;
  while (guard++ < 40) {
    var parts = cur.split('-');
    var next = null;
    for (var n = parts.length - 1; n >= 2; n--) {       // longest defined PROPER ancestor
      var anc = parts.slice(0, n).join('-');
      if (defined[anc]) { next = anc; break; }
    }
    if (next) { cur = next; continue; }                 // climb (gap-skipping)
    return cur;
  }
  return cur;
}

/* The static enumerated component set = the DISTINCT block roots of every defined class. */
function enumeratedBlocks(s) {
  var set = Object.create(null);
  Object.keys(s.defined).forEach(function (c) { set[blockRoot(c, s.defined)] = true; });
  return set;
}

/* Load ?audit=2 inventory captures. Accepts either a single captureInventory()
   object ({classes:[…]}) or a combined map ({label:{classes:[…]}}). */
function loadCaptures(dir) {
  var caps = [];
  var files;
  try { files = fs.readdirSync(dir).filter(function (n) { return /\.json$/i.test(n); }).sort(); }
  catch (e) { return caps; }
  files.forEach(function (f) {
    var j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
    if (Array.isArray(j.classes)) {
      caps.push({ label: (j.route || f) + (j.state && j.state !== 'default' ? ':' + j.state : ''), classes: j.classes });
    } else if (j && typeof j === 'object') {
      Object.keys(j).forEach(function (k) {
        var v = j[k];
        if (v && Array.isArray(v.classes)) caps.push({ label: k, classes: v.classes });
      });
    }
  });
  return caps;
}

function emptyOut(reason) {
  fs.writeFileSync(OUT_JSON, JSON.stringify({ tool: 'ui-runtime', generatedAt: new Date().toISOString().slice(0, 10),
    summary: { captures: 0, note: reason }, findings: [] }, null, 2) + '\n');
  console.log('ui-runtime-audit: ' + reason);
  console.log('  capture first: open the app ?audit=2, drive routes/states via Playwright,');
  console.log('  captureInventory(state) → drop JSON into ' + path.relative(process.cwd(), CAPTURES_DIR));
}

var captures = loadCaptures(CAPTURES_DIR);
if (!captures.length) { emptyOut('no ?audit=2 captures found (no-op)'); process.exit(0); }

/* static baseline — live lean scan */
var s = scan();
var enumSet = enumeratedBlocks(s);
var compKeys = Object.keys(enumSet).sort();

/* rendered → component block-roots, with which captures each was seen in */
var renderedBlocks = {};   // blockRoot → [labels]
captures.forEach(function (cap) {
  var seenBlocks = {};
  cap.classes.filter(ours).forEach(function (c) { seenBlocks[blockRoot(c, s.defined)] = true; });
  Object.keys(seenBlocks).forEach(function (bk) { (renderedBlocks[bk] || (renderedBlocks[bk] = [])).push(cap.label); });
});
var renderedBlockKeys = Object.keys(renderedBlocks);

var blind = renderedBlockKeys.filter(function (bk) { return !enumSet[bk]; }).sort();           // rendered, not enumerated
var validated = compKeys.filter(function (k) { return renderedBlocks[k]; }).sort();             // enumerated AND rendered
var gated = compKeys.filter(function (k) { return !renderedBlocks[k]; }).sort();                // enumerated, not rendered

var findings = [];
blind.forEach(function (bk) {
  findings.push({ kind: 'rendered_not_enumerated', severity: 'high', component: bk,
    seen_in: renderedBlocks[bk], detail: 'rendered in the live DOM but absent from the static CSS enumeration — a completeness hole' });
});
gated.forEach(function (k) {
  findings.push({ kind: 'enumerated_not_rendered', severity: 'low', component: k,
    detail: 'enumerated in source but not seen in any captured state — gated (drive deeper) or dead candidate' });
});

var summary = {
  captures: captures.length,
  static_components: compKeys.length,
  validated: validated.length,
  coverage_pct: Math.round(100 * validated.length / (compKeys.length || 1)),
  rendered_not_enumerated: blind.length,
  enumerated_not_rendered: gated.length,
};
var stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT_JSON, JSON.stringify({ tool: 'ui-runtime', generatedAt: stamp, summary: summary, findings: findings }, null, 2) + '\n');
fs.writeFileSync(OUT_HTML, renderHtml(summary, findings, captures));

console.log('ui-runtime-audit  (?audit=2 live DOM × static rp-* enumeration)');
console.log('──────────────────────────────────────────────────────────');
console.log('  captures ingested:        ' + summary.captures + '  (' + captures.map(function (c) { return c.label; }).join(', ') + ')');
console.log('  static components:        ' + summary.static_components);
console.log('  runtime-validated:        ' + summary.validated + '  (' + summary.coverage_pct + '%)  ← ratchets up with more driven states');
console.log('  rendered-NOT-enumerated:  ' + summary.rendered_not_enumerated + (blind.length ? '  ← FILE: enumeration completeness hole' : '  ✓ none — enumeration complete vs rendered'));
console.log('  enumerated-NOT-rendered:  ' + summary.enumerated_not_rendered + '  (gated/dead candidates — advisory)');
if (blind.length) { console.log('\n  blind spots:'); blind.slice(0, 20).forEach(function (b) { console.log('    ' + b + '  (seen in ' + renderedBlocks[b].join(',') + ')'); }); }
console.log('\n  report: ' + path.relative(process.cwd(), OUT_HTML));
process.exit(0);   // advisory tool; the static ui-doc-audit owns the hard coverage gate

function esc(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function renderHtml(sum, finds, caps) {
  var rows = finds.map(function (f) {
    return '<tr class="' + f.kind + '"><td>' + esc(f.severity) + '</td><td><code>' + esc(f.component) + '</code></td><td>' +
      esc(f.kind) + '</td><td>' + esc((f.seen_in || []).join(', ')) + '</td><td>' + esc(f.detail) + '</td></tr>';
  }).join('');
  return '<!doctype html><meta charset=utf8><title>ui-runtime-audit</title>' +
    '<style>body{font:14px/1.5 system-ui;margin:2rem;max-width:78rem}table{border-collapse:collapse;width:100%}' +
    'td,th{border:1px solid #ccc;padding:.3rem .5rem;text-align:left;vertical-align:top}code{background:#f4f4f4;padding:0 .2rem}' +
    '.rendered_not_enumerated td:first-child{color:#b00;font-weight:700}.enumerated_not_rendered td:first-child{color:#888}</style>' +
    '<h1>ui-runtime-audit — ?audit=2 live DOM × static rp-* enumeration</h1>' +
    '<p>' + esc(JSON.stringify(sum)) + '</p>' +
    '<p>captures: ' + caps.map(function (c) { return esc(c.label); }).join(', ') + '</p>' +
    '<table><tr><th>sev</th><th>component</th><th>kind</th><th>seen in</th><th>detail</th></tr>' + rows + '</table>';
}
