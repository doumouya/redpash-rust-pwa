#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash observability audit — slice A of the audit-everything workstream
   ---------------------------------------------------------------------------
   Cross-stack catalog of every observability primitive currently wired
   in the app. Answers: "what does the system record about itself, where,
   how much?" Output drives the workflow / gap analysis at
   docs/internal/observability/investigations.md — what we can trace
   today, what we can't.

   Categories (mirrors the operator's investigation surface):
     B-CORR  backend request correlation     (request_id mint / propagate / log)
     B-LOG   backend structured logging      (tracing macros, sqlx logging)
     B-EVT   backend event capture           (event::record + EventDraft)
     B-REQ   backend request_log             (per-request perf row)
     B-PERF  backend perf instrumentation    (tracing::instrument, spans)
     B-PANIC backend panic handling          (set_hook / catch_unwind)
     F-CORR  frontend request correlation    (X-Request-Id read from response)
     F-ERR   frontend error capture          (window.onerror / unhandledrejection)
     F-EVT   frontend event reports          (reportEvent / api.post(/events))
     F-LOG   frontend ad-hoc logging         (console.* — should mostly migrate to events)
     F-PERF  frontend perf marks             (performance.mark/measure/now)
     X-AUD   audit-run artifacts             (tools/<tool>/audit.json history)

   Each surface declares:
     - kind:    'count'  → numeric tally with per-file breakdown
     - kind:    'check'  → binary present/absent (single config site we expect)
     - kind:    'list'   → enumerate matches with file:line for catalog
   Health: green (configured + healthy count) / yellow (partial) /
           red (absent or zero count where expected).

   This tool does NOT decide what's missing — it inventories what's
   there. The investigations doc reads this output to ask "given these
   surfaces, can I run investigation X end-to-end?" and pinpoints gaps.
   ────────────────────────────────────────────────────────────────────────── */

var fs   = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '../..');
var OUT_JSON = path.join(__dirname, 'audit.json');

/* ── catalog ─────────────────────────────────────────────────────────────── */
var SURFACES = [
  /* ─── BACKEND: request correlation ─────────────────────────────────── */
  { id: 'B-CORR.mint', cat: 'B-CORR', kind: 'check', label: 'request_id middleware (mint + extension + response header)',
    roots: ['backend/crates/api/src'],
    expectFile: 'routes/mod.rs',
    rx: /async fn request_id_mw\b[\s\S]{0,400}?x-request-id/,
    notes: 'X-Request-Id is the spine — every event / log line / FE report should carry it' },
  { id: 'B-CORR.event-tag', cat: 'B-CORR', kind: 'check', label: 'capture_mw tags 4xx/5xx events with request_id',
    roots: ['backend/crates/api/src/routes'],
    expectFile: 'mod.rs',
    rx: /capture_mw[\s\S]{0,4000}?request_id:\s*req_id/,
    notes: 'request_id flows into events on the error path' },
  { id: 'B-CORR.req-log', cat: 'B-CORR', kind: 'check', label: 'request_log table carries request_id column',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /request_id\s*:\s*Option<String>/,
    notes: 'every request row stamps the id — sub-second join key' },

  /* ─── BACKEND: structured logging ──────────────────────────────────── */
  { id: 'B-LOG.tracing-macros', cat: 'B-LOG', kind: 'count', label: 'tracing::{error,warn,info,debug,trace}! call sites',
    roots: ['backend/crates'],
    rx: /\btracing::(error|warn|info|debug|trace)!\s*\(/g,
    notes: 'free-form log lines; should fall back as event::record matures' },
  { id: 'B-LOG.tracing-init', cat: 'B-LOG', kind: 'check', label: 'tracing_subscriber configured (EnvFilter)',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /tracing_subscriber::fmt\(\)[\s\S]{0,400}?EnvFilter/,
    notes: 'RUST_LOG controls verbosity; pre-market dial: bump default to debug' },
  { id: 'B-LOG.sqlx-level', cat: 'B-LOG', kind: 'check', label: 'sqlx log level explicitly set in EnvFilter default',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /sqlx\s*=\s*(?:warn|info|debug|trace)/,
    notes: 'sqlx=warn today; sqlx=info logs every query — verbose-mode candidate' },

  /* ─── BACKEND: events ──────────────────────────────────────────────── */
  { id: 'B-EVT.record-sites', cat: 'B-EVT', kind: 'count', label: 'event::record call sites (lifecycle events)',
    roots: ['backend/crates/api/src'],
    rx: /\b(?:crate::)?event::record\s*\(/g,
    notes: 'cat-3 audit-trail backfill landed 2026-05-24 — these are the persistent observability hooks' },
  { id: 'B-EVT.draft-fields', cat: 'B-EVT', kind: 'check', label: 'EventDraft carries http + correlation fields',
    roots: ['backend/crates/api/src'],
    expectFile: 'event.rs',
    rx: /pub\s+request_id:\s*Option<String>[\s\S]{0,400}?pub\s+http_status:\s*Option/,
    notes: 'every event row can be stitched to its triggering request' },

  /* ─── BACKEND: request_log ─────────────────────────────────────────── */
  { id: 'B-REQ.module', cat: 'B-REQ', kind: 'check', label: 'request_log::record exists (per-request perf row)',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /pub fn record\([\s\S]{0,400}?INSERT INTO request_log/,
    notes: 'every request rows into request_log; powers monitoring page latency views' },
  { id: 'B-REQ.normalize', cat: 'B-REQ', kind: 'check', label: 'request_log normalises :id segments',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /pub fn normalize_route/,
    notes: 'dynamic-id paths aggregate on route key' },

  /* ─── BACKEND: perf instrumentation ────────────────────────────────── */
  { id: 'B-PERF.instrument', cat: 'B-PERF', kind: 'count', label: '#[tracing::instrument] spans on async fns',
    roots: ['backend/crates'],
    rx: /#\[\s*tracing::instrument\b/g,
    notes: 'zero today — gap. spans let sub-handler steps (DB, polars task) attach to request_id' },
  { id: 'B-PERF.elapsed-marks', cat: 'B-PERF', kind: 'count', label: 'Instant::now() + .elapsed() inline timings',
    roots: ['backend/crates/api/src'],
    rx: /Instant::now\(\)[\s\S]{0,2000}?\.elapsed\(\)/g,
    notes: 'ad-hoc latency capture; manual rather than via spans' },

  /* ─── BACKEND: panic ───────────────────────────────────────────────── */
  { id: 'B-PANIC.hook', cat: 'B-PANIC', kind: 'check', label: 'process-level panic hook (records to events)',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /std::panic::set_hook|panic::set_hook/,
    notes: 'absent today — gap. panic on a tokio task is currently invisible to events' },

  /* ─── FRONTEND: request correlation ────────────────────────────────── */
  { id: 'F-CORR.read-id', cat: 'F-CORR', kind: 'check', label: 'frontend reads X-Request-Id from fetch responses',
    roots: ['frontend/scripts'],
    expectFile: 'api.js',
    rx: /(?:get|getResponseHeader|headers\.get)\(['"]x-request-id['"]/i,
    notes: 'absent today — gap. reportEvent accepts request_id but no one populates it from the response' },
  { id: 'F-CORR.attach-event', cat: 'F-CORR', kind: 'check', label: 'reportEvent accepts request_id field',
    roots: ['frontend/scripts'],
    expectFile: 'events.js',
    rx: /\brequest_id\b/,
    notes: 'wire ready; consumer missing — no caller passes the value through' },

  /* ─── FRONTEND: error capture ──────────────────────────────────────── */
  { id: 'F-ERR.onerror', cat: 'F-ERR', kind: 'check', label: 'window.onerror handler installed',
    roots: ['frontend/scripts'],
    rx: /window\.onerror\s*=|window\.addEventListener\s*\(\s*['"]error['"]/,
    notes: 'uncaught JS exceptions → events; absent = invisible client crashes' },
  { id: 'F-ERR.unhandledrejection', cat: 'F-ERR', kind: 'check', label: 'unhandledrejection handler installed',
    roots: ['frontend/scripts'],
    rx: /unhandledrejection/,
    notes: 'promise rejection capture — async failure trail' },

  /* ─── FRONTEND: events ─────────────────────────────────────────────── */
  { id: 'F-EVT.report', cat: 'F-EVT', kind: 'count', label: 'reportEvent call sites',
    roots: ['frontend/scripts'],
    rx: /\breportEvent\s*\(/g,
    notes: 'every code-driven event report. count tracks adoption' },
  { id: 'F-EVT.module', cat: 'F-EVT', kind: 'check', label: 'frontend events.js wrapper exists',
    roots: ['frontend/scripts'],
    expectFile: 'events.js',
    rx: /export function reportEvent/,
    notes: 'the canonical FE → BE event submission path' },

  /* ─── FRONTEND: ad-hoc logging ─────────────────────────────────────── */
  { id: 'F-LOG.console', cat: 'F-LOG', kind: 'count', label: 'console.{log,warn,error,info,debug} call sites',
    roots: ['frontend/scripts'],
    rx: /\bconsole\.(log|warn|error|info|debug)\s*\(/g,
    notes: 'console-only logs are invisible to the operator — candidates for reportEvent migration' },

  /* ─── FRONTEND: performance ────────────────────────────────────────── */
  { id: 'F-PERF.marks', cat: 'F-PERF', kind: 'count', label: 'performance.{mark,measure,now} call sites',
    roots: ['frontend/scripts'],
    rx: /\bperformance\.(mark|measure|now)\s*\(/g,
    notes: 'client-side timing capture — feeds the fetch-elapsed KPIs today' },

  /* ─── AUDIT-RUN HISTORY ────────────────────────────────────────────── */
  { id: 'X-AUD.artifacts', cat: 'X-AUD', kind: 'list', label: 'audit.json artifacts emitted by tools/',
    roots: ['tools'],
    rx: /audit\.json$/,
    notes: 'machine-readable audit history; retention + trending lives here',
    file_match: true },
];

/* ── helpers ─────────────────────────────────────────────────────────────── */
function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name === 'target' || e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') return;
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  });
  return acc;
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return ''; }
}

function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function isSourceFile(rel) {
  return /\.(rs|js|mjs|ts|tsx)$/.test(rel);
}

/* ── scan ─────────────────────────────────────────────────────────────── */
console.log('Scanning ' + ROOT + ' …');

var results = SURFACES.map(function (s) {
  var paths = [];
  s.roots.forEach(function (r) {
    walk(path.join(ROOT, r), paths);
  });

  if (s.kind === 'check') {
    /* check: rx must match SOMEWHERE in expectFile (or any source file
       if expectFile omitted). Records the first matching file:line. */
    var hit = null;
    for (var i = 0; i < paths.length; i++) {
      var rel = path.relative(ROOT, paths[i]).split(path.sep).join('/');
      if (s.expectFile && !rel.endsWith(s.expectFile)) continue;
      if (!s.expectFile && !isSourceFile(rel)) continue;
      var txt = readSafe(paths[i]);
      var m = txt.match(s.rx);
      if (m) {
        hit = { file: rel, line: lineOf(txt, txt.indexOf(m[0])) };
        break;
      }
    }
    return {
      id: s.id, cat: s.cat, kind: s.kind, label: s.label, notes: s.notes,
      present: !!hit, hit: hit
    };
  }

  if (s.kind === 'count') {
    /* count: rx /g across every source file in roots; total + per-file. */
    var total = 0;
    var byFile = {};
    paths.forEach(function (p) {
      var rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (!isSourceFile(rel)) return;
      if (/tools\/(auth-audit|rs-audit|js-audit|css-audit|observability-audit|distincts-audit|html-audit|crossing-audit)\//.test(rel)) return;
      var txt = readSafe(p);
      var n = 0;
      var rx = new RegExp(s.rx.source, s.rx.flags);
      var m;
      while ((m = rx.exec(txt)) !== null) {
        n++;
        if (m.index === rx.lastIndex) rx.lastIndex++;
      }
      if (n > 0) {
        total += n;
        byFile[rel] = (byFile[rel] || 0) + n;
      }
    });
    return {
      id: s.id, cat: s.cat, kind: s.kind, label: s.label, notes: s.notes,
      total: total,
      files: Object.keys(byFile).sort().map(function (f) { return { file: f, n: byFile[f] }; })
    };
  }

  if (s.kind === 'list') {
    /* list: enumerate paths matching rx — for filename-only matches
       (audit.json files, config files, etc). */
    var matches = paths
      .map(function (p) { return path.relative(ROOT, p).split(path.sep).join('/'); })
      .filter(function (rel) { return s.rx.test(rel); })
      .sort();
    return {
      id: s.id, cat: s.cat, kind: s.kind, label: s.label, notes: s.notes,
      total: matches.length, items: matches
    };
  }

  return null;
});

/* ── health classifier ─────────────────────────────────────────────────── */
function health(r) {
  if (r.kind === 'check') return r.present ? 'green' : 'red';
  if (r.kind === 'count') return r.total === 0 ? 'red' : (r.total < 3 ? 'yellow' : 'green');
  if (r.kind === 'list')  return r.total === 0 ? 'red' : 'green';
  return 'unknown';
}
results.forEach(function (r) { r.health = health(r); });

/* ── stats ─────────────────────────────────────────────────────────────── */
var greens  = results.filter(function (r) { return r.health === 'green';  }).length;
var yellows = results.filter(function (r) { return r.health === 'yellow'; }).length;
var reds    = results.filter(function (r) { return r.health === 'red';    }).length;

var data = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  stats: { total: results.length, green: greens, yellow: yellows, red: reds },
  surfaces: results,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2), 'utf8');

/* ── CLI summary ───────────────────────────────────────────────────────── */
function tag(h) { return h === 'green' ? '✓' : h === 'yellow' ? '·' : '⚠'; }

console.log('');
console.log('  surfaces scanned   ' + results.length
  + '   ✓ ' + greens + '   · ' + yellows + '   ⚠ ' + reds);
console.log('');

var lastCat = null;
results.forEach(function (r) {
  if (r.cat !== lastCat) {
    console.log('  ── ' + r.cat + ' ──');
    lastCat = r.cat;
  }
  var prefix = '    ' + tag(r.health) + ' ' + r.label;
  if (r.kind === 'check') {
    console.log(prefix + (r.hit ? '   @ ' + r.hit.file + ':' + r.hit.line : '   (absent)'));
  } else if (r.kind === 'count') {
    var topFiles = r.files.slice(0, 3).map(function (f) { return f.file + ' (' + f.n + ')'; }).join(', ');
    console.log(prefix + '   total=' + r.total
      + (r.files.length ? '   spread=' + r.files.length + ' files'
                         + (topFiles ? '   top: ' + topFiles : '')
                         : ''));
  } else if (r.kind === 'list') {
    console.log(prefix + '   total=' + r.total
      + (r.items.length <= 6 ? '   ' + r.items.join(', ') : '   (' + r.items.length + ' items)'));
  }
});

console.log('');
console.log('  json   -> ' + OUT_JSON);
