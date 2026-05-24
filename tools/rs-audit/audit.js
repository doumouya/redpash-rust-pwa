#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash Rust — refactoring audit
   ---------------------------------------------------------------------------
   A static scan of backend/. Codifies Gus's manual Rust audit
   (backend/suggestion-rust-factorisation.md) into a repeatable tool — re-run
   it as the refactor lands to watch the mass come down.

   Three views:
     1. Files          — every .rs file: crate, LOC. Flags hotspots (LOC>600;
                         Gus's four-file mass — db.rs, files.rs, steps.rs…).
     2. Repeated lines — a substantial source line recurring 4+ times. The
                         copy-paste surface — Gus's #1 (the `map_err` DB-error
                         ceremony) and #6 (the `resolve_user_rid` line) fall
                         straight out of it. Caveat: framework boilerplate
                         (Axum extractor signatures) recurs by design and
                         shows here too — a candidate list, not a verdict.
     3. Big matches    — `match` blocks over 60 lines. Gus's #9: `steps::apply`
                         is a 646-line `match` written as code, not a table.

   Heuristic, not a parser — regex + brace-counting, like the CSS/JS audits.
   Good enough to point at the work; read the code to confirm a hit.

   Usage:  node audit.js [backendDir]
   Output: ./report.html  +  a console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var SRC_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : '/home/mansa/redpash-app/backend';
var OUT = path.join(__dirname, 'report.html');
var BIG_LOC = 600;     // a file over this LOC is a hotspot
var BIG_MATCH = 60;    // a `match` block over this many lines is flagged
var DUP_MIN = 4;       // a source line recurring >= this many times is a smell

/* ── pattern catalog ─────────────────────────────────────────────────────────
   Named antipatterns + helper-usage markers from the
   docs/internal/archive/rust-dedup-audit-2026-05-24.md audit. Each entry is
   counted across the scan; the report's "Patterns" tab shows current state.

   Statuses:
     extracted — a helper exists; antipattern count should be 0. Non-zero is
                 a REGRESSION — someone re-introduced the old shape.
     declined  — duplication exists but variation is load-bearing; track count
                 to confirm it doesn't grow enough to warrant extraction.
     live      — observability for already-extracted helpers (count = healthy
                 reuse, not antipattern).
   ────────────────────────────────────────────────────────────────────────── */
var PATTERNS = [
  /* ── extracted: count should stay at 0 ─────────────────────────────────── */
  { name: 'sqlx error .map_err chain', status: 'extracted',
    rx: /\.map_err\(\|e\| AppError::internal\("db", e\.to_string\(\)\)\)/g,
    helper: 'From<sqlx::Error> for AppError + `?`',
    saving: 1, notes: 'commit 194ee26 retired 134 sites' },
  { name: 'bare COUNT(*) inline scalar', status: 'extracted',
    rx: /sqlx::query_scalar\("SELECT COUNT\(\*\)::BIGINT FROM [a-zA-Z_.]+"\)/g,
    helper: 'db::count_total(pool, "table")',
    saving: 3, notes: 'commit 21dcfc3 retired 14 sites' },
  { name: 'duplicate paginate() / build_page<T>() definitions', status: 'extracted',
    rx: /^\s*fn (paginate|build_page)\b/gm,
    helper: 'use super::pagination::{paginate, build_page}',
    saving: 12, notes: 'commit 355cde3 — only 1 def per name expected (in pagination.rs)' },

  /* ── live: helper usage — counts here are healthy reuse, not antipattern ─ */
  { name: 'db::count_total usage', status: 'live',
    rx: /\bdb::count_total\(/g,
    helper: '(this is the helper)',
    saving: 0, notes: 'count tracks reuse spread' },
  { name: 'group_count usage', status: 'live',
    rx: /\bgroup_count\(/g,
    helper: '(this is the helper)',
    saving: 0, notes: 'count tracks reuse spread' },
  { name: 'ensure_owner usage', status: 'live',
    rx: /\bensure_owner\(/g,
    helper: '(this is the helper)',
    saving: 0, notes: 'count tracks reuse spread' },
  { name: 'super::pagination::* import', status: 'live',
    rx: /super::pagination::/g,
    helper: '(this is the import path)',
    saving: 0, notes: 'count tracks paginate/build_page reuse' },
  /* hydrate is the canonical "give me the parsed Polars frame" entry —
     pub(super) in routes/files.rs, called from sibling routes::files
     handlers and one cross-module reacher (routes/group.rs). The
     live counter tracks reach. The per-file breakdown in the report
     surfaces cross-module callers — those flip from healthy reuse to
     layer-violation when DataSource ships and Reader::open becomes
     the canonical read path. Until then, group.rs is the only
     legitimate cross-module caller; new ones outside routes::files
     warrant a look. */
  { name: 'hydrate(state, …) usage', status: 'live',
    rx: /\bhydrate\s*\(/g,
    helper: '(canonical data-frame entry — pub(super) in routes/files.rs)',
    saving: 0, notes: 'cross-module callers (outside routes::files) are the interesting signal — group.rs is the only one today' },

  /* ── declined: track growth; if a count crosses ~15-20, revisit ────────── */
  { name: 'optional-filter WHERE idiom ($N::text IS NULL OR …)', status: 'declined',
    rx: /\$\d+::[a-z]+ IS NULL OR\b/g,
    helper: 'builder or macro — only if a 3rd identical-shape surface lands',
    saving: 0, notes: 'audit verdict: variation per handler is load-bearing' },
  { name: 'sparse-PATCH COALESCE update column', status: 'declined',
    rx: /=\s*COALESCE\(\$\d+,\s*\w+\)/g,
    helper: 'sparse_update!() macro — only if 7+ tables share the shape',
    saving: 0, notes: 'audit verdict: column lists vary 2-11 entries' },
  { name: 'row.try_get(_) DTO mapping', status: 'declined',
    rx: /\.try_get\([^)]*\)\.(unwrap_or|ok\(\))/g,
    helper: 'derive macro — adds dep risk + obscures wire shape',
    saving: 0, notes: 'audit verdict: per-DTO variation; keep inline for auditability' }
];

/* ── ACK scanners ────────────────────────────────────────────────────────────
   Lookback-style scans modelled on auth-audit's AUTH-AUDIT-ACK pattern.
   Each scan finds occurrences of a structural construct (e.g. SQL on a
   polymorphic table) and requires a `// <ACK-name>: <intent>` comment
   within `lookback` lines above the match. Unacknowledged occurrences
   are regression candidates. Type-shape correctness lane — distinct
   from the regex PATTERNS above which count tokens, not declared intent.
   ────────────────────────────────────────────────────────────────────────── */
var ACK_SCANS = [
  /* Every `FROM project_files` (case-insensitive) must declare its
     intended file_type scope. project_files is the polymorphic table
     backing the 2-entity object model — any query without a declared
     type intent risks the runbook-0006 class (spec-only rows leaking
     into data-only code paths). Three valid intents:
       type=any        — intentionally polymorphic (rail listing,
                          cascade-delete targets, file_owner lookup)
       type=csv        — data files only (hydrate read path)
       type=<concrete> — single-type filter visible in the SQL
                          (chart / dashboard / mixed). */
  { name: 'project_files query intent (PROJECT-FILES-ACK)',
    status: 'ack',
    rx: /\bFROM\s+project_files\b/gi,
    ackRx: /\/\/\s*PROJECT-FILES-ACK:\s*type\s*=\s*([a-z_-]+)/i,
    lookback: 20,
    helper: 'add `// PROJECT-FILES-ACK: type=any|csv|<concrete>` 1-20 lines above the FROM',
    notes: 'forces type-shape intent at every project_files query site — runbook 0006' },
];

/* crate name from a repo-relative path: crates/<name>/… , else first segment */
function crateOf(rel) {
  var m = rel.match(/(?:^|\/)crates\/([^/]+)\//);
  if (m) return m[1];
  m = rel.match(/^([^/]+)\//);
  return m ? m[1] : '(root)';
}

/* ── file discovery — .rs only, skip target/ and .git/ ──────────────────── */
function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name === 'target' || e.name === '.git') return;
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && /\.rs$/i.test(e.name)) acc.push(full);
  });
  return acc;
}

/* strip block + line comments and double-quoted strings, newline-preserving,
   so stray braces inside them never throw off the match brace-counter.
   (Heuristic: nested block comments and raw strings are not handled — rare.) */
function strip(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
  text = text.replace(/\/\/[^\n]*/g, '');
  text = text.replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  return text;
}

function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/* every `match` block, with its line span (brace-counted on stripped text) */
function findMatches(stripped, rel) {
  var out = [], re = /\bmatch\b/g, m;
  while ((m = re.exec(stripped))) {
    var i = m.index;
    while (i < stripped.length && stripped[i] !== '{' && stripped[i] !== ';') i++;
    if (i >= stripped.length || stripped[i] !== '{') continue;   // not a block
    var depth = 0, j = i;
    for (; j < stripped.length; j++) {
      if (stripped[j] === '{') depth++;
      else if (stripped[j] === '}') { depth--; if (depth === 0) break; }
    }
    var start = lineOf(stripped, m.index), end = lineOf(stripped, j);
    out.push({ file: rel, line: start, span: end - start + 1 });
    re.lastIndex = j;            // skip the body — don't re-scan nested matches
  }
  return out;
}

/* a line worth counting as a copy-paste signal */
function substantial(line) {
  var t = line.trim();
  if (t.length < 14) return false;            // too short to be a real dup
  if (!/[A-Za-z]/.test(t)) return false;       // pure punctuation / braces
  if (/^(use|pub use|mod|pub mod)\b/.test(t)) return false;   // imports aren't smells
  if (/^#\[/.test(t)) return false;            // attributes repeat by design
  return true;
}

/* ── scan ────────────────────────────────────────────────────────────────── */
console.log('Scanning ' + SRC_DIR + ' …');
var diskPaths = walk(SRC_DIR, []).sort();
if (!diskPaths.length) { console.error('No .rs files found.'); process.exit(1); }

var files = [];
var matches = [];
var lineMap = {};      // trimmed line -> { count, files: {rel: n} }

/* per-pattern accumulators: parallel array to PATTERNS, each entry
   { total, files: { rel: count, … } }. Stripped text (no comments /
   strings — see strip()) is scanned for the "code" regex; we keep
   raw scans too because some pattern rx legitimately match inside
   string literals (e.g. the bare-COUNT pattern is literally an SQL
   string). Per-pattern, the rx decides which side to scan. */
var patternHits = PATTERNS.map(function () { return { total: 0, files: {} }; });

/* per-ACK-scan accumulator: { total, byType: { 'any': N, 'csv': M, … },
   unacked: [{ file, line }, …] }. Each scan reads the lookback window
   above every match for the ACK comment + captured type. */
var ackHits = ACK_SCANS.map(function () { return { total: 0, byType: {}, unacked: [] }; });

diskPaths.forEach(function (full) {
  var rel = path.relative(SRC_DIR, full).split(path.sep).join('/');
  var text = fs.readFileSync(full, 'utf8');
  var loc = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
  var crate = crateOf(rel);
  files.push({ rel: rel, crate: crate, loc: loc, big: loc > BIG_LOC });

  var stripped = strip(text);
  findMatches(stripped, rel).forEach(function (mb) { matches.push(mb); });

  text.split('\n').forEach(function (ln) {
    if (!substantial(ln)) return;
    var t = ln.trim();
    var e = lineMap[t] || (lineMap[t] = { count: 0, files: {} });
    e.count++;
    e.files[rel] = (e.files[rel] || 0) + 1;
  });

  /* pattern scan — raw text (some rx match inside SQL string literals
     by design; that's the antipattern's signature). Skip the audit
     tool itself + the dedup-audit doc to avoid self-counting. */
  if (/tools\/rs-audit\//.test(rel) || /rust-dedup-audit/.test(rel)) return;
  PATTERNS.forEach(function (p, i) {
    p.rx.lastIndex = 0;
    var m, n = 0;
    while ((m = p.rx.exec(text)) !== null) { n++; if (m.index === p.rx.lastIndex) p.rx.lastIndex++; }
    if (n > 0) {
      patternHits[i].total += n;
      patternHits[i].files[rel] = (patternHits[i].files[rel] || 0) + n;
    }
  });

  /* ACK scans — lookback-style. For each match, walk back `lookback`
     lines and try to capture the ACK type from a `// <Name>: type=…`
     comment. Unacknowledged matches go into ackHits[i].unacked. */
  var lines = text.split('\n');
  ACK_SCANS.forEach(function (s, i) {
    s.rx.lastIndex = 0;
    var m;
    while ((m = s.rx.exec(text)) !== null) {
      var line = lineOf(text, m.index);                                  // 1-based
      var start = Math.max(0, line - s.lookback - 1);                    // 0-based for slice
      var snippet = lines.slice(start, line).join('\n');
      var am = snippet.match(s.ackRx);
      ackHits[i].total++;
      if (am) {
        var t = am[1].toLowerCase();
        ackHits[i].byType[t] = (ackHits[i].byType[t] || 0) + 1;
      } else {
        ackHits[i].unacked.push({ file: rel, line: line });
      }
      if (m.index === s.rx.lastIndex) s.rx.lastIndex++;
    }
  });
});

var repeats = Object.keys(lineMap)
  .filter(function (t) { return lineMap[t].count >= DUP_MIN; })
  .map(function (t) {
    var e = lineMap[t];
    return {
      line: t, count: e.count,
      files: Object.keys(e.files).sort().map(function (f) {
        return { file: f, n: e.files[f] };
      })
    };
  })
  .sort(function (a, b) { return b.count - a.count || a.line.localeCompare(b.line); });

var bigMatches = matches
  .filter(function (m) { return m.span >= BIG_MATCH; })
  .sort(function (a, b) { return b.span - a.span; });

files.sort(function (a, b) { return b.loc - a.loc; });

/* per-crate rollup */
var crates = {};
files.forEach(function (f) {
  var c = crates[f.crate] || (crates[f.crate] = { crate: f.crate, files: 0, loc: 0 });
  c.files++; c.loc += f.loc;
});
var crateList = Object.keys(crates).map(function (k) { return crates[k]; })
  .sort(function (a, b) { return b.loc - a.loc; });

/* ── stats + payload ─────────────────────────────────────────────────────── */
var totalLoc = files.reduce(function (n, f) { return n + f.loc; }, 0);
var redundantLines = repeats.reduce(function (n, r) { return n + (r.count - 1); }, 0);

/* per-pattern roll-up — joined with the catalog so the report shows
   name/status/helper/saving alongside count + per-file breakdown. */
var patterns = PATTERNS.map(function (p, i) {
  var h = patternHits[i];
  return {
    name: p.name, status: p.status, helper: p.helper, saving: p.saving, notes: p.notes,
    total: h.total,
    files: Object.keys(h.files).sort().map(function (f) { return { file: f, n: h.files[f] }; })
  };
});

/* counts for the headline cards: regressions = extracted patterns
   with non-zero counts; pending = declined patterns whose count
   crossed the revisit threshold. */
var REVISIT_THRESHOLD = 20;
var regressions = patterns.filter(function (p) { return p.status === 'extracted' && p.total > 0; }).length;
var pending     = patterns.filter(function (p) { return p.status === 'declined'  && p.total > REVISIT_THRESHOLD; }).length;

/* ACK scan rollup — sibling array to `patterns`, but with byType +
   unacked instead of files. ackUnacked is the headline regression
   count (sites that need the ACK comment but don't have it). */
var ackScans = ACK_SCANS.map(function (s, i) {
  var h = ackHits[i];
  return {
    name: s.name, status: s.status, helper: s.helper, notes: s.notes,
    total: h.total, byType: h.byType, unacked: h.unacked.slice().sort(function (a, b) {
      return a.file.localeCompare(b.file) || a.line - b.line;
    })
  };
});
var ackUnacked = ackScans.reduce(function (n, s) { return n + s.unacked.length; }, 0);

var data = {
  generatedAt: new Date().toISOString(),
  srcDir: SRC_DIR,
  bigLoc: BIG_LOC, bigMatch: BIG_MATCH, dupMin: DUP_MIN,
  revisitThreshold: REVISIT_THRESHOLD,
  stats: {
    files: files.length,
    loc: totalLoc,
    crates: crateList.length,
    bigFiles: files.filter(function (f) { return f.big; }).length,
    repeatGroups: repeats.length,
    redundantLines: redundantLines,
    bigMatches: bigMatches.length,
    regressions: regressions,
    pendingDeclined: pending,
    ackUnacked: ackUnacked
  },
  crateList: crateList,
  files: files,
  repeats: repeats,
  bigMatches: bigMatches,
  patterns: patterns,
  ackScans: ackScans
};

/* ── HTML report ─────────────────────────────────────────────────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>RedPash Rust audit</title>',
    '<style>' + CSS + '</style>',
    '</head><body>',
    '<header>',
    '  <h1>Rust refactoring audit <span class="muted">· redpash-app</span></h1>',
    '  <div class="sub" id="sub"></div>',
    '</header>',
    '<section class="cards" id="cards"></section>',
    '<nav class="tabs">',
    '  <button class="tab active" data-tab="files">Files</button>',
    '  <button class="tab" data-tab="repeats">Repeated lines</button>',
    '  <button class="tab" data-tab="matches">Big matches</button>',
    '  <button class="tab" data-tab="patterns">Patterns</button>',
    '</nav>',
    '<div class="panel" id="panel-files">',
    '  <div class="toolbar"><input id="q-files" placeholder="Filter files…" autocomplete="off">',
    '    <label class="chk"><input type="checkbox" id="only-big"> only hotspots</label>',
    '    <span class="count" id="count-files"></span></div>',
    '  <table id="t-files"><thead><tr>',
    '    <th data-k="rel">File</th><th data-k="crate">Crate</th>',
    '    <th data-k="loc" class="num">LOC</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-repeats">',
    '  <div class="toolbar"><input id="q-repeats" placeholder="Filter lines…" autocomplete="off">',
    '    <span class="count" id="count-repeats"></span></div>',
    '  <table id="t-repeats"><thead><tr>',
    '    <th data-k="count" class="num">×</th><th data-k="line">Repeated source line</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-matches">',
    '  <div class="toolbar"><span class="count" id="count-matches"></span></div>',
    '  <table id="t-matches"><thead><tr>',
    '    <th data-k="span" class="num">Lines</th><th data-k="file">match block</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-patterns">',
    '  <div class="toolbar">',
    '    <label class="chk"><input type="checkbox" id="only-regressions"> regressions only</label>',
    '    <span class="count" id="count-patterns"></span></div>',
    '  <table id="t-patterns"><thead><tr>',
    '    <th data-k="status">Status</th>',
    '    <th data-k="name">Pattern</th>',
    '    <th data-k="total" class="num">Hits</th>',
    '    <th data-k="helper">Helper / verdict</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<script>var DATA=' + json + ';</script>',
    '<script>' + JS + '</script>',
    '</body></html>'
  ].join('\n');
}

var CSS = [
  ':root{--bg:#0d1117;--panel:#11161f;--panel2:#161c28;--line:#222b3a;',
  '--text:#d6dbe5;--muted:#7c8699;--accent:#b3001b;--accent2:#5b8cff;',
  '--bad:#ff5d6c;--warn:#e0a64b;--ok:#3fb56b}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--text);',
  'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}',
  'header{padding:22px 26px 14px;border-bottom:1px solid var(--line)}',
  'h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}',
  '.muted{color:var(--muted);font-weight:400}',
  '.sub{margin-top:4px;color:var(--muted);font-size:12px}',
  '.cards{display:flex;flex-wrap:wrap;gap:10px;padding:16px 26px}',
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;',
  'padding:10px 14px;min-width:118px}',
  '.card .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}',
  '.card .l{font-size:11px;color:var(--muted);margin-top:2px}',
  '.card.bad .n{color:var(--bad)}.card.warn .n{color:var(--warn)}',
  '.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--line)}',
  '.tab{background:none;border:0;color:var(--muted);padding:10px 14px;cursor:pointer;',
  'font-size:13px;border-bottom:2px solid transparent}',
  '.tab.active{color:var(--text);border-bottom-color:var(--accent)}',
  '.panel{padding:14px 26px 80px}.panel.hidden{display:none}',
  '.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:10px;flex-wrap:wrap}',
  '.toolbar input[type=text],#q-files,#q-repeats{background:var(--panel2);',
  'border:1px solid var(--line);color:var(--text);border-radius:8px;',
  'padding:7px 11px;width:320px;font-size:13px}',
  '.chk{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:5px;',
  'cursor:pointer;user-select:none}',
  '.count{color:var(--muted);font-size:12px;margin-left:auto}',
  'table{width:100%;border-collapse:collapse}',
  'thead th{position:sticky;top:0;background:var(--panel);text-align:left;z-index:2;',
  'font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);',
  'padding:9px 10px;border-bottom:1px solid var(--line);cursor:pointer;',
  'user-select:none;white-space:nowrap}',
  'th.num{text-align:right}th.sorted{color:var(--text)}',
  'th.sorted::after{content:" \\25be";color:var(--accent2)}',
  'th.sorted.asc::after{content:" \\25b4"}',
  'tbody tr{border-bottom:1px solid var(--line)}',
  'tbody tr:hover{background:var(--panel)}',
  'tbody td{padding:7px 10px;vertical-align:top}',
  'td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:#e6ebf2;',
  'word-break:break-all}',
  '.crate{display:inline-block;padding:1px 6px;border-radius:5px;font-size:10px;',
  'font-weight:600;background:#1d2433;color:#9ab4ff}',
  '.pill{display:inline-block;padding:1px 6px;border-radius:6px;font-size:10px;',
  'font-weight:600;margin-left:6px}',
  '.pill.bad{background:rgba(255,93,108,.15);color:var(--bad)}',
  '.pill.warn{background:rgba(224,166,75,.16);color:var(--warn)}',
  '.pill.ok{background:rgba(63,181,107,.16);color:var(--ok)}',
  '.pill.dim{background:#1d2433;color:var(--muted)}',
  '.where{color:var(--muted);font-size:11px;margin-top:3px;',
  'font-family:ui-monospace,Menlo,Consolas,monospace}',
  '.empty{padding:40px;text-align:center;color:var(--muted)}'
].join('');

/* report client script — ES5, no template literals, no ${ */
var JS = [
  "(function(){'use strict';var D=DATA;",
  "function esc(s){return String(s).replace(/[&<>\"]/g,function(c){",
  "return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
  "document.getElementById('sub').textContent=D.srcDir+'  —  generated '+",
  "new Date(D.generatedAt).toLocaleString();",
  "var cards=[['Files',D.stats.files,''],['Lines of code',D.stats.loc,''],",
  "['Crates',D.stats.crates,''],",
  "['Hotspots (>'+D.bigLoc+')',D.stats.bigFiles,'warn'],",
  "['Repeated-line groups',D.stats.repeatGroups,'warn'],",
  "['Redundant lines',D.stats.redundantLines,'bad'],",
  "['Big matches (>'+D.bigMatch+')',D.stats.bigMatches,'bad'],",
  "['Pattern regressions',D.stats.regressions,D.stats.regressions?'bad':''],",
  "['Declined over threshold',D.stats.pendingDeclined,D.stats.pendingDeclined?'warn':'']];",
  "document.getElementById('cards').innerHTML=cards.map(function(c){",
  "return '<div class=\"card '+c[2]+'\"><div class=\"n\">'+c[1]+",
  "'</div><div class=\"l\">'+c[0]+'</div></div>';}).join('');",
  "var tabs=document.querySelectorAll('.tab');",
  "for(var i=0;i<tabs.length;i++)tabs[i].addEventListener('click',function(){",
  "for(var j=0;j<tabs.length;j++)tabs[j].classList.remove('active');",
  "this.classList.add('active');var t=this.getAttribute('data-tab');",
  "['files','repeats','matches','patterns'].forEach(function(p){",
  "document.getElementById('panel-'+p).classList.toggle('hidden',p!==t);});});",
  "function sortRows(rows,st){rows.sort(function(a,b){var x=a[st.k],y=b[st.k],d;",
  "if(typeof x==='string')d=x.localeCompare(y);else d=x-y;return st.asc?d:-d;});}",
  "function wireSort(id,st,re){var ths=document.querySelectorAll('#'+id+' thead th');",
  "function paint(){for(var i=0;i<ths.length;i++){ths[i].classList.remove('sorted','asc');",
  "if(ths[i].getAttribute('data-k')===st.k){ths[i].classList.add('sorted');",
  "if(st.asc)ths[i].classList.add('asc');}}}",
  "for(var i=0;i<ths.length;i++)(function(th){th.addEventListener('click',function(){",
  "var k=th.getAttribute('data-k');if(!k)return;",
  "if(st.k===k)st.asc=!st.asc;else{st.k=k;st.asc=false;}paint();re();});})(ths[i]);",
  "paint();}",
  "var fSort={k:'loc',asc:false};",
  "function renderFiles(){var q=document.getElementById('q-files').value.toLowerCase();",
  "var ob=document.getElementById('only-big').checked;",
  "var rows=D.files.filter(function(r){if(ob&&!r.big)return false;",
  "return !q||r.rel.toLowerCase().indexOf(q)>=0;});sortRows(rows,fSort);",
  "document.getElementById('count-files').textContent=rows.length+' of '+D.files.length;",
  "var tb=document.querySelector('#t-files tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td><span class=\"mono\">'+esc(r.rel)+'</span>'+",
  "(r.big?'<span class=\"pill warn\">hotspot</span>':'')+'</td>'+",
  "'<td><span class=\"crate\">'+esc(r.crate)+'</span></td>'+",
  "'<td class=num>'+r.loc+'</td></tr>';",
  "}).join(''):'<tr><td colspan=3 class=empty>No matches.</td></tr>';}",
  "var rSort={k:'count',asc:false};",
  "function renderRepeats(){var q=document.getElementById('q-repeats').value.toLowerCase();",
  "var rows=D.repeats.filter(function(r){return !q||r.line.toLowerCase().indexOf(q)>=0;});",
  "sortRows(rows,rSort);",
  "document.getElementById('count-repeats').textContent=rows.length+' of '+D.repeats.length;",
  "var tb=document.querySelector('#t-repeats tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "var w=r.files.map(function(f){return esc(f.file)+' ('+f.n+')';}).join('  ·  ');",
  "return '<tr><td class=num>'+r.count+'</td>'+",
  "'<td><span class=\"mono\">'+esc(r.line)+'</span>'+",
  "'<div class=\"where\">'+w+'</div></td></tr>';",
  "}).join(''):'<tr><td colspan=2 class=empty>No line repeats \\u2265 '+D.dupMin+'.</td></tr>';}",
  "var mSort={k:'span',asc:false};",
  "function renderMatches(){var rows=D.bigMatches.slice();sortRows(rows,mSort);",
  "document.getElementById('count-matches').textContent=rows.length+' match blocks > '+",
  "D.bigMatch+' lines';var tb=document.querySelector('#t-matches tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td class=num>'+r.span+'</td>'+",
  "'<td><span class=\"mono\">'+esc(r.file)+':'+r.line+'</span></td></tr>';",
  "}).join(''):'<tr><td colspan=2 class=empty>No match block over '+D.bigMatch+' lines.</td></tr>';}",
  /* Patterns panel — status pill + hit count + helper / verdict. */
  "var pSort={k:'total',asc:false};",
  "function statusPill(s,total){",
  "var cls=s==='extracted'?(total>0?'bad':'ok')",
  ":s==='declined'?(total>D.revisitThreshold?'warn':'dim')",
  ":'dim';",
  "return '<span class=\"pill '+cls+'\">'+s+'</span>';}",
  "function renderPatterns(){",
  "var or=document.getElementById('only-regressions').checked;",
  "var rows=D.patterns.filter(function(r){",
  "return !or||(r.status==='extracted'&&r.total>0);});",
  "sortRows(rows,pSort);",
  "document.getElementById('count-patterns').textContent=rows.length+' of '+D.patterns.length;",
  "var tb=document.querySelector('#t-patterns tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "var where=r.files.length?",
  "'<div class=\"where\">'+r.files.map(function(f){return esc(f.file)+' ('+f.n+')';}).join('  ·  ')+'</div>':'';",
  "return '<tr><td>'+statusPill(r.status,r.total)+'</td>'+",
  "'<td><span class=\"mono\">'+esc(r.name)+'</span>'+",
  "(r.notes?'<div class=\"where\">'+esc(r.notes)+'</div>':'')+where+'</td>'+",
  "'<td class=num>'+r.total+'</td>'+",
  "'<td>'+esc(r.helper)+'</td></tr>';",
  "}).join(''):'<tr><td colspan=4 class=empty>No patterns matched.</td></tr>';}",
  "document.getElementById('q-files').addEventListener('input',renderFiles);",
  "document.getElementById('only-big').addEventListener('change',renderFiles);",
  "document.getElementById('q-repeats').addEventListener('input',renderRepeats);",
  "document.getElementById('only-regressions').addEventListener('change',renderPatterns);",
  "wireSort('t-files',fSort,renderFiles);wireSort('t-repeats',rSort,renderRepeats);",
  "wireSort('t-matches',mSort,renderMatches);wireSort('t-patterns',pSort,renderPatterns);",
  "renderFiles();renderRepeats();renderMatches();renderPatterns();})();"
].join('\n');

/* ── emit ────────────────────────────────────────────────────────────────── */
fs.writeFileSync(OUT, renderHtml(data), 'utf8');

console.log('');
console.log('  files scanned     ' + data.stats.files
  + '   (' + data.stats.loc + ' LOC across ' + data.stats.crates + ' crates)');
crateList.forEach(function (c) {
  console.log('      ' + c.crate + '  —  ' + c.files + ' files, ' + c.loc + ' LOC');
});
console.log('  hotspots          ' + data.stats.bigFiles + '   (> ' + BIG_LOC + ' LOC)');
console.log('  repeated lines    ' + data.stats.repeatGroups
  + ' groups, ' + redundantLines + ' redundant lines (recurring ≥ ' + DUP_MIN + '×)');
console.log('  big matches       ' + data.stats.bigMatches + '   (> ' + BIG_MATCH + ' lines)');
console.log('  patterns          '
  + patterns.filter(function (p) { return p.status === 'extracted'; }).length + ' extracted, '
  + patterns.filter(function (p) { return p.status === 'live'; }).length      + ' live, '
  + patterns.filter(function (p) { return p.status === 'declined'; }).length  + ' declined'
  + (regressions ? '   ⚠ ' + regressions + ' regression(s)' : '')
  + (pending ? '   ⚠ ' + pending + ' declined > ' + REVISIT_THRESHOLD : ''));
ackScans.forEach(function (s) {
  var byType = Object.keys(s.byType).sort()
    .map(function (k) { return s.byType[k] + ' ' + k; }).join(', ');
  console.log('  ' + s.name);
  console.log('    total ' + s.total
    + (byType ? '   acked: ' + byType : '')
    + (s.unacked.length ? '   ⚠ ' + s.unacked.length + ' unacked' : '   ✓'));
  if (s.unacked.length && s.unacked.length <= 20) {
    s.unacked.forEach(function (u) {
      console.log('      · ' + u.file + ':' + u.line);
    });
  } else if (s.unacked.length) {
    s.unacked.slice(0, 10).forEach(function (u) {
      console.log('      · ' + u.file + ':' + u.line);
    });
    console.log('      · … ' + (s.unacked.length - 10) + ' more');
  }
});
if (files[0]) {
  console.log('');
  console.log('  largest files:');
  files.slice(0, 6).forEach(function (f) {
    console.log('    ' + f.rel + '  (' + f.loc + ')');
  });
}
if (bigMatches.length) {
  console.log('');
  console.log('  biggest match blocks:');
  bigMatches.slice(0, 5).forEach(function (m) {
    console.log('    ' + m.file + ':' + m.line + '  (' + m.span + ' lines)');
  });
}
console.log('');
console.log('  report -> ' + OUT);
