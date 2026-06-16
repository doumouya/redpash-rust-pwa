#!/usr/bin/env node
/* Purpose: JS ↔ Rust /api seam audit (crossings / dangling / unused).
 * Doc: docs/internal/code/tools/crossing-audit.md (TODO — tools doc spine not yet seeded in this tree) */
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

   LEAN TREE NOTES (this cut differs from prerelease — adapted accordingly):
     • Rust router is assembled in backend/crates/api/src/main.rs (NOT a
       routes/mod.rs), modules live FLAT under .../api/src/<mod>.rs (NOT
       .../api/src/routes/<mod>.rs), and `files` is the one directory module
       (files/mod.rs + joins.rs + sql.rs). The api_router is mounted once at
       `.nest("/api", api_router)`, so every per-module nest gets a `/api`
       prefix prepended here (the per-module nests themselves are un-/api'd).
       A bare `.route("/health", …)` sits directly on api_router and is
       captured too.
     • There is no platform-admin nest-gate middleware in this cut (admin
       gating is in-handler: `caller.is_platform_admin`), so no GATE_MW.
     • JS lives under frontend/framework/** and frontend/apps/** (NOT
       frontend/scripts). The fetch wrapper is frontend/framework/boot/api.js
       and exposes get/post/put/patch/del/upload (lean names — `del` not
       `delete`, `upload` not getCached/prewarm). It prepends /api, so callers
       write api.get("/me") un-prefixed — we re-add /api. Direct
       fetch("/api/…") literals are caught too. Lean call sites use template
       literals (`/files/${rid}/page`) rather than string concat; norm()
       collapses ${…}/:param/*catch-all/ID/digit segments to :_ so both
       sides compare equal.

   This tool is SELF-CONTAINED (no tools/lib/ dependency) — the lean cut has
   not ported the shared rust-routes extractor, and the seam audit only needs
   a path-level route list + norm(). If/when tools/lib/rust-routes.js lands in
   lean, swap the inlined extractor for a require of it.

   Heuristic — regex, like the other audits; read the code to confirm a hit.

   Usage:  node audit.js [repoRoot]
   Output: ./report.html  +  a console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
// Lean layout: JS is split across the framework layer + the built apps; both
// hold real api.* / fetch("/api/…") call sites.
var JS_DIRS = [
  path.join(ROOT, 'frontend', 'framework'),
  path.join(ROOT, 'frontend', 'apps')
];
// Lean layout: flat module files under api/src, router assembled in main.rs.
var API_SRC = path.join(ROOT, 'backend', 'crates', 'api', 'src');
var MAIN_RS = path.join(API_SRC, 'main.rs');
var OUT = path.join(__dirname, 'report.html');

function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }
function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/* ── shared normalisers (inlined from prerelease tools/lib/rust-routes.js) ─── */

/* drop the ?query — depth-aware so a `${a ? b : c}` ternary inside a JS path
   isn't mistaken for the query separator. */
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

/* normalise a path so two representations of the same route compare equal:
   every param-ish segment collapses to :_  — Rust `:rid`, `*slug` catch-all,
   JS `${rid}`, a literal FIL_… id, a digit run. ?query stripped, trailing
   slash dropped. */
function norm(p) {
  var segs = stripQuery(p).split('/').map(function (s) {
    if (!s) return s;
    s = s.replace(/\$\{[^}]*\}$/, '');
    if (!s) return ':_';
    if (s.charAt(0) === ':') return ':_';
    if (s.charAt(0) === '*') return ':_';
    if (s.indexOf('${') >= 0) return ':_';
    if (/^[A-Z]{2,}_/.test(s)) return ':_';
    if (/^\d+$/.test(s)) return ':_';
    return s;
  });
  var out = segs.join('/').replace(/\/+$/, '');
  return out || '/';
}

/* ── Rust side — every /api route the backend serves ───────────────────────── */

/* Strip // line + block comments, position-preserving (whitespace fill), so a
   `.route(` inside a comment/doc-example isn't matched. Newlines kept → indices
   into the stripped text map 1:1 to the original for lineOf(). */
function strip(text) {
  return text
    .replace(/\/\/[^\n]*/g, function (m) { return ' '.repeat(m.length); })
    .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
}

function matchParens(s, openIdx) {
  if (s.charAt(openIdx) !== '(') return -1;
  var d = 1, i = openIdx + 1;
  while (i < s.length && d > 0) {
    var c = s.charAt(i);
    if (c === '(') d++;
    else if (c === ')') d--;
    if (d === 0) return i;
    i++;
  }
  return -1;
}

/* join a parent prefix with a relative .route()/.nest() path literal. Collapses
   double slashes, drops the trailing slash a bare "/" route would leave. */
function joinPath(a, b) {
  var p = (a + b).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

/* the method verbs chained in a `.route("/p", get(h).post(h2))` handler expr. */
function collectMethods(chain) {
  var re = /\b(get|post|put|patch|delete)\s*\(/g, m, seen = {}, out = [];
  while ((m = re.exec(chain))) {
    var v = m[1].toUpperCase();
    if (!seen[v]) { seen[v] = 1; out.push(v); }
  }
  return out;
}
function handlerFor(chain, method) {
  var m = chain.match(new RegExp('\\b' + method.toLowerCase() + '\\s*\\(\\s*([A-Za-z_][\\w:]*)'));
  return m ? m[1] : null;
}

/* the source file backing a route module: flat `<mod>.rs`, else the directory
   module's `<mod>/mod.rs` (lean: `files` → files/mod.rs). */
function moduleFile(mod) {
  var flat = path.join(API_SRC, mod + '.rs');
  if (fs.existsSync(flat)) return { abs: flat, rel: mod + '.rs' };
  var dirMod = path.join(API_SRC, mod, 'mod.rs');
  if (fs.existsSync(dirMod)) return { abs: dirMod, rel: mod + '/mod.rs' };
  return null;
}

/* emit every .route("/p", …) a module declares under `prefix`. Lean modules
   are flat (no in-module .nest()), so this is a single pass per module. */
function extractModuleRoutes(mod, prefix, out) {
  var mf = moduleFile(mod);
  if (!mf) return;
  var raw = read(mf.abs);
  if (raw == null) return;
  var s = strip(raw);
  var rRe = /\.route\s*\(/g, m;
  while ((m = rRe.exec(s))) {
    var open = s.indexOf('(', m.index);
    var close = matchParens(s, open);
    if (close < 0) { rRe.lastIndex = m.index + 6; continue; }
    var span = s.slice(open + 1, close);
    var lit = span.match(/^\s*"([^"]*)"/);
    if (!lit) { rRe.lastIndex = close; continue; }
    var routePath = lit[1];
    var chain = span.slice(lit.index + lit[0].length);
    var full = joinPath(prefix, routePath);
    var line = lineOf(raw, m.index);
    var methods = collectMethods(chain);
    if (!methods.length) methods = ['ANY'];
    methods.forEach(function (method) {
      out.push({ method: method, path: full, pathNorm: norm(full),
                 file: mf.rel, line: line, handler: handlerFor(chain, method) });
    });
    rRe.lastIndex = close;
  }
}

/* parse main.rs: the per-module `.nest("/<prefix>", <mod>::routes())` calls
   (each gets the api_router /api prefix prepended) PLUS any bare
   `.route("/health", …)` sitting directly on api_router. */
function rustRoutes() {
  var raw = read(MAIN_RS);
  if (raw == null) throw new Error('main.rs not found at ' + MAIN_RS);
  var s = strip(raw);
  var out = [];

  // direct .route()s on api_router (e.g. /api/health) — capture before nests.
  var rRe = /\.route\s*\(/g, rm;
  while ((rm = rRe.exec(s))) {
    var ro = s.indexOf('(', rm.index);
    var rc = matchParens(s, ro);
    if (rc < 0) { rRe.lastIndex = rm.index + 6; continue; }
    var rspan = s.slice(ro + 1, rc);
    var rlit = rspan.match(/^\s*"([^"]*)"/);
    if (rlit) {
      var rchain = rspan.slice(rlit.index + rlit[0].length);
      var rfull = joinPath('/api', rlit[1]);
      var rline = lineOf(raw, rm.index);
      var rmethods = collectMethods(rchain);
      if (!rmethods.length) rmethods = ['ANY'];
      rmethods.forEach(function (method) {
        out.push({ method: method, path: rfull, pathNorm: norm(rfull),
                   file: 'main.rs', line: rline, handler: handlerFor(rchain, method) });
      });
    }
    rRe.lastIndex = rc;
  }

  // per-module nests: .nest("/auth", auth::routes()) → /api/auth + auth.rs routes
  var nRe = /\.nest\s*\(/g, nm;
  while ((nm = nRe.exec(s))) {
    var no = s.indexOf('(', nm.index);
    var nc = matchParens(s, no);
    if (nc < 0) { nRe.lastIndex = nm.index + 5; continue; }
    var nspan = s.slice(no + 1, nc);
    var pfx = nspan.match(/^\s*"([^"]*)"/);
    var mod = nspan.match(/([a-z_]+)\s*::\s*routes\s*\(/);
    // the outer .nest("/api", api_router) has no `<mod>::routes()` → skip it;
    // its /api prefix is applied to the per-module prefixes directly.
    if (pfx && mod) extractModuleRoutes(mod[1], joinPath('/api', pfx[1]), out);
    nRe.lastIndex = nc;
  }

  // dedupe by (method, raw path)
  var seen = {}, deduped = [];
  out.forEach(function (r) {
    var k = r.method + ' ' + r.path;
    if (!seen[k]) { seen[k] = 1; deduped.push(r); }
  });
  deduped.sort(function (a, b) {
    return a.path.localeCompare(b.path) || a.method.localeCompare(b.method);
  });
  return deduped;
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
  var files = [];
  JS_DIRS.forEach(function (d) { walkJs(d, files); });
  files.sort().forEach(function (full) {
    var rel = path.relative(ROOT, full).split(path.sep).join('/');
    // the fetch wrapper itself — its only `/api${path}` is the wrapper template,
    // not a call to a concrete endpoint; skip so it doesn't false-dangle.
    if (/frontend\/framework\/boot\/api\.js$/.test(rel)) return;
    var text = read(full);
    if (text === null) return;
    var m;

    /* 1. api.<method>("…") — wrapper calls. Lean method surface:
          get/post/put/patch/del/upload. The path arg is un-prefixed (the
          wrapper prepends /api), so we re-add it here. Lean call sites use
          template literals (`/files/${rid}/page`); norm() collapses the
          ${…} segments to :_, so the whole literal is captured as-is.

          When the captured literal ends in '/' it's a concat prefix
          (`api.get('/files/' + rid + '/joins')`) — stitch the next
          ` + NAME + 'lit'`. Lean doesn't currently use string-concat paths,
          but the stitch is kept for parity / future-proofing. */
    var apiRe = /\bapi\.(get|post|patch|put|del|upload)\(\s*([`'"])((?:\\.|(?!\2)[\s\S])*?)\2/g;
    while ((m = apiRe.exec(text))) {
      var p = '/api' + m[3];
      if (p.charAt(p.length - 1) === '/') {
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

    /* 2. literal "/api/…" strings — direct fetch() + href/window.location nav
          (e.g. the OAuth `/api/auth/google/start` redirect, CSV export hrefs). */
    var litRe = /([`'"])(\/api\/[^`'"]*)\1/g;
    while ((m = litRe.exec(text))) {
      var lp = m[2];
      /* a captured string ending in '/' is almost always a concat prefix
         (`'/api/files/' + rid + '/page'`) — stitch the next ` + x + 'lit'`. */
      if (lp.charAt(lp.length - 1) === '/') {
        var lafter = text.slice(litRe.lastIndex, litRe.lastIndex + 140);
        var cc = lafter.match(/^\s*\+\s*[A-Za-z_$][\w$.\[\]]*\s*\+\s*([`'"])([^`'"]*)\1/);
        if (cc) {
          var lseg = cc[2];
          if (lseg && lseg.charAt(0) !== '/') lseg = '/' + lseg;
          lp = lp.replace(/\/$/, '') + '/:_' + lseg;
        }
      }
      calls.push(mkCall(lp, rel, lineOf(text, m.index)));
    }
  });
  return calls;
}

/* ── join ────────────────────────────────────────────────────────────────── */
console.log('Crossing audit — ' + ROOT + ' …');
// path-level seam audit: map the (method, path) route records to {path(norm),
// raw, file, line} and let rustBy dedup collapse the per-method duplicates.
var routes = rustRoutes().map(function (r) {
  return { path: r.pathNorm, raw: r.path, file: r.file, line: r.line };
});
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
