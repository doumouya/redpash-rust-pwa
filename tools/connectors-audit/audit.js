#!/usr/bin/env node
/* Purpose: connector-layer audit — flags connectors that hit the storage layer
 * directly instead of routing through the framework pipeline.
 * Doc: docs/internal/code/tools/audit-suite/connectors-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash connectors-audit — the structural guard for connector-through-framework

   Surfaced from CAS_A4448B94 (2026-06-01): the Kafka loader called
   `db::insert_file` directly, bypassing RBAC (write to any project), the
   `file_upload` audit event, and the org-rule cascade. The fix routes every
   producer through `pipeline::upload_csv`. This audit makes the fix STICKY:
   it fails the suite if any connector reaches for the storage layer again, so
   the next connector (postgres-cdc-rc, s3-avro-rc, …) can't quietly reintroduce
   the bypass.

   Same shape as the other adversarial/structural detectors: turn one bug into a
   class the tooling enforces, not a thing humans have to remember.

   ── what counts as a connector ───────────────────────────────────────────
   A .rs file whose path is under `connectors/` OR whose basename contains
   `loader` / `connector` (kafka_loader.rs today; *_loader.rs / *_connector.rs
   and connector crates tomorrow). Deliberately broad + name-based so a new
   connector is caught the day it lands, with no registry to maintain.

   ── the rule ──────────────────────────────────────────────────────────────
   A connector must NOT call storage-MUTATION db functions directly —
   `db::insert_*`, `db::update_*`, `db::delete_*`, `db::ensure_*` (project/row
   creation). Those carry the policy invariants (RBAC, audit, cascade) that live
   in the framework. A connector is thin transport: consume + decode, then hand
   bytes to `pipeline::upload_csv`. Reads (`db::list_*` / `db::get_*` /
   `db::find_*`) are fine.

     red    — connector calls a db:: mutation directly (the bypass). BUG CLASS.
     green  — connector routes through `pipeline::` and has no db:: mutation.
     yellow — connector does neither (pure consumer / transport-only, or a
              connector that doesn't ingest yet) → read it.

   Framework code that legitimately calls `db::insert_file` (pipeline.rs, the
   upload/join/snapshot route handlers) is NOT a connector by name, so it is not
   scanned — the gate is connector-scoped on purpose.

   ── outputs ──────────────────────────────────────────────────────────────
   stdout summary + audit.html. Exit 1 if any red (fails `sh tools/audit.sh`).

   Usage:  node audit.js
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT     = path.resolve(__dirname, '../..');
var SCAN_DIRS = [
  path.join(ROOT, 'backend/crates'),
  path.join(ROOT, 'connectors'),
];
var OUT_HTML = path.join(__dirname, 'audit.html');

/* db:: storage MUTATIONS — what a connector must not call directly. Reads
   (list_/get_/find_/count_) are fine; these create/change/remove rows. */
var MUTATION_RE = /\bdb::(insert|update|delete|ensure)_[a-z0-9_]+\s*\(/g;
var PIPELINE_RE = /\bpipeline::/;

/* ── helpers (borrowed shape from list-endpoint-rbac-audit) ──────────────── */
function walkRust(dir, acc) {
  acc = acc || [];
  if (!fs.existsSync(dir)) return acc;
  for (var entry of fs.readdirSync(dir, { withFileTypes: true })) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === 'node_modules') continue;
      walkRust(full, acc);
    } else if (entry.isFile() && full.endsWith('.rs')) {
      acc.push(full);
    }
  }
  return acc;
}

/* Position-preserving comment strip so line numbers stay true and a comment
   mentioning `db::insert_file` (like the loader's module doc) is NOT a hit. */
function strip(text) {
  return text
    .replace(/\/\/[^\n]*/g,       function (m) { return ' '.repeat(m.length); })
    .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
}

function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text.charAt(i) === '\n') n++;
  return n;
}

function isConnector(relPath) {
  var base = path.basename(relPath).toLowerCase();
  // The connector-REGISTRY management layer — the HTTP CRUD route
  // (routes/connectors.rs) + its db data-layer (db/connectors.rs), both basename
  // `connectors.rs` — legitimately CRUDs the `connectors` table itself
  // (db::insert_connector is the connector's OWN config row, NOT file-data). It is
  // not a LOADER/transport, so it's out of scope: this guard targets producers
  // that could write FILE data past pipeline::upload_csv (the *_loader.rs files +
  // the connectors/ RC packages).
  if (base === 'connectors.rs') return false;
  return relPath.split(path.sep).includes('connectors')
      || /loader|connector/.test(base);
}

/* ── scan ───────────────────────────────────────────────────────────────── */
function main() {
  var files = [];
  for (var d of SCAN_DIRS) walkRust(d, files);

  var connectors = [];
  for (var f of files) {
    var rel = path.relative(ROOT, f);
    if (!isConnector(rel)) continue;

    var raw      = fs.readFileSync(f, 'utf8');
    var body     = strip(raw);
    var bypasses = [];
    var m;
    MUTATION_RE.lastIndex = 0;
    while ((m = MUTATION_RE.exec(body)) !== null) {
      bypasses.push({ call: m[0].replace(/\s*\($/, ''), line: lineOf(raw, m.index) });
    }
    var routes = PIPELINE_RE.test(body);

    var health = bypasses.length ? 'red' : (routes ? 'green' : 'yellow');
    connectors.push({ file: rel, health: health, bypasses: bypasses, routes: routes });
  }

  connectors.sort(function (a, b) {
    var ORDER = { red: 0, yellow: 1, green: 2 };
    return (ORDER[a.health] - ORDER[b.health]) || a.file.localeCompare(b.file);
  });

  var red    = connectors.filter(function (c) { return c.health === 'red'; });
  var yellow = connectors.filter(function (c) { return c.health === 'yellow'; });
  var green  = connectors.filter(function (c) { return c.health === 'green'; });

  fs.writeFileSync(OUT_HTML, renderHtml(connectors, { red: red.length, yellow: yellow.length, green: green.length }));

  console.log('connectors-audit');
  console.log('────────────────');
  console.log('connectors found: ' + connectors.length);
  console.log('  green   ' + green.length  + '  ✓ routes through pipeline::, no direct db:: mutation');
  console.log('  yellow  ' + yellow.length + '  ⚠ neither mutates nor routes — read it');
  console.log('  red     ' + red.length    + '  🐛 BYPASS — direct db:: mutation in a connector');
  console.log('');
  for (var c of connectors) {
    var tag = c.health === 'red' ? '🐛' : (c.health === 'yellow' ? '⚠ ' : '✓ ');
    console.log('  ' + tag + ' ' + c.file + (c.routes ? '  [pipeline::]' : ''));
    for (var b of c.bypasses) console.log('        ✗ ' + c.file + ':' + b.line + '  ' + b.call + ' — route through pipeline::upload_csv');
  }
  if (red.length) {
    console.log('');
    console.log('Fix: a connector is thin transport. Consume + decode, then call');
    console.log('pipeline::upload_csv(pool, data_dir, caller, false, project, name, bytes, None)');
    console.log('— it owns RBAC + the file_upload audit event + the org cascade.');
  }

  process.exit(red.length ? 1 : 0);
}

/* ── HTML ───────────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function renderHtml(connectors, stats) {
  var rows = connectors.map(function (c) {
    var detail = c.bypasses.length
      ? c.bypasses.map(function (b) { return escHtml(b.call) + ' @ ' + b.line; }).join('; ')
      : (c.routes ? 'routes through pipeline::' : 'no db:: mutation, no pipeline:: — review');
    return '<tr class="r-' + c.health + '"><td>' + escHtml(c.file) + '</td><td>' + c.health + '</td><td>' + detail + '</td></tr>';
  }).join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><title>connectors-audit</title>'
    + '<style>body{font-family:system-ui,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%;font-size:.85rem;font-family:ui-monospace,monospace}'
    + 'th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left}th{background:#f4f4f4}'
    + 'tr.r-red td{background:#fde0e0}tr.r-yellow td{background:#fff6d6}tr.r-green td{background:#e6f7e6}</style></head><body>'
    + '<h1>connectors-audit</h1>'
    + '<p>red (bypass): ' + stats.red + ' &middot; yellow: ' + stats.yellow + ' &middot; green: ' + stats.green + '</p>'
    + '<p><b>red</b> = a connector calls a <code>db::</code> mutation directly, bypassing the framework pipeline '
    + '(RBAC + audit + cascade). Fix: route through <code>pipeline::upload_csv</code>. See CAS_A4448B94.</p>'
    + '<table><thead><tr><th>connector</th><th>health</th><th>detail</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + '</body></html>';
}

main();
