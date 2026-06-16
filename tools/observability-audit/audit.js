#!/usr/bin/env node
/* Purpose: cross-stack catalog of observability primitives (LEAN tree).
 * Doc: docs/internal/code/backend/api-routes.md (error airlock + events spine) */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash (lean) observability audit — slice A of the audit-everything work
   ---------------------------------------------------------------------------
   Cross-stack catalog of every observability primitive currently wired in the
   LEAN rebuild. Answers: "what does the system record about itself, where, how
   much?" — it inventories what's there; it does NOT decide what's missing.

   ── Adapted from the prerelease tool to the lean tree ──────────────────────
   The lean cut ships a MINIMAL observability port (see the headers on
   backend/crates/api/src/{event,error}.rs). Several prerelease surfaces were
   NOT ported yet and are EXPECTED to read red here — that is signal, not a
   bug. The catalog keeps those surfaces so the gap is visible and trends as
   the spine lands:
     • request_id middleware + tracing span      (no routes/mod.rs request_id_mw)
     • request_log table + per-request perf row   (no request_log.rs)
     • monitoring page endpoints                  (no monitoring.rs)
     • redact module (redact_chain/backtrace_head)(no redact.rs)
     • cases workstream + case_* event kinds      (cases live on the agent side)
     • frontend reportEvent / X-Request-Id wiring (events.js captures locally,
                                                    the POST endpoint isn't wired)

   Lean path deltas vs prerelease (what changed in the regexes/roots):
     • FE scripts:   frontend/scripts/          → frontend/framework/boot/
     • BE routes:    backend/crates/api/src/routes/{mod,*}.rs (nested module dir)
                     → backend/crates/api/src/*.rs (flat) + main.rs router
     • FE events:    reportEvent()/events.js    → installErrorCapture()/capture()
                     in frontend/framework/boot/events.js (no reportEvent yet)
     • exclude-self: count surfaces skip lean's tools/*-audit/ dirs

   Categories (the operator's investigation surface):
     B-CORR  backend request correlation     (request_id mint / propagate / log)
     B-LOG   backend structured logging      (tracing macros, subscriber, airlock)
     B-EVT   backend event capture           (event::{record,info,warn} → events)
     B-REQ   backend request_log             (per-request perf row — not ported)
     B-PERF  backend perf instrumentation    (tracing::instrument, inline timings)
     B-PANIC backend panic handling          (set_hook / backtrace — not ported)
     B-MON   backend monitoring endpoints    (drill routes — not ported)
     F-ERR   frontend error capture          (window error/unhandledrejection)
     F-EVT   frontend event reports          (capture/installErrorCapture)
     F-LOG   frontend ad-hoc logging         (console.* — migrate to events)
     F-PERF  frontend perf marks             (performance.mark/measure/now)
     F-CORR  frontend request correlation    (X-Request-Id read — not wired)
     X-AUD   audit-run artifacts             (tools/<tool>/audit.json history)

   Each surface declares:
     - kind: 'count'  → numeric tally with per-file breakdown
     - kind: 'check'  → binary present/absent (single config site we expect)
     - kind: 'list'   → enumerate matches with file:line for catalog
   Health: green (configured + healthy count) / yellow (partial) /
           red (absent or zero count where expected — including the
           not-yet-ported lean gaps above).
   ────────────────────────────────────────────────────────────────────────── */

var fs   = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '../..');
var OUT_JSON = path.join(__dirname, 'audit.json');

/* ── catalog ─────────────────────────────────────────────────────────────── */
var SURFACES = [
  /* ─── BACKEND: request correlation ─────────────────────────────────── */
  /* Not ported in lean: routes live flat in api/src/*.rs (no routes/ dir),
     the router is in main.rs, and the request_id middleware / span / request_log
     have not landed. These read red until the observability spine ships. */
  { id: 'B-CORR.mint', cat: 'B-CORR', kind: 'check', label: 'request_id middleware (mint + extension + response header)',
    roots: ['backend/crates/api/src'],
    rx: /async fn request_id_mw\b[\s\S]{0,400}?x-request-id/i,
    notes: 'NOT PORTED — X-Request-Id is the spine; lean middleware.rs holds only the CSRF origin guard today' },
  { id: 'B-CORR.event-tag', cat: 'B-CORR', kind: 'check', label: 'capture_mw tags 4xx/5xx events with request_id',
    roots: ['backend/crates/api/src'],
    rx: /capture_mw[\s\S]{0,4000}?request_id:\s*req_id/,
    notes: 'NOT PORTED — the events Channel B middleware wiring lands with the spine (see error.rs header)' },
  { id: 'B-CORR.req-log', cat: 'B-CORR', kind: 'check', label: 'request_log table carries request_id column',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /request_id\s*:\s*Option<String>/,
    notes: 'NOT PORTED — no request_log.rs in lean yet' },
  { id: 'B-CORR.span', cat: 'B-CORR', kind: 'check', label: 'request_id middleware opens a tracing span with request_id field',
    roots: ['backend/crates/api/src'],
    rx: /tracing::info_span!\s*\(\s*"api"\s*,\s*request_id/,
    notes: 'NOT PORTED — no per-request tracing span; log↔DB pivot (I-2) not yet possible' },

  /* ─── BACKEND: structured logging ──────────────────────────────────── */
  { id: 'B-LOG.tracing-macros', cat: 'B-LOG', kind: 'count', label: 'tracing::{error,warn,info,debug,trace}! call sites',
    roots: ['backend/crates'],
    rx: /\btracing::(error|warn|info|debug|trace)!\s*\(/g,
    notes: 'free-form log lines; should fall back as event::record matures' },
  { id: 'B-LOG.tracing-init', cat: 'B-LOG', kind: 'check', label: 'tracing_subscriber configured',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /tracing_subscriber::fmt\(\)/,
    notes: 'lean inits a JSON fmt subscriber in main.rs; EnvFilter/RUST_LOG dial is a verbose-mode candidate (not wired yet)' },
  { id: 'B-LOG.envfilter', cat: 'B-LOG', kind: 'check', label: 'EnvFilter / RUST_LOG verbosity control',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /EnvFilter/,
    notes: 'NOT PORTED — no RUST_LOG control; subscriber is fixed-level today' },
  { id: 'B-LOG.json-format', cat: 'B-LOG', kind: 'check', label: 'tracing_subscriber emits JSON (flatten_event)',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /\.json\(\)[\s\S]{0,200}?\.flatten_event\s*\(\s*true\s*\)/,
    notes: 'Channel A is machine-queryable — jq can pivot once a shared request_id lands' },
  { id: 'B-LOG.eyre-dep', cat: 'B-LOG', kind: 'check', label: 'eyre dependency declared in api Cargo.toml',
    roots: ['backend/crates/api'],
    expectFile: 'Cargo.toml',
    rx: /\beyre\s*=\s*\{?\s*workspace/,
    notes: 'enables AppError.inner = Option<eyre::Report> airlock + source chain capture' },
  { id: 'B-LOG.airlock-inner', cat: 'B-LOG', kind: 'check', label: 'AppError carries Option<eyre::Report> as airlock payload',
    roots: ['backend/crates/api/src'],
    expectFile: 'error.rs',
    rx: /pub\s+inner\s*:\s*Option<\s*eyre::Report\s*>/,
    notes: 'radioactive payload; never crosses the wire — into_response drops it after logging to Channel A' },
  { id: 'B-LOG.airlock-discipline', cat: 'B-LOG', kind: 'check', label: 'AppError::into_response emits error.chain to Channel A',
    roots: ['backend/crates/api/src'],
    expectFile: 'error.rs',
    rx: /tracing::error!\([\s\S]{0,800}?error\.chain/,
    notes: 'full source chain ({:#}) + error.debug (backtrace if RUST_BACKTRACE set)' },
  { id: 'B-LOG.severity-split', cat: 'B-LOG', kind: 'check', label: 'AppError::into_response splits WARN (4xx) vs ERROR (5xx-with-Report)',
    roots: ['backend/crates/api/src'],
    expectFile: 'error.rs',
    rx: /match\s+&self\.inner\s*\{[\s\S]{0,800}?tracing::error!/,
    notes: 'level decision lives with the error, not the middleware — robust to status-class changes' },

  /* ─── BACKEND: events ──────────────────────────────────────────────── */
  { id: 'B-EVT.record-sites', cat: 'B-EVT', kind: 'count',
    label: 'event::{record,info,warn,error} call sites (lifecycle events)',
    roots: ['backend/crates/api/src'],
    rx: /\b(?:crate::)?event::(?:record|info|warn|error)\s*\(/g,
    notes: 'lean ports the ergonomic builders (event::{info,warn}); event::error + EventDraft land with the spine' },
  { id: 'B-EVT.module', cat: 'B-EVT', kind: 'check', label: 'event::record exists (fire-and-forget, detaches onto a task)',
    roots: ['backend/crates/api/src'],
    expectFile: 'event.rs',
    rx: /pub fn record\([\s\S]{0,400}?INSERT INTO events/,
    notes: 'the canonical BE event submission path; never blocks/fails the observed request' },
  { id: 'B-EVT.draft-fields', cat: 'B-EVT', kind: 'check', label: 'event payload carries http + correlation fields (request_id, http_status)',
    roots: ['backend/crates/api/src'],
    expectFile: 'event.rs',
    rx: /request_id[\s\S]{0,400}?http_status/,
    notes: 'NOT PORTED — lean event::record takes (kind, level, message, user, context); the EventDraft correlation fields land with the spine' },

  /* ─── BACKEND: request_log (NOT PORTED in lean) ────────────────────── */
  { id: 'B-REQ.module', cat: 'B-REQ', kind: 'check', label: 'request_log::record exists (per-request perf row)',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /pub fn record\([\s\S]{0,400}?INSERT INTO request_log/,
    notes: 'NOT PORTED — no request_log.rs; powers the monitoring latency views once it lands' },
  { id: 'B-REQ.normalize', cat: 'B-REQ', kind: 'check', label: 'request_log normalises :id segments',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /pub fn normalize_route/,
    notes: 'NOT PORTED — dynamic-id path aggregation lands with request_log' },
  { id: 'B-REQ.user-session', cat: 'B-REQ', kind: 'check', label: 'request_log::record carries user_redpash_id + session_id',
    roots: ['backend/crates/api/src'],
    expectFile: 'request_log.rs',
    rx: /user_redpash_id:\s*Option<String>[\s\S]{0,200}?session_id:\s*Option<String>/,
    notes: 'NOT PORTED — per-user / per-session investigation columns (I-1 / I-7)' },

  /* ─── BACKEND: perf instrumentation ────────────────────────────────── */
  { id: 'B-PERF.instrument', cat: 'B-PERF', kind: 'count', label: '#[tracing::instrument] spans on async fns',
    roots: ['backend/crates'],
    rx: /#\[\s*tracing::instrument\b/g,
    notes: 'zero today — gap. spans let sub-handler steps (DB, polars task) attach to request_id' },
  { id: 'B-PERF.elapsed-marks', cat: 'B-PERF', kind: 'count', label: 'Instant::now() + .elapsed() inline timings',
    roots: ['backend/crates/api/src'],
    rx: /Instant::now\(\)[\s\S]{0,2000}?\.elapsed\(\)/g,
    notes: 'ad-hoc latency capture (search ms, session TTL); manual rather than via spans' },

  /* ─── BACKEND: panic (NOT PORTED in lean) ──────────────────────────── */
  { id: 'B-PANIC.hook', cat: 'B-PANIC', kind: 'check', label: 'process-level panic hook (records to events)',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /std::panic::set_hook|panic::set_hook/,
    notes: 'NOT PORTED — a panic on a tokio task is currently invisible to events' },
  { id: 'B-PANIC.backtrace', cat: 'B-PANIC', kind: 'check', label: 'panic hook captures Backtrace::force_capture()',
    roots: ['backend/crates/api/src'],
    expectFile: 'main.rs',
    rx: /Backtrace::force_capture\(\)/,
    notes: 'NOT PORTED — force_capture works even when RUST_BACKTRACE is unset; cost only on panic' },

  /* ─── BACKEND: monitoring page endpoints (NOT PORTED in lean) ──────── */
  { id: 'B-MON.request-detail', cat: 'B-MON', kind: 'check', label: 'GET /monitoring/request/:request_id route registered',
    roots: ['backend/crates/api/src'],
    expectFile: 'monitoring.rs',
    rx: /\.route\(\s*"\/request\/:request_id"/,
    notes: 'NOT PORTED — no monitoring.rs; the request-id drill (I-2) lands with the spine' },
  { id: 'B-MON.user-activity', cat: 'B-MON', kind: 'check', label: 'GET /monitoring/users/:user_rid/activity route registered',
    roots: ['backend/crates/api/src'],
    expectFile: 'monitoring.rs',
    rx: /\.route\(\s*"\/users\/:user_rid\/activity"/,
    notes: 'NOT PORTED — per-user investigation feed (I-1 / I-7)' },

  /* ─── FRONTEND: error capture ──────────────────────────────────────── */
  /* Lean FE lives in frontend/framework/boot/. events.js installs the
     window error / unhandledrejection handlers via installErrorCapture(). */
  { id: 'F-ERR.module', cat: 'F-ERR', kind: 'check', label: 'frontend events.js error-capture module exists',
    roots: ['frontend/framework/boot'],
    expectFile: 'events.js',
    rx: /export function installErrorCapture/,
    notes: 'the canonical FE error-capture path; buffers + dedups what the backend structurally cannot see' },
  { id: 'F-ERR.onerror', cat: 'F-ERR', kind: 'check', label: 'window error handler installed',
    roots: ['frontend/framework/boot'],
    rx: /window\.onerror\s*=|window\.addEventListener\s*\(\s*['"]error['"]/,
    notes: 'uncaught JS exceptions → capture(); absent = invisible client crashes' },
  { id: 'F-ERR.unhandledrejection', cat: 'F-ERR', kind: 'check', label: 'unhandledrejection handler installed',
    roots: ['frontend/framework/boot'],
    rx: /unhandledrejection/,
    notes: 'promise rejection capture — async failure trail' },
  { id: 'F-ERR.mount', cat: 'F-ERR', kind: 'check', label: 'captureMountError wired for page-mount failures',
    roots: ['frontend/framework/boot'],
    expectFile: 'events.js',
    rx: /export function captureMountError/,
    notes: 'page-mount failures are captured explicitly (the router/boot path calls this)' },

  /* ─── FRONTEND: events ─────────────────────────────────────────────── */
  { id: 'F-EVT.capture', cat: 'F-EVT', kind: 'count', label: 'capture()/captureMountError() FE event sites',
    roots: ['frontend/framework/boot'],
    rx: /\bcapture(?:MountError)?\s*\(/g,
    notes: 'every code-driven FE event report; count tracks adoption (reportEvent + POST endpoint not wired yet)' },
  { id: 'F-EVT.buffer', cat: 'F-EVT', kind: 'check', label: 'pendingEvents() drain buffer exists',
    roots: ['frontend/framework/boot'],
    expectFile: 'events.js',
    rx: /export function pendingEvents/,
    notes: 'buffered + capped; the drain-to-backend POST lands when the /events endpoint ships' },
  { id: 'F-EVT.post-wired', cat: 'F-EVT', kind: 'check', label: 'FE events drained to backend (POST /events / api.post)',
    roots: ['frontend/framework/boot'],
    rx: /\/events['"]|api\.post\s*\(\s*['"]\/events/,
    notes: 'NOT WIRED — events.js buffers locally; the POST drain lands with the BE /events endpoint (recursion-guard: events.js will use raw fetch)' },

  /* ─── FRONTEND: ad-hoc logging ─────────────────────────────────────── */
  { id: 'F-LOG.console', cat: 'F-LOG', kind: 'count', label: 'console.{log,warn,error,info,debug} call sites',
    roots: ['frontend/framework', 'frontend/apps'],
    rx: /\bconsole\.(log|warn|error|info|debug)\s*\(/g,
    notes: 'console-only logs are invisible to the operator — candidates for FE event migration' },

  /* ─── FRONTEND: performance ────────────────────────────────────────── */
  { id: 'F-PERF.marks', cat: 'F-PERF', kind: 'count', label: 'performance.{mark,measure,now} call sites',
    roots: ['frontend/framework', 'frontend/apps'],
    rx: /\bperformance\.(mark|measure|now)\s*\(/g,
    notes: 'client-side timing capture — feeds the fetch-elapsed KPIs once wired' },

  /* ─── FRONTEND: request correlation (NOT WIRED in lean) ────────────── */
  { id: 'F-CORR.read-id', cat: 'F-CORR', kind: 'check', label: 'frontend reads X-Request-Id from fetch responses',
    roots: ['frontend/framework/boot'],
    expectFile: 'api.js',
    rx: /(?:get|getResponseHeader|headers\.get)\(['"]x-request-id['"]/i,
    notes: 'NOT WIRED — api.js is the one fetch wrapper; it does not yet read X-Request-Id (BE does not mint it either)' },

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
    /* count: rx /g across every source file in roots; total + per-file.
       Skip lean's own audit tools so self-references don't inflate counts. */
    var total = 0;
    var byFile = {};
    paths.forEach(function (p) {
      var rel = path.relative(ROOT, p).split(path.sep).join('/');
      if (!isSourceFile(rel)) return;
      if (/^tools\/[a-z0-9-]*audit\//.test(rel) || /^tools\/(lib|ci-audit|mcp-server)\//.test(rel)) return;
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

/* Exit code = count of red surfaces, so tools/ci-audit/ratchet.mjs can trend
   the observability gap as the spine lands (lean's auto-discovered audit.js
   contract: exit with the violation count, write audit.json next to itself). */
process.exit(reds);
