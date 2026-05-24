#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash JS — refactoring audit
   ---------------------------------------------------------------------------
   A static scan of frontend/scripts/. Codifies Woz's manual JS review
   (docs/internal/js-refactor-review.md) into a repeatable tool — re-run it as
   the refactor lands to watch the numbers fall.

   Four views:
     1. Files       — every .js file: LOC, top-level defs, import count, how
                      many modules import it. Flags god-objects (LOC > 800).
     2. Unreachable — modules with no static import path from a root. A
                      strong dead-code candidate list — but "unreachable"
                      is not "dead": anything loaded by a means the static
                      graph cannot see would land here too. Confirm by
                      hand before deleting.
     3. Duplicates  — a top-level symbol name defined in 2+ files (Woz
                      Finding 4: `esc` in 27 files). One row per name.
     4. Patterns    — named antipatterns + helper-usage markers from the
                      docs/internal/architecture/js-refactor-targets.md
                      catalog. Mirrors tools/rs-audit's pattern panel.

   Heuristic, not a parser — regex-based, like the CSS audit. Good enough to
   point at the work; read the code to confirm a hit.

   Usage:  node audit.js [scriptsDir]
   Output: ./report.html  +  a console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var SRC_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : '/home/mansa/redpash-app/frontend/scripts';
var OUT = path.join(__dirname, 'report.html');
var GOD_LOC = 800;

/* ── pattern catalog ─────────────────────────────────────────────────────────
   Named antipatterns + helper-usage markers from the
   docs/internal/architecture/js-refactor-targets.md audit (T1 esc/cssEsc, T2
   list-page, T3 dropdown) + the echarts theme/kpi consolidation. Mirrors the
   rs-audit catalog's status taxonomy:

     extracted — a helper exists; antipattern count should be 0. Non-zero is
                 a REGRESSION — someone re-introduced the old shape.
     declined  — duplication exists but variation is load-bearing; track count
                 to confirm it doesn't grow enough to warrant extraction.
     live      — observability for already-extracted helpers (count = healthy
                 reuse, not antipattern). `skip` is a regex that excludes the
                 helper's own file so we only count callers, not the def.
   ────────────────────────────────────────────────────────────────────────── */
var PATTERNS = [
  /* ── extracted: count should stay at 0 ─────────────────────────────────── */
  { name: 'esc() redefined outside dom.js', status: 'extracted',
    rx: /\bfunction\s+esc\s*\(/g,
    skip: /(^|\/)dom\.js$/,
    helper: 'import { esc } from "/scripts/dom.js"',
    saving: 1, notes: 'commit 57f8541 retired 9 sites' },
  { name: 'cssEsc() redefined outside dom.js', status: 'extracted',
    rx: /\bfunction\s+cssEsc\s*\(/g,
    skip: /(^|\/)dom\.js$/,
    helper: 'import { cssEsc } from "/scripts/dom.js"',
    saving: 1, notes: 'commit 57f8541 retired 3 sites' },
  { name: 'echarts.init(el) without theme arg', status: 'extracted',
    rx: /\becharts\.init\(\s*[A-Za-z_$][\w$.]*\s*\)/g,
    helper: 'echarts.init(el, chartTheme()) — theme registered globally',
    saving: 1, notes: 'every init site must pass a registered theme name' },
  { name: '$$("[data-dd]") legacy sweep', status: 'extracted',
    rx: /\$\$\(\s*['"]\[data-dd\]/g,
    helper: 'bindDropdown() — one delegated handler at boot',
    saving: 2, notes: 'T3 retired per-page sweeps in workspace.js + report.js' },

  /* ── live: helper usage — counts here are healthy reuse, not antipattern ─ */
  { name: 'chartTheme() usage', status: 'live',
    rx: /\bchartTheme\s*\(\s*\)/g,
    skip: /(^|\/)echarts-theme\.js$/,
    helper: '(this is the helper)',
    saving: 0, notes: 'count tracks redpash-mocha/latte theme reuse spread' },
  { name: 'dom.js helper import', status: 'live',
    rx: /\bfrom\s+['"][^'"]*\/dom\.js['"]/g,
    helper: '(this is the import path)',
    saving: 0, notes: 'count tracks esc/cssEsc consolidation adoption' },
  { name: 'echarts-kpi.js helper usage', status: 'live',
    rx: /\bkpi(?:Donut|Pie|Rose|Bar|BarH|Line|Gauge)\s*\(/g,
    skip: /(^|\/)echarts-kpi\.js$/,
    helper: '(these are the helpers)',
    saving: 0, notes: 'count tracks chart helper reuse across pages' },
  { name: 'list-page.js helper import', status: 'live',
    rx: /\bfrom\s+['"][^'"]*\/list-page\.js['"]/g,
    helper: '(this is the import path)',
    saving: 0, notes: 'count tracks T2 list-page extraction adoption' },
  { name: 'bindDropdown() call', status: 'live',
    rx: /\bbindDropdown\s*\(\s*\)/g,
    skip: /(^|\/)dropdown\.js$/,
    helper: '(this is the helper)',
    saving: 0, notes: 'expect 1 call at boot (main.js); growth = per-page resweep regression' },
  { name: 'ensureRegisteredThemes() usage', status: 'live',
    rx: /\bensureRegisteredThemes\s*\(/g,
    skip: /(^|\/)echarts-theme\.js$/,
    helper: '(this is the helper)',
    saving: 0, notes: 'count tracks theme-init adoption (one per echarts host)' },

  /* ── declined: track growth; if a count crosses ~20, revisit ───────────── */
  { name: 'inline-HTML string concat (\'<…\' + esc(…))', status: 'declined',
    rx: /(['"])<[^<>]*?\1\s*\+\s*esc\s*\(/g,
    helper: 'templating helper — only if a 3rd identical-shape surface lands',
    saving: 0, notes: 'audit verdict: per-page HTML varies; revisit if patterns converge' },
  { name: 'setTimeout(…, ms) ad-hoc timing', status: 'declined',
    rx: /\bsetTimeout\s*\(/g,
    helper: 'centralized timing helper — only if a duplicate cluster appears',
    saving: 0, notes: 'audit verdict: ad-hoc delays; tracks ambient timing debt' }
];

/* Roots — modules the shell <script> tags, the router's dynamic import(),
   or the service worker load directly (never via a static `import`).
   Discovered by scanning index.html / main.js / service-worker.js for
   /scripts/*.js literals, so the set is found, not hard-coded. */
function discoverRoots(srcDir, fileSet) {
  var roots = {};
  function mark(rel) { if (fileSet[rel]) roots[rel] = true; }
  [ path.join(srcDir, '..', 'index.html'),
    path.join(srcDir, 'main.js'),
    path.join(srcDir, '..', 'service-worker.js') ].forEach(function (p) {
    var txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
    var m, re = /\/scripts\/([A-Za-z0-9_.\/-]+\.js)/g;
    while ((m = re.exec(txt))) mark(m[1]);
  });
  mark('main.js');
  return roots;
}

/* ── file discovery ──────────────────────────────────────────────────────── */
function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && /\.js$/i.test(e.name)) acc.push(full);
  });
  return acc;
}

/* strip /* *​/ and // comments, newline-preserving so LOC counts stay honest */
function stripComments(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });
  return text.replace(/\/\/[^\n]*/g, '');
}

/* resolve an import specifier to a path relative to SRC_DIR. Handles both
   ./relative AND the /scripts/absolute style this codebase actually uses. */
function resolveSpec(fromRel, spec, fileSet) {
  var p;
  if (spec.charAt(0) === '.') {
    p = path.posix.normalize(path.posix.dirname(fromRel) + '/' + spec);
  } else if (spec.indexOf('/scripts/') === 0) {
    p = spec.slice('/scripts/'.length);
  } else {
    return null;                                    // bare module / non-script
  }
  var cands = [p, p + '.js', p.replace(/\/+$/, '') + '/index.js'];
  for (var i = 0; i < cands.length; i++) {
    if (fileSet[cands[i]]) return cands[i];
  }
  return null;                                      // unresolved — no edge
}

var DEF_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
var IMPORT_RE  = /\bimport\b(?:[^'";]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
var DYNIMP_RE  = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
var REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/* ── scan ────────────────────────────────────────────────────────────────── */
console.log('Scanning ' + SRC_DIR + ' …');
var diskPaths = walk(SRC_DIR, []).sort();
if (!diskPaths.length) { console.error('No .js files found.'); process.exit(1); }

var fileSet = {};
var files = diskPaths.map(function (full) {
  var rel = path.relative(SRC_DIR, full).split(path.sep).join('/');
  fileSet[rel] = true;
  return { rel: rel, full: full };
});

/* per-pattern accumulators — parallel array to PATTERNS, each entry
   { total, files: { rel: count, … } }. Pattern scan runs on the raw
   text (a `setTimeout(` in a comment is still a real timing call to
   record if it ever resurfaces); the strip pass is for LOC + defs. */
var patternHits = PATTERNS.map(function () { return { total: 0, files: {} }; });

files.forEach(function (f) {
  var text = fs.readFileSync(f.full, 'utf8');
  var code = stripComments(text);
  /* LOC = content lines. split('\n') on a trailing-newline file yields a
     phantom '' element — strip one trailing newline first so the count
     matches `wc -l` instead of over-reporting by 1 per file. */
  f.loc = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;

  f.defs = [];
  code.split('\n').forEach(function (ln) {
    var m = DEF_RE.exec(ln);
    if (m) f.defs.push(m[2]);
  });

  var specs = [], m;
  [IMPORT_RE, DYNIMP_RE, REQUIRE_RE].forEach(function (re) {
    re.lastIndex = 0;
    while ((m = re.exec(code))) specs.push(m[1]);
  });
  f.importSpecs = specs;

  /* pattern scan — skip the audit tool itself + per-pattern skip rx so
     the helper's own file doesn't count as usage of itself. */
  if (/(^|\/)tools\/js-audit\//.test(f.rel)) return;
  PATTERNS.forEach(function (p, i) {
    if (p.skip && p.skip.test(f.rel)) return;
    p.rx.lastIndex = 0;
    var pm, n = 0;
    while ((pm = p.rx.exec(text)) !== null) {
      n++;
      if (pm.index === p.rx.lastIndex) p.rx.lastIndex++;     // zero-width guard
    }
    if (n > 0) {
      patternHits[i].total += n;
      patternHits[i].files[f.rel] = (patternHits[i].files[f.rel] || 0) + n;
    }
  });
});

/* forward import graph — resolved internal edges only */
files.forEach(function (f) {
  var seen = {}, out = [];
  f.importSpecs.forEach(function (spec) {
    var t = resolveSpec(f.rel, spec, fileSet);
    if (t && fileSet[t] && t !== f.rel && !seen[t]) { seen[t] = true; out.push(t); }
  });
  f.imports = out;
});
var importedBy = {};
files.forEach(function (f) { importedBy[f.rel] = []; });
files.forEach(function (f) {
  f.imports.forEach(function (t) { importedBy[t].push(f.rel); });
});

/* dead = not reachable from any root through the import graph. Reachability
   (not "zero importers") catches the transitive case — a module imported
   only by an already-dead module is dead too. */
var roots = discoverRoots(SRC_DIR, fileSet);
var byRel = {};
files.forEach(function (f) { byRel[f.rel] = f; });
var reachable = {};
var queue = Object.keys(roots);
while (queue.length) {
  var cur = queue.shift();
  if (reachable[cur]) continue;
  reachable[cur] = true;
  if (byRel[cur]) byRel[cur].imports.forEach(function (t) {
    if (!reachable[t]) queue.push(t);
  });
}
files.forEach(function (f) {
  f.importedBy = importedBy[f.rel];
  f.dead = !reachable[f.rel];
  f.god = f.loc > GOD_LOC;
});

console.log('  roots discovered  ' + Object.keys(roots).length
  + '   (shell <script> tags + router + service worker)');

/* duplicate top-level symbols — one name, 2+ defining files */
var defsByName = {};
files.forEach(function (f) {
  var seen = {};
  f.defs.forEach(function (name) {
    if (seen[name]) return;          // count a name once per file
    seen[name] = true;
    (defsByName[name] || (defsByName[name] = [])).push(f.rel);
  });
});
var dupes = Object.keys(defsByName)
  .filter(function (n) { return defsByName[n].length >= 2; })
  .map(function (n) { return { name: n, count: defsByName[n].length, files: defsByName[n].sort() }; })
  .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });

var dead = files.filter(function (f) { return f.dead; })
  .sort(function (a, b) { return b.loc - a.loc; });

/* ── stats + payload ─────────────────────────────────────────────────────── */
var totalLoc = files.reduce(function (n, f) { return n + f.loc; }, 0);
var deadLoc = dead.reduce(function (n, f) { return n + f.loc; }, 0);

/* per-pattern roll-up — joined with the catalog so the report shows
   name/status/helper/notes alongside hit-count + per-file breakdown. */
var patterns = PATTERNS.map(function (p, i) {
  var h = patternHits[i];
  return {
    name: p.name, status: p.status, helper: p.helper, saving: p.saving, notes: p.notes,
    total: h.total,
    files: Object.keys(h.files).sort().map(function (f) { return { file: f, n: h.files[f] }; })
  };
});

/* headline counts: regressions = extracted patterns with non-zero counts;
   pending = declined patterns past the revisit threshold. */
var REVISIT_THRESHOLD = 20;
var regressions = patterns.filter(function (p) { return p.status === 'extracted' && p.total > 0; }).length;
var pending     = patterns.filter(function (p) { return p.status === 'declined'  && p.total > REVISIT_THRESHOLD; }).length;

var data = {
  generatedAt: new Date().toISOString(),
  srcDir: SRC_DIR,
  godLoc: GOD_LOC,
  revisitThreshold: REVISIT_THRESHOLD,
  stats: {
    files: files.length,
    loc: totalLoc,
    deadModules: dead.length,
    deadLoc: deadLoc,
    dupSymbols: dupes.length,
    godObjects: files.filter(function (f) { return f.god; }).length,
    regressions: regressions,
    pendingDeclined: pending
  },
  files: files.map(function (f) {
    return {
      rel: f.rel, loc: f.loc, defs: f.defs.length,
      imports: f.importSpecs.length, importedBy: f.importedBy.length,
      dead: f.dead, god: f.god
    };
  }).sort(function (a, b) { return b.loc - a.loc; }),
  dead: dead.map(function (f) { return { rel: f.rel, loc: f.loc }; }),
  dupes: dupes,
  patterns: patterns
};

/* ── HTML report ─────────────────────────────────────────────────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>RedPash JS audit</title>',
    '<style>' + CSS + '</style>',
    '</head><body>',
    '<header>',
    '  <h1>JS refactoring audit <span class="muted">· redpash-app</span></h1>',
    '  <div class="sub" id="sub"></div>',
    '</header>',
    '<section class="cards" id="cards"></section>',
    '<nav class="tabs">',
    '  <button class="tab active" data-tab="files">Files</button>',
    '  <button class="tab" data-tab="dead">Unreachable</button>',
    '  <button class="tab" data-tab="dupes">Duplicate symbols</button>',
    '  <button class="tab" data-tab="patterns">Patterns</button>',
    '</nav>',
    '<div class="panel" id="panel-files">',
    '  <div class="toolbar"><input id="q-files" placeholder="Filter files…" autocomplete="off">',
    '    <label class="chk"><input type="checkbox" id="only-god"> only god-objects</label>',
    '    <span class="count" id="count-files"></span></div>',
    '  <table id="t-files"><thead><tr>',
    '    <th data-k="rel">File</th><th data-k="loc" class="num">LOC</th>',
    '    <th data-k="defs" class="num">Top-level defs</th>',
    '    <th data-k="imports" class="num">Imports</th>',
    '    <th data-k="importedBy" class="num">Imported by</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-dead">',
    '  <div class="toolbar"><span class="count" id="count-dead"></span></div>',
    '  <table id="t-dead"><thead><tr>',
    '    <th data-k="rel">Statically unreachable from any root — candidate, confirm</th>',
    '    <th data-k="loc" class="num">LOC</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-dupes">',
    '  <div class="toolbar"><input id="q-dupes" placeholder="Filter symbol names…" autocomplete="off">',
    '    <span class="count" id="count-dupes"></span></div>',
    '  <table id="t-dupes"><thead><tr>',
    '    <th data-k="name">Symbol</th><th data-k="count" class="num">Files</th>',
    '    <th data-k="where">Defined in</th>',
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
  '.toolbar input[type=text],#q-files,#q-dupes{background:var(--panel2);',
  'border:1px solid var(--line);color:var(--text);border-radius:8px;',
  'padding:7px 11px;width:300px;font-size:13px}',
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
  '.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:#e6ebf2}',
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
  "['Unreachable',D.stats.deadModules,'bad'],['Unreachable LOC',D.stats.deadLoc,'bad'],",
  "['Duplicate symbols',D.stats.dupSymbols,'warn'],",
  "['God-objects (>'+D.godLoc+')',D.stats.godObjects,'warn'],",
  "['Pattern regressions',D.stats.regressions,D.stats.regressions?'bad':''],",
  "['Declined over threshold',D.stats.pendingDeclined,D.stats.pendingDeclined?'warn':'']];",
  "document.getElementById('cards').innerHTML=cards.map(function(c){",
  "return '<div class=\"card '+c[2]+'\"><div class=\"n\">'+c[1]+",
  "'</div><div class=\"l\">'+c[0]+'</div></div>';}).join('');",
  "var tabs=document.querySelectorAll('.tab');",
  "for(var i=0;i<tabs.length;i++)tabs[i].addEventListener('click',function(){",
  "for(var j=0;j<tabs.length;j++)tabs[j].classList.remove('active');",
  "this.classList.add('active');var t=this.getAttribute('data-tab');",
  "['files','dead','dupes','patterns'].forEach(function(p){",
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
  "var og=document.getElementById('only-god').checked;",
  "var rows=D.files.filter(function(r){if(og&&!r.god)return false;",
  "return !q||r.rel.toLowerCase().indexOf(q)>=0;});sortRows(rows,fSort);",
  "document.getElementById('count-files').textContent=rows.length+' of '+D.files.length;",
  "var tb=document.querySelector('#t-files tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "var f=(r.dead?'<span class=\"pill bad\">unreached</span>':'')+",
  "(r.god?'<span class=\"pill warn\">god</span>':'');",
  "return '<tr><td><span class=\"mono\">'+esc(r.rel)+'</span>'+f+'</td>'+",
  "'<td class=num>'+r.loc+'</td><td class=num>'+r.defs+'</td>'+",
  "'<td class=num>'+r.imports+'</td><td class=num>'+r.importedBy+'</td></tr>';",
  "}).join(''):'<tr><td colspan=5 class=empty>No matches.</td></tr>';}",
  "var dSort={k:'loc',asc:false};",
  "function renderDead(){var rows=D.dead.slice();sortRows(rows,dSort);",
  "document.getElementById('count-dead').textContent=rows.length+' unreachable · '+",
  "D.stats.deadLoc+' LOC';var tb=document.querySelector('#t-dead tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td><span class=\"mono\">'+esc(r.rel)+'</span></td>'+",
  "'<td class=num>'+r.loc+'</td></tr>';",
  "}).join(''):'<tr><td colspan=2 class=empty>Nothing unreachable.</td></tr>';}",
  "var uSort={k:'count',asc:false};",
  "function renderDupes(){var q=document.getElementById('q-dupes').value.toLowerCase();",
  "var rows=D.dupes.filter(function(r){return !q||r.name.toLowerCase().indexOf(q)>=0;});",
  "sortRows(rows,uSort);",
  "document.getElementById('count-dupes').textContent=rows.length+' of '+D.dupes.length;",
  "var tb=document.querySelector('#t-dupes tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td><span class=\"mono\">'+esc(r.name)+'</span></td>'+",
  "'<td class=num>'+r.count+'</td><td><span class=\"where\">'+",
  "esc(r.files.join('  ·  '))+'</span></td></tr>';",
  "}).join(''):'<tr><td colspan=3 class=empty>No matches.</td></tr>';}",
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
  "document.getElementById('only-god').addEventListener('change',renderFiles);",
  "document.getElementById('q-dupes').addEventListener('input',renderDupes);",
  "document.getElementById('only-regressions').addEventListener('change',renderPatterns);",
  "wireSort('t-files',fSort,renderFiles);wireSort('t-dead',dSort,renderDead);",
  "wireSort('t-dupes',uSort,renderDupes);wireSort('t-patterns',pSort,renderPatterns);",
  "renderFiles();renderDead();renderDupes();renderPatterns();})();"
].join('\n');

/* ── emit ────────────────────────────────────────────────────────────────── */
fs.writeFileSync(OUT, renderHtml(data), 'utf8');

console.log('');
console.log('  files scanned     ' + data.stats.files
  + '   (' + data.stats.loc + ' LOC)');
console.log('  unreachable       ' + data.stats.deadModules
  + '   (' + data.stats.deadLoc + ' LOC, no static path from a root)');
console.log('  duplicate symbols ' + data.stats.dupSymbols
  + '   (one name, 2+ defining files)');
console.log('  god-objects       ' + data.stats.godObjects
  + '   (> ' + GOD_LOC + ' LOC)');
console.log('  patterns          '
  + patterns.filter(function (p) { return p.status === 'extracted'; }).length + ' extracted, '
  + patterns.filter(function (p) { return p.status === 'live'; }).length      + ' live, '
  + patterns.filter(function (p) { return p.status === 'declined'; }).length  + ' declined'
  + (regressions ? '   ⚠ ' + regressions + ' regression(s)' : '')
  + (pending ? '   ⚠ ' + pending + ' declined > ' + REVISIT_THRESHOLD : ''));
if (dead.length) {
  console.log('');
  console.log('  unreachable (candidates — confirm before deleting):');
  dead.forEach(function (f) {
    console.log('    ' + f.rel + '  (' + f.loc + ')');
  });
}
console.log('');
console.log('  patterns:');
patterns.forEach(function (p) {
  var glyph = p.status === 'extracted' ? (p.total > 0 ? '✗' : '✓')
            : p.status === 'declined'  ? (p.total > REVISIT_THRESHOLD ? '⚠' : '•')
            : ' ';
  var pad = String(p.total).padStart(4, ' ');
  console.log('    ' + glyph + ' ' + p.status.padEnd(9) + ' ' + pad + ' hits  ' + p.name);
});
console.log('');
console.log('  report -> ' + OUT);
