#!/usr/bin/env node
/* Purpose: JS ↔ Rust /api seam audit (crossings / dangling / unused).
 * Doc: docs/internal/code/tools/audit-suite/crossing-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash crossing audit — the JS ↔ Rust API seam
   ---------------------------------------------------------------------------
   The js-rust-boundary contract: the two languages may cross at exactly two
   points — HTTP /api routes and shared-crate DTOs. This tool does the route
   half: it joins the /api paths the JS calls against the routes the Rust
   serves, the way css-audit joins a class to the rules that target it.

   Three views:
     1. Crossings  — an /api path the JS calls AND the Rust serves. Healthy.
     2. Dangling   — the JS calls an /api path no Rust route serves. A bug:
                     a fetch to a 404 (the cross-language dead link).
     3. Unused     — the Rust serves a route no JS fetch calls. Dead-ish —
                     but confirm: OAuth redirects / browser nav reach routes
                     without a fetch, so they surface here too.

   Rust side: routes/mod.rs gives the module→prefix nest map; a route is
   /api + prefix + the .route("…") literal. JS side: the api.js wrapper
   prepends /api, so callers write api.get("/projects") un-prefixed — we
   re-add /api. Direct fetch("/api/…") and ENDPOINT constants are caught as
   literals; `${x}` params and the ?query are resolved to :_ / dropped.
   Heuristic — regex, like the other audits; read the code to confirm a hit.

   Usage:  node audit.js [repoRoot]
   Output: ./report.html  +  a console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
var JS_DIR = path.join(ROOT, 'frontend', 'scripts');
var ROUTES_DIR = path.join(ROOT, 'backend', 'crates', 'api', 'src', 'routes');
var OUT = path.join(__dirname, 'report.html');

function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }
function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/* drop the ?query — depth-aware, so a `${a ? b : c}` ternary inside the
   path isn't mistaken for the query separator. */
function stripQuery(p) {
  var depth = 0;
  for (var i = 0; i < p.length; i++) {
    var c = p.charAt(i);
    if (c === '$' && p.charAt(i + 1) === '{') { depth++; i++; }
    else if (c === '}' && depth > 0) { depth--; }
    else if (c === '?' && depth === 0) return p.slice(0, i);
  }
  return p;
}

/* normalise a path so a JS call and the Rust route it hits compare equal.
   Every param-ish segment collapses to :_ — Rust's `:rid`, JS's `${rid}`,
   a literal FIL_… id, a digit run. A `${…}` glued onto a literal segment
   (`/dedup${qs}`) is a query var appended to a real segment — keep the
   literal, drop the var. The ?query is stripped first. Trailing slash dropped. */
function norm(p) {
  var segs = stripQuery(p).split('/').map(function (s) {
    if (!s) return s;
    s = s.replace(/\$\{[^}]*\}$/, '');               // trailing `${…}` glue
    if (!s) return ':_';                             // segment was pure `${…}`
    if (s.charAt(0) === ':') return ':_';            // Rust  :rid
    if (s.charAt(0) === '*') return ':_';            // Rust  *slug catch-all
    if (s.indexOf('${') >= 0) return ':_';           // JS    `${rid}`
    if (/^[A-Z]{2,}_/.test(s)) return ':_';          // a literal FIL_… id
    if (/^\d+$/.test(s)) return ':_';                // a numeric id
    return s;
  });
  var out = segs.join('/').replace(/\/+$/, '');
  return out || '/';
}

/* ── Rust side — the routes the backend serves ───────────────────────────── */
function rustRoutes() {
  var modText = read(path.join(ROUTES_DIR, 'mod.rs'));
  if (modText === null) { console.error('routes/mod.rs not found'); process.exit(1); }

  var nest = {}, m;
  var nestRe = /\.nest\(\s*"(\/[^"]*)"\s*,\s*([a-z_]+)::routes\(\)\s*\)/g;
  while ((m = nestRe.exec(modText))) nest[m[2]] = m[1];

  var routes = [];
  Object.keys(nest).forEach(function (mod) {
    var text = read(path.join(ROUTES_DIR, mod + '.rs'));
    if (text === null) return;
    var re = /\.route\(\s*"([^"]*)"/g, mm;
    while ((mm = re.exec(text))) {
      var full = '/api' + nest[mod] + mm[1];
      routes.push({
        path: norm(full), raw: full,
        file: 'routes/' + mod + '.rs', line: lineOf(text, mm.index)
      });
    }
  });
  return routes;
}

/* ── JS side — the /api paths the frontend calls ─────────────────────────── */
function walkJs(dir, acc) {
  var ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  ents.forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, acc);
    else if (e.isFile() && /\.js$/i.test(e.name)) acc.push(full);
  });
  return acc;
}

function mkCall(raw, file, line) {
  return { path: norm(raw), raw: raw, file: file, line: line };
}

function jsCalls() {
  var calls = [];
  walkJs(JS_DIR, []).sort().forEach(function (full) {
    var rel = path.relative(JS_DIR, full).split(path.sep).join('/');
    if (rel === 'api.js') return;          // the wrapper — only doc-comment examples, no real calls
    var text = read(full);
    if (text === null) return;
    var m;

    /* 1. api.<method>("…") — wrapper calls. The path arg is un-prefixed
          (the wrapper prepends /api), so we re-add it here.

          When the captured literal ends in '/' it's almost always a
          concat prefix (`api.get('/files/' + rid + '/joins')`) — stitch
          the next ` + NAME + 'lit'` so the normalized path still has
          the trailing segment + matches the Rust :_ param. Same shape
          as the litRe stitch below; without it api.<method> calls with
          stringly-built paths register as their truncated prefix
          and falsely dangle. */
    var apiRe = /\bapi\.(get|post|patch|put|delete|getCached|invalidateCached)\(\s*([`'"])((?:\\.|(?!\2)[\s\S])*?)\2/g;
    while ((m = apiRe.exec(text))) {
      var p = '/api' + m[3];
      if (p.charAt(p.length - 1) === '/') {
        // Two-step stitch: first the `+ NAME` ident expression (captures
        // dotted / bracketed / function-call references like
        // encodeURIComponent(rid)), THEN optionally a trailing
        // `+ "literal"` segment. Handles both shapes:
        //   api.get('/foo/' + rid + '/bar')   → /api/foo/:_/bar
        //   api.get('/foo/' + rid)            → /api/foo/:_
        // Without the second-shape branch, the path of an
        // open-ended call (just `+ NAME` with no trailing literal)
        // gets captured as `/api/foo/` → normalized to `/api/foo` →
        // false-dangling against the real `/foo/:_` route.
        // `p` ends with '/' from the captured literal. The next literal
        // segment ALSO starts with '/', so we strip the trailing slash
        // from `p` before appending — keeps the path single-slash-
        // separated. Without this, '/files/' + ':_' + '/page' would
        // produce '/files/:_/page' (right) but the literal-first variant
        // of the stitch was originally written as '/files/' + ':_' +
        // 'page' (dropping the leading slash from the segment), which
        // collapses to '/files/:_page' and false-reports every multi-
        // segment route under :rid as unused.
        var after = text.slice(apiRe.lastIndex, apiRe.lastIndex + 240);
        var stitchVar = after.match(/^\s*\+\s*[A-Za-z_$][\w$.\[\]()]*/);
        if (stitchVar) {
          p = p.replace(/\/$/, '') + '/:_';
          var rest = after.slice(stitchVar[0].length);
          var stitchLit = rest.match(/^\s*\+\s*([`'"])([^`'"]*)\1/);
          if (stitchLit) {
            var seg = stitchLit[2];
            if (seg && seg.charAt(0) !== '/') seg = '/' + seg;
            p = p + seg;
          }
        }
      }
      calls.push(mkCall(p, rel, lineOf(text, m.index)));
    }

    /* 2. api.prewarm(["…","…"]) — an array of un-prefixed list paths. */
    var pwRe = /\bapi\.prewarm\(\s*\[([^\]]*)\]/g;
    while ((m = pwRe.exec(text))) {
      var inner = m[1], ln = lineOf(text, m.index), sm;
      var strRe = /([`'"])([^`'"]*)\1/g;
      while ((sm = strRe.exec(inner))) {
        if (sm[2]) calls.push(mkCall('/api' + sm[2], rel, ln));
      }
    }

    /* 3. literal "/api/…" strings — direct fetch() + ENDPOINT constants. */
    var litRe = /([`'"])(\/api\/[^`'"]*)\1/g;
    while ((m = litRe.exec(text))) {
      var p = m[2];
      /* a captured string ending in '/' is almost always a concat prefix
         (`'/api/files/' + rid + '/page'`) — stitch the next ` + x + 'lit'`. */
      if (p.charAt(p.length - 1) === '/') {
        var after = text.slice(litRe.lastIndex, litRe.lastIndex + 140);
        var cc = after.match(/^\s*\+\s*[A-Za-z_$][\w$.\[\]]*\s*\+\s*([`'"])([^`'"]*)\1/);
        if (cc) {
          // Same slash-preservation as the apiRe stitch above —
          // move the slash from before :_ rather than dropping the
          // leading slash from the captured literal, so the result
          // is `/api/foo/:_/bar` not `/api/foo/:_bar`.
          var seg = cc[2];
          if (seg && seg.charAt(0) !== '/') seg = '/' + seg;
          p = p.replace(/\/$/, '') + '/:_' + seg;
        }
      }
      calls.push(mkCall(p, rel, lineOf(text, m.index)));
    }
  });
  return calls;
}

/* ── join ────────────────────────────────────────────────────────────────── */
console.log('Crossing audit — ' + ROOT + ' …');
var routes = rustRoutes();
var calls = jsCalls();

var rustBy = {};
routes.forEach(function (r) { if (!rustBy[r.path]) rustBy[r.path] = r; });

var jsBy = {};
calls.forEach(function (c) {
  (jsBy[c.path] || (jsBy[c.path] = [])).push({ file: c.file, line: c.line });
});

var crossings = [], dangling = [];
Object.keys(jsBy).sort().forEach(function (p) {
  var sites = jsBy[p];
  if (rustBy[p]) {
    crossings.push({ path: p, sites: sites, route: rustBy[p] });
  } else {
    dangling.push({ path: p, sites: sites });
  }
});
var unused = [];
Object.keys(rustBy).sort().forEach(function (p) {
  if (!jsBy[p]) unused.push({ path: p, route: rustBy[p] });
});
crossings.sort(function (a, b) { return b.sites.length - a.sites.length || a.path.localeCompare(b.path); });
dangling.sort(function (a, b) { return b.sites.length - a.sites.length || a.path.localeCompare(b.path); });

/* ── payload ─────────────────────────────────────────────────────────────── */
var data = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  stats: {
    jsPaths: Object.keys(jsBy).length,
    rustRoutes: Object.keys(rustBy).length,
    crossings: crossings.length,
    dangling: dangling.length,
    unused: unused.length
  },
  crossings: crossings,
  dangling: dangling,
  unused: unused
};

/* ── HTML report ─────────────────────────────────────────────────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>RedPash crossing audit</title>',
    '<style>' + CSS + '</style>',
    '</head><body>',
    '<header>',
    '  <h1>JS ↔ Rust crossing audit <span class="muted">· the /api seam</span></h1>',
    '  <div class="sub" id="sub"></div>',
    '</header>',
    '<section class="cards" id="cards"></section>',
    '<nav class="tabs">',
    '  <button class="tab active" data-tab="crossings">Crossings</button>',
    '  <button class="tab" data-tab="dangling">Dangling JS calls</button>',
    '  <button class="tab" data-tab="unused">Unused endpoints</button>',
    '</nav>',
    '<div class="panel" id="panel-crossings">',
    '  <div class="toolbar"><input id="q-crossings" placeholder="Filter paths…" autocomplete="off">',
    '    <span class="count" id="count-crossings"></span></div>',
    '  <table id="t-crossings"><thead><tr>',
    '    <th data-k="path">/api path</th><th data-k="n" class="num">JS calls</th>',
    '    <th data-k="route">Rust route</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-dangling">',
    '  <div class="toolbar"><span class="count" id="count-dangling"></span></div>',
    '  <table id="t-dangling"><thead><tr>',
    '    <th data-k="path">JS calls it — no Rust route serves it</th>',
    '    <th data-k="n" class="num">Sites</th>',
    '  </tr></thead><tbody></tbody></table>',
    '</div>',
    '<div class="panel hidden" id="panel-unused">',
    '  <div class="toolbar"><span class="count" id="count-unused"></span></div>',
    '  <table id="t-unused"><thead><tr>',
    '    <th data-k="path">Rust serves it — no JS fetch calls it</th>',
    '    <th data-k="route">Defined</th>',
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
  '.card.bad .n{color:var(--bad)}.card.warn .n{color:var(--warn)}.card.ok .n{color:var(--ok)}',
  '.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--line)}',
  '.tab{background:none;border:0;color:var(--muted);padding:10px 14px;cursor:pointer;',
  'font-size:13px;border-bottom:2px solid transparent}',
  '.tab.active{color:var(--text);border-bottom-color:var(--accent)}',
  '.panel{padding:14px 26px 80px}.panel.hidden{display:none}',
  '.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:10px;flex-wrap:wrap}',
  '.toolbar input[type=text],#q-crossings{background:var(--panel2);',
  'border:1px solid var(--line);color:var(--text);border-radius:8px;',
  'padding:7px 11px;width:320px;font-size:13px}',
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
  '.where{color:var(--muted);font-size:11px;margin-top:3px;',
  'font-family:ui-monospace,Menlo,Consolas,monospace}',
  '.empty{padding:40px;text-align:center;color:var(--muted)}'
].join('');

/* report client script — ES5, no template literals, no ${ */
var JS = [
  "(function(){'use strict';var D=DATA;",
  "function esc(s){return String(s).replace(/[&<>\"]/g,function(c){",
  "return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
  "document.getElementById('sub').textContent=D.root+'  —  generated '+",
  "new Date(D.generatedAt).toLocaleString();",
  "var cards=[['JS /api calls',D.stats.jsPaths,''],",
  "['Rust routes',D.stats.rustRoutes,''],",
  "['Crossings',D.stats.crossings,'ok'],",
  "['Dangling JS calls',D.stats.dangling,'bad'],",
  "['Unused endpoints',D.stats.unused,'warn']];",
  "document.getElementById('cards').innerHTML=cards.map(function(c){",
  "return '<div class=\"card '+c[2]+'\"><div class=\"n\">'+c[1]+",
  "'</div><div class=\"l\">'+c[0]+'</div></div>';}).join('');",
  "var tabs=document.querySelectorAll('.tab');",
  "for(var i=0;i<tabs.length;i++)tabs[i].addEventListener('click',function(){",
  "for(var j=0;j<tabs.length;j++)tabs[j].classList.remove('active');",
  "this.classList.add('active');var t=this.getAttribute('data-tab');",
  "['crossings','dangling','unused'].forEach(function(p){",
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
  "function sites(a){return a.map(function(s){return esc(s.file)+':'+s.line;}).join('  ·  ');}",
  "var cSort={k:'n',asc:false};",
  "function rowsC(){return D.crossings.map(function(r){",
  "return{path:r.path,n:r.sites.length,route:r.route.file+':'+r.route.line,_r:r};});}",
  "function renderCrossings(){var q=document.getElementById('q-crossings').value.toLowerCase();",
  "var rows=rowsC().filter(function(r){return !q||r.path.toLowerCase().indexOf(q)>=0;});",
  "sortRows(rows,cSort);",
  "document.getElementById('count-crossings').textContent=rows.length+' of '+D.crossings.length;",
  "var tb=document.querySelector('#t-crossings tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td><span class=\"mono\">'+esc(r.path)+'</span>'+",
  "'<div class=\"where\">'+sites(r._r.sites)+'</div></td>'+",
  "'<td class=num>'+r.n+'</td>'+",
  "'<td><span class=\"mono\">'+esc(r.route)+'</span></td></tr>';",
  "}).join(''):'<tr><td colspan=3 class=empty>No matches.</td></tr>';}",
  "var dSort={k:'n',asc:false};",
  "function renderDangling(){var rows=D.dangling.map(function(r){",
  "return{path:r.path,n:r.sites.length,_r:r};});sortRows(rows,dSort);",
  "document.getElementById('count-dangling').textContent=",
  "rows.length+' dangling \\u2014 JS fetches with no route';",
  "var tb=document.querySelector('#t-dangling tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td><span class=\"mono\">'+esc(r.path)+'</span>'+",
  "'<div class=\"where\">'+sites(r._r.sites)+'</div></td>'+",
  "'<td class=num>'+r.n+'</td></tr>';",
  "}).join(''):'<tr><td colspan=2 class=empty>None \\u2014 every JS call hits a route.</td></tr>';}",
  "var uSort={k:'path',asc:true};",
  "function renderUnused(){var rows=D.unused.slice();sortRows(rows,uSort);",
  "document.getElementById('count-unused').textContent=",
  "rows.length+' routes no JS fetch calls (confirm \\u2014 OAuth / nav reach some)';",
  "var tb=document.querySelector('#t-unused tbody');",
  "tb.innerHTML=rows.length?rows.map(function(r){",
  "return '<tr><td><span class=\"mono\">'+esc(r.path)+'</span></td>'+",
  "'<td><span class=\"mono\">'+esc(r.route.file)+':'+r.route.line+'</span></td></tr>';",
  "}).join(''):'<tr><td colspan=2 class=empty>None \\u2014 every route has a caller.</td></tr>';}",
  "document.getElementById('q-crossings').addEventListener('input',renderCrossings);",
  "wireSort('t-crossings',cSort,renderCrossings);",
  "wireSort('t-dangling',dSort,renderDangling);wireSort('t-unused',uSort,renderUnused);",
  "renderCrossings();renderDangling();renderUnused();})();"
].join('\n');

/* ── emit ────────────────────────────────────────────────────────────────── */
fs.writeFileSync(OUT, renderHtml(data), 'utf8');

console.log('');
console.log('  JS /api calls     ' + data.stats.jsPaths + ' distinct paths');
console.log('  Rust routes       ' + data.stats.rustRoutes + ' served');
console.log('  crossings         ' + data.stats.crossings + '   (called AND served — healthy)');
console.log('  dangling          ' + data.stats.dangling + '   (JS calls it, no route — a 404)');
console.log('  unused            ' + data.stats.unused + '   (route served, no JS fetch — confirm)');
if (dangling.length) {
  console.log('');
  console.log('  dangling JS calls:');
  dangling.forEach(function (d) {
    console.log('    ' + d.path + '   <- ' + d.sites[0].file + ':' + d.sites[0].line);
  });
}
console.log('');
console.log('  report -> ' + OUT);
