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
var feInv = require('../lib/fe-inventory');   // the FE component enumerator (kind=component)

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
function regionMarkers(key, source) {
  return {
    start: '<!-- doc-gen:' + key + ' START — generated from ' + (source || 'the live DB') + '; do not hand-edit -->',
    end:   '<!-- doc-gen:' + key + ' END -->',
  };
}
/* Replace the content between START/END markers with `body`, preserving everything
   else (human prose). If the region is absent, append a fresh one. Idempotent. */
function spliceRegion(docText, key, body) {
  // Match the START marker by its source-INDEPENDENT prefix (the source note after
  // "START —" varies by kind: "the live DB" vs "the frontend source"). Matching the
  // full line would miss a region written with a different source and wrongly append
  // a duplicate. We replace everything between the start line's closing `-->` and END.
  var startPrefix = '<!-- doc-gen:' + key + ' START';
  var endMarker = '<!-- doc-gen:' + key + ' END -->';
  var si = docText.indexOf(startPrefix);
  if (si >= 0) {
    var startClose = docText.indexOf('-->', si);
    if (startClose >= 0) {
      var afterStart = startClose + 3;
      var ei = docText.indexOf(endMarker, afterStart);
      if (ei >= 0) return docText.slice(0, afterStart) + '\n' + body + '\n' + docText.slice(ei);
    }
  }
  var mk = regionMarkers(key);
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

/* ── kind=schema ──────────────────────────────────────────────────────────── */
function genSchema(args) {
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

/* ── kind=component (the flat catalog INDEX — full list + dedup flags) ──────── */
function fmtComponentIndex(a, stamp) {
  // per-component flags: which classes are divergent / participate in a parallel cluster
  var divClasses = {}; a.divergences.forEach(function (d) { divClasses[d.cls] = d.contexts.length; });
  var parSuffix = {}; a.parallels.forEach(function (p) { parSuffix[p.suffix] = p; });
  function suffixOf(cls) { var i = cls.lastIndexOf('-'); return i >= 0 ? cls.slice(i + 1) : cls; }

  var L = [];
  L.push('Generated ' + stamp + ' from the frontend source (' + a.counts.css + ' css, ' + a.counts.html
    + ' html, ' + a.counts.js + ' js) — the complete, code-enumerated component list.');
  L.push('');
  L.push('- **' + a.counts.components + '** styled components (the catalog denominator)');
  L.push('- **' + a.counts.hooks + '** dynamic hooks (un-styled JS-injected handles — not components)');
  L.push('- **' + a.divergences.length + '** divergences · **' + a.parallels.length + '** parallel-class clusters (the dedup worklist)');
  L.push('');

  // dedup worklist first (most actionable for the framework convergence)
  L.push('### Parallel-class clusters — compose into one atom (`-suffix` shared across blocks)');
  L.push('');
  L.push('| -suffix | blocks | classes | members |');
  L.push('|---------|-------:|--------:|---------|');
  a.parallels.forEach(function (p) {
    var m = p.members.slice(0, 8).map(function (c) { return '`' + c + '`'; }).join(', ') + (p.members.length > 8 ? ' …' : '');
    L.push('| `-' + p.suffix + '` | ' + p.blocks + ' | ' + p.count + ' | ' + m + ' |');
  });
  L.push('');
  L.push('### Divergences — same class, ≥2 ancestor contexts (unify behavior)');
  L.push('');
  L.push('| class | contexts |');
  L.push('|-------|----------|');
  a.divergences.forEach(function (d) {
    L.push('| `.' + d.cls + '` | ' + d.contexts.map(function (c) { return '`' + c + '`'; }).join(' · ') + ' |');
  });
  L.push('');

  // the full flat inventory
  L.push('### Components (' + a.counts.components + ') — flat / maximal grain');
  L.push('');
  L.push('| component | cls | source | rendered by | flags |');
  L.push('|-----------|----:|--------|-------------|-------|');
  a.components.forEach(function (g) {
    var flags = [];
    var dv = g.classes.filter(function (c) { return divClasses[c]; });
    if (dv.length) flags.push('⚠ div×' + dv.length);
    var sufs = {};
    g.classes.forEach(function (c) { var s = suffixOf(c); if (parSuffix[s]) sufs[s] = true; });
    Object.keys(sufs).sort().forEach(function (s) { flags.push('`-' + s + '`†'); });
    var src = g.jsRendered ? 'css+js' : 'css';
    var by = g.renderFns.slice(0, 3).join(', ') + (g.renderFns.length > 3 ? ' …' : '');
    L.push('| `' + g.key + '` | ' + g.classes.length + ' | ' + src + ' | ' + esc(by) + ' | ' + flags.join(' ') + ' |');
  });
  L.push('');
  L.push('_† = participates in a parallel-class cluster · ⚠ = contains a divergent class (see worklists above)._');
  return L.join('\n');
}

function ensureIndexDoc(file, key, source) {
  try { return { file: file, text: fs.readFileSync(file, 'utf8') }; }
  catch (e) {
    var mk = regionMarkers(key, source);
    var text = '# UI Component Catalog — Index\n\n' +
      'The complete, **code-enumerated** list of every UI component — the flat / maximal-granular\n' +
      'view (Em: "lay down the maximal granular view to remove duplicates"). This is the FE-framework\n' +
      'component registry + the dedup instrument. Generated by `tools/doc-gen --components` from the\n' +
      'frontend source; `tools/ui-doc-audit` fails if it drifts. Never hand-edit the generated block.\n\n' +
      '## Catalog\n\n' + mk.start + '\n' + mk.end + '\n\n' +
      '## Notes (human — how to read this / convergence decisions)\n\n' +
      '_TODO: human prose. The catalog block above is generated; change the frontend + re-run doc-gen._\n';
    return { file: file, text: text };
  }
}

function genComponents(args) {
  var outDir = path.join(ROOT, 'docs', 'internal', 'ui', 'catalog');
  for (var i = 0; i < args.length; i++) { if (args[i] === '--out') outDir = path.resolve(args[++i]); }
  fs.mkdirSync(outDir, { recursive: true });

  var stamp = new Date().toISOString().slice(0, 10);
  var a = feInv.analyze();
  var key = 'component:index';
  var source = 'the frontend source (css+html+js)';
  var body = fmtComponentIndex(a, stamp);
  var file = path.join(outDir, 'index.md');
  var doc = ensureIndexDoc(file, key, source);
  fs.writeFileSync(file, spliceRegion(doc.text, key, body));

  var contract = {
    generatedAt: stamp, source: 'frontend source (css+html+js)', counts: a.counts,
    components: a.components.map(function (g) {
      return { key: g.key, classes: g.classes, cssFiles: g.cssFiles, jsFiles: g.jsFiles,
               renderFns: g.renderFns, jsRendered: g.jsRendered };
    }),
    hooks: a.hooks.map(function (g) { return { key: g.key, classes: g.classes, jsFiles: g.jsFiles }; }),
    divergences: a.divergences, parallels: a.parallels,
  };
  var contractPath = path.join(__dirname, 'component.contract.json');
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));

  console.log('doc-gen component');
  console.log('─────────────────');
  console.log('components: ' + a.counts.components + ' · hooks: ' + a.counts.hooks + ' · classes: ' + a.counts.classes);
  console.log('dedup:      ' + a.divergences.length + ' divergences · ' + a.parallels.length + ' parallel clusters');
  console.log('index:      ' + path.relative(ROOT, file));
  console.log('contract:   ' + path.relative(ROOT, contractPath));
}

/* ── kind=code-nav (the survival-layer back-index) ─────────────────────────── */
/* Walk every atomic doc under docs/internal/code/ and emit a grouped, linked
   index into docs/internal/code/_nav.md's generated region. This makes the
   per-file survival docs NAVIGABLE — the fix for "266 atomic docs linked from
   no index". The doc-coverage audit's unindexed check reads THIS file for the
   code/ subtree (so the generator owns the catalog, not a hand-edited redmap). */
function genCodeNav() {
  var codeDir = path.join(ROOT, 'docs', 'internal', 'code');
  var stamp = new Date().toISOString().slice(0, 10);
  var docs = [];
  (function walkDocs(d) {
    var ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      if (e.name === 'node_modules') return;
      var full = path.join(d, e.name);
      if (e.isDirectory()) { walkDocs(full); return; }
      if (!e.name.endsWith('.md')) return;
      if (/^(index|_template|_nav)\.md$/.test(e.name)) return;
      docs.push(path.relative(codeDir, full).replace(/\\/g, '/'));
    });
  })(codeDir);
  docs.sort();

  var byPillar = {};
  docs.forEach(function (r) { var p = r.split('/')[0]; (byPillar[p] = byPillar[p] || []).push(r); });

  var L = [];
  L.push('Generated ' + stamp + ' — every atomic doc under `code/`, the per-file');
  L.push('survival layer (' + docs.length + ' docs). Links are relative to `code/`.');
  L.push('');
  Object.keys(byPillar).sort().forEach(function (pillar) {
    L.push('### ' + pillar + ' (' + byPillar[pillar].length + ')');
    var lastDir = null;
    byPillar[pillar].forEach(function (r) {
      var slash = r.lastIndexOf('/');
      var dir = slash >= 0 ? r.slice(0, slash) : '.';
      if (dir !== lastDir) { L.push(''); L.push('**' + dir + '/**'); lastDir = dir; }
      L.push('- [' + r.slice(slash + 1) + '](' + r + ')');
    });
    L.push('');
  });
  var body = L.join('\n');

  var key = 'code-nav';
  var file = path.join(codeDir, '_nav.md');
  var doc;
  try { doc = { file: file, text: fs.readFileSync(file, 'utf8') }; }
  catch (e) {
    var mk = regionMarkers(key, 'the code/ doc tree');
    doc = { file: file, text:
      '---\ntitle: "code/ — navigation back-index"\nsection: Internal\nlast modified date: ' + stamp + '\n---\n\n' +
      '# `code/` — atomic-doc back-index\n\n' +
      'The generated index of the per-file survival layer (see [index.md](index.md)\n' +
      'for the source→doc mapping rule + how to author one). Do not hand-edit the\n' +
      'generated block — run `node tools/doc-gen/gen.js --code-nav`.\n\n' +
      mk.start + '\n' + mk.end + '\n' };
  }
  fs.writeFileSync(doc.file, spliceRegion(doc.text, key, body));

  console.log('doc-gen code-nav');
  console.log('────────────────');
  console.log('docs indexed: ' + docs.length + ' → ' + path.relative(ROOT, file));
}

/* ── dispatcher ───────────────────────────────────────────────────────────── */
function main() {
  var args = process.argv.slice(2);
  if (args.indexOf('--components') >= 0) return genComponents(args);
  if (args.indexOf('--code-nav') >= 0) return genCodeNav();
  if (args.indexOf('--schema') >= 0) return genSchema(args);
  die('usage: node tools/doc-gen/gen.js --schema [<table>] | --components | --code-nav  [--out <dir>]');
}

main();
