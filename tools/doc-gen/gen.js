#!/usr/bin/env node
/* Purpose: doc-gen — generate the MECHANICAL doc content from single sources of truth.
 * Doc: docs/internal/code/tools/doc-gen/gen.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash doc-gen — the code→doc generator (schema extractor, phase 1).

   The fix for doc duplication + drift (e.g. the schema TRIPLICATION: docs/db/schema.md
   54KB + docs/internal/specs/object-metadata/*.md ×14 + docs/objects/*). Those hand-
   describe things that already have ONE source of truth. doc-gen derives the mechanical
   "what" from that source and writes it into a GENERATED REGION of the canonical doc:

     <!-- doc-gen:schema:users START — generated from live DB; do not hand-edit -->
     ...generated table...
     <!-- doc-gen:schema:users END -->

   The tool only ever rewrites BETWEEN the markers. Human "why / how-it-works" prose around
   them is never touched. Re-run on a schema change → the table updates, the prose survives.
   You cannot duplicate or drift a schema that's generated from the one source.

   ── phase 1: SCHEMA ─────────────────────────────────────────────────────────
   Source = the LIVE DB (information_schema + pg_catalog) — the exact applied state of all
   migrations (static replay of init.sql + 9 ALTERs incl. CHECK/rename changes is brittle;
   the DB is the truth). Read-only introspection via the system `psql` (no Node DB dep —
   same posture as the shell audits). DSN from backend/.env (auto-detects :5432→:5433).

   Emits: per-object schema markdown (generated-region) + schema.contract.json (the parity
   baseline the dedup/parity audits will diff against — "one extractor, every consumer").

   Routes are handled by tools/lib/rust-routes.js (the api-doc lane) — doc-gen CONSUMES that,
   never re-implements it. Components (frontend trees) are a later phase.

   Usage:
     node tools/doc-gen/gen.js --schema [<table>]   # one table, or all (default)
     node tools/doc-gen/gen.js --schema --out <dir> # override output dir
   Output dir defaults to tools/doc-gen/out/schema/ (proof home; the rebuild wires the
   generated regions into the canonical per-object docs once the doc tree is rebuilt).
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..');
var SCHEMAS = ['public', 'audit'];

/* ── DSN resolution (backend/.env, auto-detect the live port) ─────────────── */
function readDsn() {
  var envPath = path.join(ROOT, 'backend', '.env');
  var txt = '';
  try { txt = fs.readFileSync(envPath, 'utf8'); } catch (e) {
    die('cannot read ' + envPath + ' (need DATABASE_URL)');
  }
  var m = txt.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
  if (!m) die('no DATABASE_URL in backend/.env');
  var dsn = m[1].replace(/^["']|["']$/g, '');
  // The live cluster has been observed on :5433 while .env sometimes says :5432.
  // Try the declared DSN; fall back to the swapped port if it doesn't connect.
  if (canConnect(dsn)) return dsn;
  var alt = dsn.indexOf(':5432') >= 0 ? dsn.replace(':5432', ':5433')
          : dsn.indexOf(':5433') >= 0 ? dsn.replace(':5433', ':5432') : null;
  if (alt && canConnect(alt)) return alt;
  die('cannot connect to the DB via DATABASE_URL (tried ' + redact(dsn) + (alt ? ' and ' + redact(alt) : '') + ')');
}
function redact(dsn) { return dsn.replace(/:\/\/[^@]*@/, '://***@'); }
function canConnect(dsn) {
  try { cp.execFileSync('psql', [dsn, '-tAc', 'select 1'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch (e) { return false; }
}

/* ── psql JSON query ──────────────────────────────────────────────────────── */
function q(dsn, sql) {
  var out = cp.execFileSync('psql', [dsn, '-tAc', 'SELECT coalesce(json_agg(t), \'[]\') FROM (' + sql + ') t'],
                            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim() || '[]');
}

/* ── introspection (all base tables in the target schemas, in 5 round-trips) ─ */
function introspect(dsn) {
  var inList = SCHEMAS.map(function (s) { return "'" + s + "'"; }).join(',');
  var tables = q(dsn,
    "SELECT table_schema, table_name, table_type FROM information_schema.tables " +
    "WHERE table_schema IN (" + inList + ") AND table_type IN ('BASE TABLE','VIEW') " +
    "AND table_name NOT LIKE '\\_%' ORDER BY table_schema, table_name");  // exclude _sqlx_migrations etc.
  var cols = q(dsn,
    "SELECT table_schema, table_name, column_name, ordinal_position, data_type, is_nullable, column_default " +
    "FROM information_schema.columns WHERE table_schema IN (" + inList + ") ORDER BY table_schema, table_name, ordinal_position");
  var cons = q(dsn,
    "SELECT n.nspname AS table_schema, rel.relname AS table_name, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def " +
    "FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace " +
    "WHERE n.nspname IN (" + inList + ") AND con.contype IN ('p','f','c','u') ORDER BY n.nspname, rel.relname, con.contype, con.conname");
  var idx = q(dsn,
    "SELECT schemaname AS table_schema, tablename AS table_name, indexname, indexdef " +
    "FROM pg_indexes WHERE schemaname IN (" + inList + ") ORDER BY schemaname, tablename, indexname");
  var trg = q(dsn,
    "SELECT n.nspname AS table_schema, rel.relname AS table_name, tg.tgname, pg_get_triggerdef(tg.oid) AS def " +
    "FROM pg_trigger tg JOIN pg_class rel ON rel.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=rel.relnamespace " +
    "WHERE n.nspname IN (" + inList + ") AND NOT tg.tgisinternal ORDER BY n.nspname, rel.relname, tg.tgname");

  var byKey = {};
  function bucket(schema, table) {
    var k = schema + '.' + table;
    if (!byKey[k]) byKey[k] = { schema: schema, table: table, columns: [], pk: null, fks: [], checks: [], uniques: [], indexes: [], triggers: [] };
    return byKey[k];
  }
  tables.forEach(function (t) { var b = bucket(t.table_schema, t.table_name); b.real = true; b.kind = t.table_type; });
  cols.forEach(function (c) {
    bucket(c.table_schema, c.table_name).columns.push({
      name: c.column_name, ordinal: c.ordinal_position, type: c.data_type,
      nullable: c.is_nullable === 'YES', default: c.column_default || null,
    });
  });
  cons.forEach(function (c) {
    var b = bucket(c.table_schema, c.table_name);
    if (c.contype === 'p') b.pk = c.def;
    else if (c.contype === 'f') b.fks.push({ name: c.conname, def: c.def });
    else if (c.contype === 'c') b.checks.push({ name: c.conname, def: c.def });
    else if (c.contype === 'u') b.uniques.push({ name: c.conname, def: c.def });
  });
  idx.forEach(function (i) { bucket(i.table_schema, i.table_name).indexes.push({ name: i.indexname, def: i.indexdef }); });
  trg.forEach(function (t) { bucket(t.table_schema, t.table_name).triggers.push({ name: t.tgname, def: t.def }); });
  return byKey;
}

/* ── markdown formatter ───────────────────────────────────────────────────── */
function esc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }
function fmtSchema(b, stamp) {
  var L = [];
  L.push('**' + (b.kind === 'VIEW' ? 'View' : 'Table') + ' `' + b.schema + '.' + b.table + '`** — generated ' + stamp + ' from the live schema (applied migrations).');
  L.push('');
  L.push('| # | column | type | null | default |');
  L.push('|---|--------|------|------|---------|');
  b.columns.forEach(function (c) {
    L.push('| ' + c.ordinal + ' | `' + esc(c.name) + '` | ' + esc(c.type) + ' | ' + (c.nullable ? 'YES' : 'NO') + ' | ' + (c.default ? '`' + esc(c.default) + '`' : '') + ' |');
  });
  L.push('');
  L.push('- **Primary key:** ' + (b.pk ? '`' + b.pk + '`' : '_(none)_'));
  if (b.fks.length)     L.push('- **Foreign keys:**\n' + b.fks.map(function (f) { return '    - `' + f.name + '` — ' + f.def; }).join('\n'));
  if (b.checks.length)  L.push('- **Checks:**\n' + b.checks.map(function (c) { return '    - `' + c.name + '` — ' + c.def; }).join('\n'));
  if (b.uniques.length) L.push('- **Unique:**\n' + b.uniques.map(function (u) { return '    - `' + u.name + '` — ' + u.def; }).join('\n'));
  if (b.indexes.length) L.push('- **Indexes:**\n' + b.indexes.map(function (i) { return '    - `' + i.def + '`'; }).join('\n'));
  L.push('- **Triggers:** ' + (b.triggers.length ? '\n' + b.triggers.map(function (t) { return '    - `' + t.name + '` — ' + t.def; }).join('\n') : '_(none)_'));
  return L.join('\n');
}

/* ── generated-region splice (the anti-clobber machinery) ─────────────────── */
function regionMarkers(key) {
  return {
    start: '<!-- doc-gen:' + key + ' START — generated from the live DB; do not hand-edit -->',
    end:   '<!-- doc-gen:' + key + ' END -->',
  };
}
/* Replace the content between START/END markers with `body`, preserving everything
   else (human prose). If the region is absent, append a fresh one. Idempotent. */
function spliceRegion(docText, key, body) {
  var mk = regionMarkers(key);
  var si = docText.indexOf(mk.start);
  if (si >= 0) {
    var afterStart = si + mk.start.length;
    var ei = docText.indexOf(mk.end, afterStart);
    if (ei >= 0) {
      return docText.slice(0, afterStart) + '\n' + body + '\n' + docText.slice(ei);
    }
  }
  var block = '\n' + mk.start + '\n' + body + '\n' + mk.end + '\n';
  return (docText.replace(/\s*$/, '') + '\n' + block);
}

/* ── per-object doc target (create-if-missing skeleton w/ a human prose slot) ─ */
function ensureDoc(outDir, b, key) {
  var file = path.join(outDir, b.schema + '.' + b.table + '.md');
  try { return { file: file, text: fs.readFileSync(file, 'utf8') }; }
  catch (e) {
    var mk = regionMarkers(key);
    var text = '# `' + b.schema + '.' + b.table + '`\n\n' +
      '## Schema\n\n' + mk.start + '\n' + mk.end + '\n\n' +
      '## Notes (human — why / how-it-works / business-logic)\n\n' +
      '_TODO: human prose. The Schema block above is generated from the live DB; change the DB + re-run doc-gen — never hand-edit it._\n';
    return { file: file, text: text };
  }
}

function die(msg) { console.error('doc-gen: ' + msg); process.exit(2); }

/* ── main ─────────────────────────────────────────────────────────────────── */
function main() {
  var args = process.argv.slice(2);
  if (args.indexOf('--schema') < 0) die('usage: node tools/doc-gen/gen.js --schema [<table>] [--out <dir>]');
  var only = null;
  var outDir = path.join(__dirname, 'out', 'schema');
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--out') { outDir = path.resolve(args[++i]); }
    else if (args[i] !== '--schema' && args[i].charAt(0) !== '-') { only = args[i]; }
  }
  fs.mkdirSync(outDir, { recursive: true });

  var dsn = readDsn();
  var stamp = new Date().toISOString().slice(0, 10);
  var byKey = introspect(dsn);

  var keys = Object.keys(byKey).sort();
  if (only) keys = keys.filter(function (k) { return byKey[k].table === only || k === only; });
  else keys = keys.filter(function (k) { return byKey[k].real; });  // real tables/views only (not view-columns leaked via the columns query)
  if (!keys.length) die('no table matched ' + (only || '(all)'));

  var contract = {};
  var written = [];
  keys.forEach(function (k) {
    var b = byKey[k];
    var key = 'schema:' + b.table;
    var body = fmtSchema(b, stamp);
    var doc = ensureDoc(outDir, b, key);
    var next = spliceRegion(doc.text, key, body);
    fs.writeFileSync(doc.file, next);
    written.push(path.relative(ROOT, doc.file));
    contract[b.schema + '.' + b.table] = {
      columns: b.columns, pk: b.pk, fks: b.fks, checks: b.checks, uniques: b.uniques,
      indexes: b.indexes.map(function (x) { return x.def; }), triggers: b.triggers.map(function (x) { return x.name; }),
    };
  });

  var contractPath = path.join(__dirname, 'schema.contract.json');
  fs.writeFileSync(contractPath, JSON.stringify({ generatedAt: stamp, source: 'live-db introspection', tables: contract }, null, 2));

  console.log('doc-gen schema');
  console.log('──────────────');
  console.log('source:   live DB (' + redact(dsn) + ')');
  console.log('tables:   ' + keys.length + (only ? ' (filtered: ' + only + ')' : ''));
  console.log('written:  ' + written.length + ' doc(s) → ' + path.relative(ROOT, outDir) + '/');
  console.log('contract: ' + path.relative(ROOT, contractPath));
  written.slice(0, 30).forEach(function (w) { console.log('  + ' + w); });
}

main();
