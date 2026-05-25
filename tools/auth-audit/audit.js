#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash auth-audit — ownership-hygiene scanner

   Em-greenlit RBAC prep (Torv → Gus, Internal-Slack 2026-05-24): a
   mechanical regression net for ownership hygiene BEFORE the RBAC
   workstream lands. RBAC on a leaky surface = leaky RBAC.

   Walks every backend route handler. For each handler that path-
   extracts a resource id, checks an ownership gate appears before
   any db::* mutation OR Json(...) return. For each mutation handler,
   checks that event::record fires for the audit trail. Flags the
   misses; counts the healthy uses for trend.

   Three pattern categories (per Torv's spec):

   1. **Route-level ownership** — every handler with Path(rid):
      must call super::ensure_owner / super::ensure_*_owner before
      writing or returning data. Cat-1 flag = leak (ownership skip).

   2. **Cross-resource transitive** — handlers that enumerate
      sibling resources via the parent. DEFERRED to v2: needs a
      hand-curated catalog first (e.g. joins'
      list_files_in_project_except, charts referencing
      source_file_id). Encoded as named patterns once the catalog
      stabilizes.

   3. **Audit-trail completeness** — every mutation handler should
      emit event::record(). Cat-3 flag = audit-gap (silent mutation).

   Heuristic, not a parser — brace-counting + regex on the raw text,
   like rs-audit. Good enough to point at the work; read the code
   to confirm a hit.

   Usage:  node audit.js [backendDir]
   Output: ./report.html  +  console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var SRC_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : '/home/mansa/redpash-app/backend';
var OUT = path.join(__dirname, 'report.html');

/* ── handler discovery + body extraction ─────────────────────────────────── */

/* Strip comments + string literals so they don't false-match regex
   below. **Position-preserving** — replaces removed content with
   spaces (preserving newlines) so byte offsets in stripped text
   align 1:1 with the raw input. The annotation detector
   (`hasAuthAck`) re-reads from raw using the offsets findHandlers
   computed against stripped, so the two MUST stay in sync. */
function strip(text) {
  return text
    .replace(/\/\/[^\n]*/g,         function (m) { return ' '.repeat(m.length); })
    .replace(/\/\*[\s\S]*?\*\//g,   function (m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/"(?:\\.|[^"\\])*"/g,  function (m) { return '"' + ' '.repeat(m.length - 2) + '"'; })
    .replace(/'(?:\\.|[^'\\])*'/g,  function (m) { return "'" + ' '.repeat(m.length - 2) + "'"; });
}

/* Find every `pub async fn <name>(<params>) -> <ret> { <body> }` and
   return { name, params, body, ackBody, start, end } for each.
   `body` is the comment-stripped inner (safe for regex matches);
   `ackBody` is the raw inner (for AUTH-AUDIT-ACK annotation detection
   which lives inside comments). start/end are byte offsets — strip()
   preserves byte positions so they're identical across raw/stripped. */
function findHandlers(raw, stripped) {
  var out = [];
  // Handlers in routes/ are typically `async fn` (module-private); the
  // pub variant appears for cross-module helpers. Match both shapes.
  var re = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?async\s+fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;
  var m;
  while ((m = re.exec(stripped)) !== null) {
    var name = m[1];
    var paramStart = m.index + m[0].length;
    var paramEnd = matchParens(stripped, paramStart - 1);  // back to "(" itself
    if (paramEnd < 0) continue;
    var params = stripped.slice(paramStart, paramEnd);
    // Find the next "{" that opens the body. Skip the return-type
    // arrow + any whitespace.
    var braceStart = stripped.indexOf('{', paramEnd + 1);
    if (braceStart < 0) continue;
    var braceEnd = matchBraces(stripped, braceStart);
    if (braceEnd < 0) continue;
    out.push({
      name:    name,
      params:  params,
      body:    stripped.slice(braceStart + 1, braceEnd),
      ackBody: raw.slice(braceStart + 1, braceEnd),
      start:   m.index,
      end:     braceEnd
    });
    re.lastIndex = braceEnd;
  }
  return out;
}

/* Handler carries an inline AUTH-AUDIT-ACK annotation. The annotation
   format is a comment `// AUTH-AUDIT-ACK: <reason>` somewhere in the
   handler body. Use it to mark handlers that path-extract a rid but
   don't (and shouldn't) call an ownership gate — admin-scoped
   surfaces, monitoring read-only globals, intentionally dev-permissive
   handlers during the [[redpash-stage]] pre-prod period. The annotation
   text gets captured for the report so reviewers see WHY it's
   acknowledged, not just THAT it is. */
function hasAuthAck(rawBody) {
  var m = rawBody.match(/\/\/\s*AUTH-AUDIT-ACK:\s*([^\n]*)/);
  return m ? m[1].trim() : null;
}

/* Match a `(` at index `i` to its closing `)`. Returns the close index
   or -1. Assumes strings/comments already stripped. */
function matchParens(s, i) {
  if (s.charAt(i) !== '(') return -1;
  var depth = 1;
  for (var j = i + 1; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}
function matchBraces(s, i) {
  if (s.charAt(i) !== '{') return -1;
  var depth = 1;
  for (var j = i + 1; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/* ── per-handler classifiers ─────────────────────────────────────────────── */

/* Handler extracts a resource id via Path. Matches `Path(rid)`,
   `Path(name)`, `Path((parent, child))` shapes. False-negatives
   on Path<i64> or Path<MyTuple> are acceptable for v1 — those are
   rare in the routes/. */
function extractsRid(params) {
  return /\bPath\s*\(\s*(?:\(.*?\)|\w+)\s*\)/.test(params);
}

/* Has an ownership-gate call somewhere in the body. Four canonical
   gates today, all auditable:
     - ensure_owner — generic, used for FIL_/PRJ_/CHT_/DSH_ resources
     - require_member — company_memberships-backed; companies.rs lane
     - company_role — same family, returns the role for admin/owner
       gating in the same family of handlers
     - users_share_company — events read-gate; cross-user reads only
       allowed inside the same company
   Add the next gate name here when it lands. */
function callsOwnershipGate(body) {
  return /\b(?:super::)?ensure_(?:\w+_)?owner\s*\(/.test(body)
      || /\b(?:super::)?require_member\s*\(/.test(body)
      || /\bdb::company_role\s*\(/.test(body)
      || /\bdb::users_share_company\s*\(/.test(body);
}

/* Mutates the DB. Either calls db::insert_/update_/delete_ OR
   returns a 2xx-with-side-effect status. */
function isMutation(body) {
  if (/\bdb::(insert|update|delete|patch|create|set|add|remove|record|persist|store)_\w+\s*\(/.test(body)) return true;
  if (/\bdb::(insert|update|delete|patch|create|set|add|remove|record)\s*\(/.test(body)) return true;
  if (/StatusCode::CREATED\b/.test(body))      return true;
  if (/StatusCode::NO_CONTENT\b/.test(body))   return true;
  return false;
}

/* Has an event-emit call (the audit-trail emit). Recognizes both
   the raw `event::record(EventDraft {...})` shape (4 kept sites:
   capture_mw, frontend ingest, etc.) and the ergonomic builder
   shape introduced in 780b3c9: `event::info|warn|error(db, kind,
   msg).user(u).context(c).send()`. Per-handler check — either
   form satisfies the audit-trail requirement. */
function callsEventRecord(body) {
  return /\b(?:crate::)?event::(?:record|info|warn|error)\s*\(/.test(body);
}

/* Routes whose handlers don't carry per-user ownership by design.
   These files get a relaxed cat-1 check — handlers can extract
   Path(rid) without ensure_owner if the resource is public, admin-
   scoped, or session-scoped via a different gate. The list is
   curated; expand when a new public-surface file lands. */
var PUBLIC_SURFACE_FILES = [
  'routes/auth.rs',          // login/logout — session establishment, not resource access
  'routes/health.rs',        // ping endpoint
  'routes/metrics.rs',       // global metrics
  'routes/docs.rs',          // markdown docs viewer
  'routes/demo.rs',          // ephemeral demo endpoint
];

/* Helper-function names (not handlers despite the pub-async-fn form)
   that show up in routes/. Skip these — they're called BY handlers
   that do the ownership check on entry. */
var HELPER_NAMES = [
  'resolve_user_rid',   // routes/me.rs — IS the ownership-resolver
  'read_cookie',        // routes/auth.rs — cookie parser
  'ensure_owner',       // routes/mod.rs — the helper itself
  'require_member',     // routes/companies.rs — co-helper to ensure_owner
  'apply_prefs_patch',  // routes/me.rs — called from patch_me/patch_me_prefs
  'split_method_route', // routes/monitoring.rs — pure parser
  'evaluate_measurement',  // routes/monitoring.rs — pure compute
];

function isPublicSurface(rel) {
  return PUBLIC_SURFACE_FILES.some(function (f) { return rel.endsWith(f); });
}

/* ── scan ────────────────────────────────────────────────────────────────── */

function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'target' || e.name === 'node_modules' || e.name === '.git') return;
      walk(full, acc);
    } else if (e.isFile() && full.endsWith('.rs')) {
      acc.push(full);
    }
  });
  return acc;
}

console.log('Scanning ' + SRC_DIR + ' …');
var routesDir = path.join(SRC_DIR, 'crates/api/src/routes');
var paths = walk(routesDir, []).sort();
if (!paths.length) { console.error('No .rs files under ' + routesDir); process.exit(1); }

var handlers = [];        // every detected pub async fn — full inventory
var leaks = [];           // cat-1: Path-extract handler missing ensure_owner AND no ACK
var acknowledged = [];    // cat-1: missing gate BUT carries AUTH-AUDIT-ACK annotation
var auditGaps = [];       // cat-3: mutation handler missing event::record
var ensureOwnerCalls = 0;
var eventRecordCalls = 0;

paths.forEach(function (full) {
  var rel = path.relative(SRC_DIR, full).split(path.sep).join('/');
  var text = fs.readFileSync(full, 'utf8');
  var stripped = strip(text);

  // Whole-file occurrence counts (live signal). Counts any of the
  // canonical gates — same set callsOwnershipGate() recognises.
  var eoMatches = stripped.match(/\b(?:super::)?ensure_(?:\w+_)?owner\s*\(|\b(?:super::)?require_member\s*\(/g);
  if (eoMatches) ensureOwnerCalls += eoMatches.length;
  // Counts both the raw event::record sites and the post-780b3c9
  // event::info / warn / error builder sites — same audit-trail
  // signal. See callsEventRecord() above for the per-handler check.
  var erMatches = stripped.match(/\b(?:crate::)?event::(?:record|info|warn|error)\s*\(/g);
  if (erMatches) eventRecordCalls += erMatches.length;

  findHandlers(text, stripped).forEach(function (h) {
    if (HELPER_NAMES.indexOf(h.name) >= 0) return;
    // Heuristic: handlers take an axum extractor (State/Path/Json/
    // Query/Multipart/HeaderMap). Pure helpers / pure computes that
    // don't take an extractor get skipped.
    if (!/\b(State|Path|Json|Query|Multipart|Form|HeaderMap|Bytes)\s*[<\(]/.test(h.params)
        && !/HeaderMap\s*$/.test(h.params)) {
      return;
    }
    handlers.push({ file: rel, name: h.name });
    var rid = extractsRid(h.params);
    var owner = rid && callsOwnershipGate(h.body);
    var mut = isMutation(h.body);
    var rec = callsEventRecord(h.body);
    var ack = hasAuthAck(h.ackBody);
    if (rid && !owner && !isPublicSurface(rel)) {
      if (ack) {
        acknowledged.push({
          file: rel, name: h.name,
          reason: ack,
          detail: 'Path-extracted handler without gate — acknowledged inline'
        });
      } else {
        leaks.push({
          file: rel, name: h.name,
          kind: 'no-ensure-owner',
          detail: 'Path-extracted handler without ensure_owner gate'
        });
      }
    }
    if (mut && !rec) {
      auditGaps.push({
        file: rel, name: h.name,
        kind: 'no-event-record',
        detail: 'mutation handler without event::record(audit trail)'
      });
    }
  });
});

var byFileName = function (a, b) { return a.file.localeCompare(b.file) || a.name.localeCompare(b.name); };
handlers.sort(byFileName);
leaks.sort(byFileName);
acknowledged.sort(byFileName);
auditGaps.sort(byFileName);

/* ── headline + payload ──────────────────────────────────────────────────── */

var data = {
  generatedAt:       new Date().toISOString(),
  srcDir:            routesDir,
  stats: {
    handlers:         handlers.length,
    ensureOwnerCalls: ensureOwnerCalls,
    eventRecordCalls: eventRecordCalls,
    leaks:            leaks.length,
    acknowledged:     acknowledged.length,
    auditGaps:        auditGaps.length,
  },
  handlers:     handlers,
  leaks:        leaks,
  acknowledged: acknowledged,
  auditGaps:    auditGaps,
};

fs.writeFileSync(path.join(__dirname, 'audit.json'), JSON.stringify(data, null, 2));

/* ── HTML report ─────────────────────────────────────────────────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<title>RedPash auth-audit</title>',
    '<style>' + CSS + '</style>',
    '</head><body>',
    '<header>',
    '  <h1>Auth-audit <span class="muted">· redpash-app</span></h1>',
    '  <div class="sub" id="sub"></div>',
    '</header>',
    '<section class="cards" id="cards"></section>',
    '<nav class="tabs">',
    '  <button class="tab active" data-tab="leaks">Ownership leaks</button>',
    '  <button class="tab" data-tab="acks">Acknowledged</button>',
    '  <button class="tab" data-tab="audit">Audit-trail gaps</button>',
    '  <button class="tab" data-tab="handlers">All handlers</button>',
    '</nav>',
    '<div class="panel" id="panel-leaks">',
    '  <div class="toolbar"><span class="count" id="count-leaks"></span></div>',
    '  <table id="t-leaks"><thead><tr>',
    '    <th>File</th><th>Handler</th><th>Detail</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-acks">',
    '  <div class="toolbar"><span class="count" id="count-acks"></span></div>',
    '  <table id="t-acks"><thead><tr>',
    '    <th>File</th><th>Handler</th><th>Reason (AUTH-AUDIT-ACK)</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-audit">',
    '  <div class="toolbar"><span class="count" id="count-audit"></span></div>',
    '  <table id="t-audit"><thead><tr>',
    '    <th>File</th><th>Handler</th><th>Detail</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-handlers">',
    '  <div class="toolbar"><input id="q-handlers" placeholder="Filter…">',
    '    <span class="count" id="count-handlers"></span></div>',
    '  <table id="t-handlers"><thead><tr>',
    '    <th>File</th><th>Handler</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<script>var DATA=' + json + ';</script>',
    '<script>' + JS + '</script>',
    '</body></html>',
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
  '.card.bad .n{color:var(--bad)}.card.warn .n{color:var(--warn)}.card.ok .n{color:var(--ok)}',
  '.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--line)}',
  '.tab{background:none;border:0;color:var(--muted);padding:10px 14px;cursor:pointer;',
  'font-size:13px;border-bottom:2px solid transparent}',
  '.tab.active{color:var(--text);border-bottom-color:var(--accent)}',
  '.panel{padding:14px 26px 80px}.panel.hidden{display:none}',
  '.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:10px}',
  '.toolbar input{background:var(--panel2);border:1px solid var(--line);color:var(--text);',
  'border-radius:8px;padding:7px 11px;width:320px;font-size:13px}',
  '.count{color:var(--muted);font-size:12px;margin-left:auto}',
  'table{width:100%;border-collapse:collapse}',
  'thead th{position:sticky;top:0;background:var(--panel);text-align:left;z-index:2;',
  'font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);',
  'padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}',
  'tbody tr{border-bottom:1px solid var(--line)}',
  'tbody tr:hover{background:var(--panel)}',
  'tbody td{padding:7px 10px;vertical-align:top}',
  '.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:#e6ebf2}',
  '.empty{padding:40px;text-align:center;color:var(--muted)}',
].join('');

var JS = [
  "(function(){'use strict';var D=DATA;",
  "function esc(s){return String(s).replace(/[&<>\"]/g,function(c){",
  "return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
  "document.getElementById('sub').textContent=D.srcDir+'  —  generated '+",
  "new Date(D.generatedAt).toLocaleString();",
  "var cards=[",
  "['Handlers',           D.stats.handlers,         ''],",
  "['ensure_owner uses',  D.stats.ensureOwnerCalls, 'ok'],",
  "['event::record uses', D.stats.eventRecordCalls, 'ok'],",
  "['Ownership leaks',    D.stats.leaks,            D.stats.leaks?'bad':'ok'],",
  "['Acknowledged',       D.stats.acknowledged,     D.stats.acknowledged?'warn':''],",
  "['Audit-trail gaps',   D.stats.auditGaps,        D.stats.auditGaps?'warn':'ok']",
  "];",
  "document.getElementById('cards').innerHTML=cards.map(function(c){",
  "return '<div class=\"card '+c[2]+'\"><div class=\"n\">'+c[1]+",
  "'</div><div class=\"l\">'+c[0]+'</div></div>';}).join('');",
  "var tabs=document.querySelectorAll('.tab');",
  "for(var i=0;i<tabs.length;i++)tabs[i].addEventListener('click',function(){",
  "for(var j=0;j<tabs.length;j++)tabs[j].classList.remove('active');",
  "this.classList.add('active');var t=this.getAttribute('data-tab');",
  "['leaks','acks','audit','handlers'].forEach(function(p){",
  "document.getElementById('panel-'+p).classList.toggle('hidden',p!==t);});});",
  "function renderRows(id,rows,cols){",
  "var tb=document.querySelector('#'+id+' tbody');",
  "if(!rows.length){tb.innerHTML='<tr><td colspan=\"'+cols+'\" class=\"empty\">None.</td></tr>';return;}",
  "tb.innerHTML=rows.map(function(r){return '<tr><td><span class=\"mono\">'+esc(r.file)+'</span></td>'+",
  "'<td><span class=\"mono\">'+esc(r.name)+'</span></td>'+",
  "(cols===3?'<td>'+esc(r.detail||'')+'</td>':'')+'</tr>';}).join('');}",
  "document.getElementById('count-leaks').textContent=D.leaks.length+' leak(s)';",
  "renderRows('t-leaks',D.leaks,3);",
  "document.getElementById('count-acks').textContent=D.acknowledged.length+' acknowledged';",
  "renderRows('t-acks',D.acknowledged.map(function(a){return {file:a.file,name:a.name,detail:a.reason};}),3);",
  "document.getElementById('count-audit').textContent=D.auditGaps.length+' gap(s)';",
  "renderRows('t-audit',D.auditGaps,3);",
  "function renderHandlers(){",
  "var q=document.getElementById('q-handlers').value.toLowerCase();",
  "var rows=D.handlers.filter(function(r){return !q||(r.file+r.name).toLowerCase().indexOf(q)>=0;});",
  "document.getElementById('count-handlers').textContent=rows.length+' of '+D.handlers.length;",
  "renderRows('t-handlers',rows,2);}",
  "document.getElementById('q-handlers').addEventListener('input',renderHandlers);",
  "renderHandlers();",
  "})();",
].join('\n');

fs.writeFileSync(OUT, renderHtml(data), 'utf8');

/* ── console summary ─────────────────────────────────────────────────────── */
console.log('');
console.log('  handlers scanned   ' + data.stats.handlers);
console.log('  ensure_owner uses  ' + data.stats.ensureOwnerCalls);
console.log('  event::record uses ' + data.stats.eventRecordCalls);
console.log('');
console.log('  ownership leaks    ' + data.stats.leaks
  + (data.stats.leaks ? '   ⚠  (no gate, no AUTH-AUDIT-ACK annotation)' : '   ✓'));
console.log('  acknowledged       ' + data.stats.acknowledged
  + (data.stats.acknowledged ? '   ●  (gate skipped + AUTH-AUDIT-ACK present)' : ''));
console.log('  audit-trail gaps   ' + data.stats.auditGaps
  + (data.stats.auditGaps ? '   ⚠  (mutation without event::record)' : '   ✓'));

if (leaks.length) {
  console.log('');
  console.log('  ownership leaks (top 10):');
  leaks.slice(0, 10).forEach(function (l) {
    console.log('    ' + l.file + '::' + l.name + '  —  ' + l.detail);
  });
}
if (auditGaps.length) {
  console.log('');
  console.log('  audit-trail gaps (top 10):');
  auditGaps.slice(0, 10).forEach(function (g) {
    console.log('    ' + g.file + '::' + g.name + '  —  ' + g.detail);
  });
}

console.log('');
console.log('  report   -> ' + OUT);
console.log('  json     -> ' + path.join(__dirname, 'audit.json'));
