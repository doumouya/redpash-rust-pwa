#!/usr/bin/env node
/* Purpose: runtime UI divergence — ?audit=2 live-DOM capture vs the static fe-inventory enumeration.
   Doc: docs/internal/code/tools/audit-suite/ui-runtime-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash ui-runtime-audit — the runtime × static divergence check.
   Auto-discovered by tools/audit.sh (tool name: `ui-runtime`).

   The static enumerator tools/lib/fe-inventory.js lists every component that
   EXISTS in the source (CSS+HTML+JS). This tool checks that list against what
   the app ACTUALLY RENDERS — the ?audit=2 captures (snapshot.js captureInventory,
   driven by Playwright). The two-way diff is the value:

     • rendered-not-enumerated → a class the live DOM renders that the static
       scan never saw — a true completeness hole in fe-inventory (this is the
       check that found the __-BEM gap, fixed in 003141e). HARD signal.
     • enumerated-not-rendered → a component in the source not seen in any
       captured state — a gated/dead candidate (deeper interaction needed, or
       removable). ADVISORY (can't prove dead without exhaustive driving).

   BASELINE = live `require('../lib/fe-inventory').inventory()` (NOT the
   gitignored component.contract.json) — the lane owner's call (broadcast
   2026-06-04): the lib is requireable + always-current, so the comparator
   can't drift from the true static enumeration.

   Lanes (broadcast): runtime capture (snapshot.js / ?audit=2 / captures) = this
   lane; the static enumerator/gate/catalog = the fe-inventory / ui-doc-audit /
   doc-gen lane. Shared boundary = this divergence report. It also doubles as
   the per-slice VISUAL-REGRESSION GUARD's structural half during the
   shell-normalization + CSS-dedup campaign.

   Coverage ratchets up as more driven states are captured into captures/.
   Read-only. No deps beyond tools/lib/fe-inventory. Emits audit.json + report.html.

   Capture: open the app `?audit=2`, navigate routes/states via Playwright,
   `captureInventory(state)` → drop JSON into tools/ui-runtime-audit/captures/.
   Usage:  node tools/ui-runtime-audit/audit.js [capturesDir]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');
var fe = require('../lib/fe-inventory');

var CAPTURES_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'captures');
var OUT_JSON = path.join(__dirname, 'audit.json');
var OUT_HTML = path.join(__dirname, 'report.html');

function ours(c) { return /^(rt|rp|ds|ws)-/.test(c); }

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

/* static baseline — live */
var inv = fe.inventory();
var s = fe._scan();
var compKeys = inv.components.map(function (g) { return g.key; });
var compSet = {}; compKeys.forEach(function (k) { compSet[k] = true; });
var enumSet = {}; inv.components.concat(inv.hooks).forEach(function (g) { enumSet[g.key] = true; });

/* rendered → component block-roots, with which captures each was seen in */
var renderedBlocks = {};   // blockRoot → [labels]
captures.forEach(function (cap) {
  var seenBlocks = {};
  cap.classes.filter(ours).forEach(function (c) { seenBlocks[fe.blockRoot(c, s.defined)] = true; });
  Object.keys(seenBlocks).forEach(function (bk) { (renderedBlocks[bk] || (renderedBlocks[bk] = [])).push(cap.label); });
});
var renderedBlockKeys = Object.keys(renderedBlocks);

var blind = renderedBlockKeys.filter(function (bk) { return !enumSet[bk]; }).sort();           // rendered, not enumerated
var validated = compKeys.filter(function (k) { return renderedBlocks[k]; }).sort();             // enumerated AND rendered
var gated = compKeys.filter(function (k) { return !renderedBlocks[k]; }).sort();                // enumerated, not rendered

var findings = [];
blind.forEach(function (bk) {
  findings.push({ kind: 'rendered_not_enumerated', severity: 'high', component: bk,
    seen_in: renderedBlocks[bk], detail: 'rendered in the live DOM but absent from fe-inventory — a static completeness hole' });
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

console.log('ui-runtime-audit  (?audit=2 live DOM × static fe-inventory)');
console.log('──────────────────────────────────────────────────────────');
console.log('  captures ingested:        ' + summary.captures + '  (' + captures.map(function (c) { return c.label; }).join(', ') + ')');
console.log('  static components:        ' + summary.static_components);
console.log('  runtime-validated:        ' + summary.validated + '  (' + summary.coverage_pct + '%)  ← ratchets up with more driven states');
console.log('  rendered-NOT-enumerated:  ' + summary.rendered_not_enumerated + (blind.length ? '  ← FILE: fe-inventory completeness hole' : '  ✓ none — enumeration complete vs rendered'));
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
    '<h1>ui-runtime-audit — ?audit=2 live DOM × static fe-inventory</h1>' +
    '<p>' + esc(JSON.stringify(sum)) + '</p>' +
    '<p>captures: ' + caps.map(function (c) { return esc(c.label); }).join(', ') + '</p>' +
    '<table><tr><th>sev</th><th>component</th><th>kind</th><th>seen in</th><th>detail</th></tr>' + rows + '</table>';
}
