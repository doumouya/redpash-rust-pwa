#!/usr/bin/env node
/* Purpose: API doc↔code parity audit — undocumented / stale / method / param / auth drift.
   Doc surface: docs/internal/code/backend/api-routes.md (the single HTTP catalog). */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash API-doc audit — does the hand-written catalog match the served route?
   ---------------------------------------------------------------------------
   The code (axum routes assembled in backend/crates/api/src/main.rs + each
   module's `routes()`) is the single source of truth. The hand-written catalog
   `docs/internal/code/backend/api-routes.md` drifts from it. This tool extracts
   both sides and diffs them.

   LEAN LAYOUT (adapted from the prerelease per-resource-doc tree): there is ONE
   catalog file, not a `docs/internal/rest-api/<module>.md` per resource. The
   catalog documents each module as a `### \`/api/<resource>…\`` section holding
   a markdown table whose rows are `| METHOD | \`/path\` | … |`. Two lean-specific
   quirks the parser handles:
     • Table Path cells OMIT the `/api` prefix (`/auth/logout`, not
       `/api/auth/logout`) — we prepend `/api` to compare with code.
     • Cells use `·`-separated compounds: a multi-method cell
       `| GET · PATCH · DELETE | \`/objects/:type/:rid\` |` and a multi-path cell
       `| POST | \`/files/:rid/undo\` · \`/redo\` |`. Both are expanded.

   Code side  : tools/lib/rust-routes.js (the shared extractor — method + path
                + nest-layer RBAC gate; rooted at main.rs for the lean cut).
   Doc side   : the catalog's METHOD/Path table rows (+ `## METHOD /api/path`
                headings, kept as a fallback should the catalog ever use them).

   Findings:
     undocumented_endpoint  route served, no catalog row covers it
     stale_doc_endpoint     catalog row for a path no route serves
     method_mismatch        same path, doc/code methods differ
     path_param_mismatch    same normalised path, raw :param NAME differs
     auth_mismatch          code route is platform-admin nest-gated, doc says open
                            (lean gates admin IN-HANDLER, so this is dormant — kept
                            generic so a future nest-layer gate is caught)
     doc_missing            a served resource has NO documented endpoint in the catalog

   Intentional gaps live in tools/api-doc-audit/acks.json (not flagged).

   Usage:  node audit.js [repoRoot]
   Output: ./report.html  +  ./audit.json  +  a console summary.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');
var routesLib = require('../lib/rust-routes');
var norm = routesLib.norm;

var ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
// Lean: the HTTP surface is ONE catalog under the rebuilt docs tree.
var DOC_CATALOG = path.join(ROOT, 'docs', 'internal', 'code', 'backend', 'api-routes.md');
var DOC_CATALOG_REL = 'docs/internal/code/backend/api-routes.md';
var OUT_HTML = path.join(__dirname, 'report.html');
var OUT_JSON = path.join(__dirname, 'audit.json');
var ACKS_FILE = path.join(__dirname, 'acks.json');

var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }
function lineOf(text, idx) { var n = 1; for (var i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++; return n; }

/* prepend the `/api` mount the catalog omits in its table Path cells. Heading
   forms already carry `/api`, so only add it when absent. */
function apiPath(p) {
  p = p.trim();
  if (p.indexOf('/api/') === 0 || p === '/api') return p;
  if (p.charAt(0) === '/') return '/api' + p;
  return p;
}

/* ── ACK allowlist ───────────────────────────────────────────────────────── */
function loadAcks() {
  var raw = read(ACKS_FILE);
  if (raw == null) return {};
  try { return JSON.parse(raw); } catch (e) { console.error('acks.json parse error: ' + e.message); return {}; }
}
function ackMatch(patterns, rawPath) {
  if (!patterns) return false;
  return patterns.some(function (p) {
    if (typeof p !== 'string') return false;
    if (p.slice(-2) === '/*') { var base = p.slice(0, -2); return rawPath === base || rawPath.indexOf(base + '/') === 0; }
    return norm(p) === norm(rawPath);
  });
}

/* ── doc side — parse the api-routes.md catalog ───────────────────────────── */
/* Primary form (lean): markdown table rows
     | GET | `/auth/google/start` | — | … |
     | GET · PATCH · DELETE | `/objects/:type/:rid` | … |     (· multi-method)
     | POST | `/files/:rid/undo` · `/redo` | … |              (· multi-path)
   The Path cell omits `/api`; methods are split on `·`/`,`; extra backtick
   paths after the first in the Path cell are sibling routes (same method).
   Fallback form: `## METHOD /api/path` headings (none in the lean catalog
   today, but cheap to keep so a future heading-style doc still parses). */
var TABLE_ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
var HEAD_RE = /^#{2,3}\s+`(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^`]+)`(.*)$/gm;

function splitMethods(cell) {
  return cell.split(/[·,/]| and /).map(function (s) { return s.trim().toUpperCase(); })
    .filter(function (s) { return METHODS.indexOf(s) >= 0; });
}
function backtickPaths(cell) {
  var out = [], re = /`([^`]+)`/g, m;
  while ((m = re.exec(cell))) {
    var p = stripTrailingPunct(m[1].trim());
    if (p.charAt(0) === '/') out.push(p);
  }
  return out;
}

function parseCatalog(rel, text) {
  var eps = [], m;

  // table rows
  TABLE_ROW_RE.lastIndex = 0;
  while ((m = TABLE_ROW_RE.exec(text))) {
    var methodCell = m[1], pathCell = m[2];
    var methods = splitMethods(methodCell);
    if (!methods.length) continue;                 // header / non-endpoint row
    var paths = backtickPaths(pathCell);
    if (!paths.length) continue;
    var line = lineOf(text, m.index);
    var section = sectionAt(text, m.index);
    // the FIRST backtick path pairs with all methods; trailing `·`-separated
    // paths are SIBLING routes carrying the row's method — and are written
    // relative to the first path's parent (`/files/:rid/undo` · `/redo` means
    // `/files/:rid/redo`, not a top-level `/redo`), so resolve them that way.
    var first = paths[0];
    methods.forEach(function (method) {
      eps.push({ method: method, path: apiPath(first), line: line, docFile: rel, section: section });
    });
    var parent = first.replace(/\/[^/]*$/, '');     // drop the last segment
    for (var i = 1; i < paths.length; i++) {
      var sib = paths[i];
      var resolved = sib.indexOf('/') === 0 && sib.split('/').length === 2
        ? parent + sib                               // bare `/redo` → sibling
        : sib;                                       // a deeper path stands alone
      eps.push({ method: methods[0], path: apiPath(stripTrailingPunct(resolved)), line: line, docFile: rel, section: '', compound: true });
    }
  }

  // fallback: `## METHOD /api/path` headings with optional `and` compounds
  HEAD_RE.lastIndex = 0;
  while ((m = HEAD_RE.exec(text))) {
    var hm = m[1], hp = stripTrailingPunct(m[2].trim()), trailer = m[3] || '';
    var hl = lineOf(text, m.index);
    if (!eps.some(function (e) { return e.method === hm && e.path === hp; })) {
      eps.push({ method: hm, path: hp, line: hl, docFile: rel, section: sectionAt(text, m.index) });
    }
    var cm, cre = /and\s+`([^`]+)`/g;
    while ((cm = cre.exec(trailer))) {
      var tok = cm[1].trim();
      if (METHODS.indexOf(tok.toUpperCase()) >= 0) {
        eps.push({ method: tok.toUpperCase(), path: hp, line: hl, docFile: rel, section: '', compound: true });
      } else if (tok.charAt(0) === '/') {
        var base = hp.replace(/\/[^/]*$/, '');
        eps.push({ method: hm, path: stripTrailingPunct(base + tok), line: hl, docFile: rel, section: '', compound: true });
      }
    }
  }

  return { eps: eps, claimsOpen: docSaysOpen(text) };
}

function stripTrailingPunct(p) { return p.replace(/[\s.,:;]+$/, '').replace(/\?.*$/, ''); }
function sectionAt(text, headIdx) {
  // the enclosing `### …` section's prose (for the auth heuristic + jsonc blocks)
  var start = text.lastIndexOf('\n###', headIdx);
  if (start < 0) start = text.lastIndexOf('\n##', headIdx);
  var from = start < 0 ? headIdx : start;
  var next = text.indexOf('\n### ', headIdx + 1);
  return text.slice(from, next < 0 ? Math.min(text.length, headIdx + 1500) : next);
}

/* ── code side — resource of an /api path ─────────────────────────────────── */
function resourceOf(apiP) { var seg = apiP.split('/'); return seg[2] || ''; }

/* ── auth heuristic (conservative — only the high-signal understatement) ──── */
function docSaysOpen(section) {
  return /\bpublic\b|open today|no auth\b|without auth|no session|solo\/localhost/i.test(section || '');
}

/* ── main ────────────────────────────────────────────────────────────────── */
console.log('API-doc audit — ' + ROOT + ' …');
var acks = loadAcks();
var code = routesLib.rustRoutes(ROOT);

// code maps: normPath → { methods:{M:route}, raw, rbac }
var codeByNorm = {};
code.forEach(function (r) {
  var e = codeByNorm[r.pathNorm] || (codeByNorm[r.pathNorm] = { methods: {}, raw: r.path, rbac: r.rbac });
  e.methods[r.method] = r;
});

// doc set — one catalog file
var docByNorm = {};
var docMeta = {};               // catalog rel → { claimsOpen, gated:0 }
var catalogText = read(DOC_CATALOG);
if (catalogText == null) {
  console.error('catalog not found: ' + DOC_CATALOG_REL + ' — nothing to diff against.');
}
var parsed = parseCatalog(DOC_CATALOG_REL, catalogText || '');
docMeta[DOC_CATALOG_REL] = { claimsOpen: parsed.claimsOpen, gated: 0, line: 1 };
parsed.eps.forEach(function (ep) {
  var n = norm(ep.path);
  var e = docByNorm[n] || (docByNorm[n] = { methods: {}, raw: ep.path, docFile: ep.docFile, line: ep.line, section: ep.section });
  e.methods[ep.method] = ep;
});

var findings = [];
function add(kind, sev, key, detail, extra) {
  var f = { kind: kind, severity: sev, key: key, detail: detail };
  if (extra) for (var k in extra) f[k] = extra[k];
  var ackList = acks[kind];
  f.ack = ackMatch(ackList, extra && extra.path ? extra.path : key) || (kind === 'doc_missing' && ackList && ackList.indexOf(key) >= 0);
  findings.push(f);
}

// 1. code → doc : undocumented_endpoint / method_mismatch
Object.keys(codeByNorm).forEach(function (n) {
  var c = codeByNorm[n];
  var d = docByNorm[n];
  Object.keys(c.methods).forEach(function (method) {
    var r = c.methods[method];
    if (!d) {
      add('undocumented_endpoint', mutating(method) ? 'high' : 'med',
        method + ' ' + r.path,
        'Route served but no api-routes.md catalog row documents it.',
        { path: r.path, method: method, file: r.file, line: r.line });
    } else if (!d.methods[method]) {
      add('method_mismatch', 'med',
        method + ' ' + r.path,
        'Code serves ' + method + ' ' + r.path + ' but the catalog for this path documents only [' + Object.keys(d.methods).join(', ') + '].',
        { path: r.path, method: method, file: r.file, line: r.line, docFile: d.docFile });
    }
  });
});

// 2. doc → code : stale_doc_endpoint / method_mismatch / param mismatch
Object.keys(docByNorm).forEach(function (n) {
  var d = docByNorm[n];
  var c = codeByNorm[n];
  Object.keys(d.methods).forEach(function (method) {
    var ep = d.methods[method];
    if (!c) {
      add('stale_doc_endpoint', 'med',
        method + ' ' + ep.path,
        'Catalog documents ' + method + ' ' + ep.path + ' but no route serves this path.',
        { path: ep.path, method: method, docFile: ep.docFile, line: ep.line });
    } else if (!c.methods[method]) {
      add('method_mismatch', 'med',
        method + ' ' + ep.path,
        'Catalog documents ' + method + ' ' + ep.path + ' but code serves only [' + Object.keys(c.methods).join(', ') + '] there.',
        { path: ep.path, method: method, docFile: ep.docFile, line: ep.line });
    }
  });
  // param-name diff (same normalised path, raw segments differ)
  if (c) {
    var pm = paramMismatch(c.raw, d.raw);
    if (pm) {
      add('path_param_mismatch', 'low',
        d.raw + ' ≠ ' + c.raw,
        'Catalog path param name(s) ' + pm.doc + ' differ from code ' + pm.code + ' (same route).',
        { path: c.raw, docFile: d.docFile, line: d.line });
    }
    if (c.rbac && c.rbac.hint === 'platform_admin' && docMeta[d.docFile]) docMeta[d.docFile].gated++;
  }
});

// 2b. auth_mismatch (file-level): the catalog's routes are nest-layer
// platform-admin-gated in code but its prose calls access public/open. Lean
// gates admin IN-HANDLER (no nest layer), so docMeta.gated stays 0 and this is
// dormant — kept generic so a future nest-layer gate surfaces here.
Object.keys(docMeta).forEach(function (rel) {
  var meta = docMeta[rel];
  if (meta.claimsOpen && meta.gated > 0) {
    add('auth_mismatch', 'high', 'auth ' + rel,
      meta.gated + ' route(s) in ' + rel + ' are platform-admin nest-gated in code, but the catalog describes access as public/open.',
      { path: '/' + rel, docFile: rel, line: 1 });
  }
});

// 3. doc_missing : a served resource with NO documented endpoint in the catalog
// (lean has ONE catalog, so this is per-resource coverage of that file, not a
// missing per-module page).
var docResources = {};
Object.keys(docByNorm).forEach(function (n) { docResources[resourceOf(docByNorm[n].raw)] = true; });
var resources = {};
code.forEach(function (r) { resources[resourceOf(r.path)] = true; });
Object.keys(resources).sort().forEach(function (res) {
  if (!res) return;
  if (!docResources[res]) {
    add('doc_missing', 'med', res, 'Route module /api/' + res + '/* has no documented endpoint in ' + DOC_CATALOG_REL + '.', { path: '/api/' + res });
  }
});

// 4. schema field-name parity : fenced ```jsonc / ```json blocks in a section ↔
// request/response struct fields. The lean catalog documents shapes inline in
// table cells (no fenced blocks), so this is conservative + inert today; it
// activates automatically if a section ever adds a jsonc example block.
Object.keys(docByNorm).forEach(function (n) {
  var c = codeByNorm[n]; var d = docByNorm[n];
  if (!c) return;
  Object.keys(d.methods).forEach(function (method) {
    var cr = c.methods[method], ep = d.methods[method];
    if (!cr || !ep || !ep.section) return;
    var blocks = jsoncBlocks(ep.section);
    if (!blocks.length) return;
    var localText = routesLib.moduleTextForFile(ROOT, cr.file);
    if (cr.reqType) {
      var rb = blocks.filter(function (b) { return b.kind === 'request'; })[0];
      var rf = routesLib.dtoFields(ROOT, cr.reqType, localText);
      if (rb && rf && !rf.listElem) schemaDiff('request', method, cr.raw || cr.path, ep, (rb.keys[1] || []), rf);
    }
    if (cr.respType) {
      var sb = blocks.filter(function (b) { return b.kind === 'response'; })[0];
      var sf = routesLib.dtoFields(ROOT, cr.respType, localText);
      if (sb && sf) {
        if (sf.listElem) {
          var ef = routesLib.dtoFields(ROOT, sf.listElem, localText);
          if (ef && !ef.listElem) schemaDiff('response', method, cr.raw || cr.path, ep, (sb.keys[2] || []), ef);
        } else {
          schemaDiff('response', method, cr.raw || cr.path, ep, (sb.keys[1] || []), sf);
        }
      }
    }
  });
});

// 5. secondary surfaces — REDMAP "docs ⇄ code" + INDEX link integrity. The lean
// REDMAP/INDEX are navigation docs: REDMAP maps docs→code AREAS (no raw /api
// paths), INDEX is a one-line-per-doc table. The valuable check here is (a) any
// backtick `/api/...` path REDMAP/INDEX names that no route serves (stale), and
// (b) the catalog itself is linked from INDEX (a missing link breaks the spine).
var codeNormSet = {}, codeNormList = [];
code.forEach(function (r) { if (!codeNormSet[r.pathNorm]) { codeNormSet[r.pathNorm] = true; codeNormList.push(r.pathNorm); } });
function isPrefixOfRoute(n) { return codeNormList.some(function (c) { return c.indexOf(n + '/') === 0; }); }

[['docs/REDMAP.md', 'REDMAP'], ['docs/INDEX.md', 'INDEX']].forEach(function (surf) {
  var text = read(path.join(ROOT, surf[0]));
  if (text == null) return;
  extractApiPaths(text).forEach(function (raw) {
    if (raw.indexOf('*') >= 0) return;
    var n = norm(raw);
    if (!codeNormSet[n] && !isPrefixOfRoute(n) && !ackMatch(acks.stale_doc_endpoint, raw)) {
      add('index_link_drift', 'med', surf[1] + ' ' + raw,
        surf[1] + ' lists `' + raw + '` but no route serves it (stale entry).',
        { path: raw, docFile: surf[0] });
    }
  });
});

// INDEX.md must link the catalog (the spine's API doc).
var indexText = read(path.join(ROOT, 'docs', 'INDEX.md'));
if (indexText != null && indexText.indexOf('api-routes.md') < 0) {
  add('index_link_drift', 'low', 'INDEX omits api-routes.md',
    'docs/INDEX.md does not link the API catalog (' + DOC_CATALOG_REL + ').',
    { path: '/' + DOC_CATALOG_REL, docFile: 'docs/INDEX.md' });
}

/* ── payload ─────────────────────────────────────────────────────────────── */
var active = findings.filter(function (f) { return !f.ack; });
var ackd = findings.filter(function (f) { return f.ack; });
var byKind = {};
active.forEach(function (f) { (byKind[f.kind] || (byKind[f.kind] = [])).push(f); });

var data = {
  tool: 'api-doc',
  generatedAt: new Date().toISOString(),
  root: ROOT,
  stats: {
    codeRoutes: code.length,
    docEndpoints: Object.keys(docByNorm).reduce(function (a, n) { return a + Object.keys(docByNorm[n].methods).length; }, 0),
    findings: active.length,
    acknowledged: ackd.length,
    undocumented_endpoint: (byKind.undocumented_endpoint || []).length,
    stale_doc_endpoint: (byKind.stale_doc_endpoint || []).length,
    method_mismatch: (byKind.method_mismatch || []).length,
    path_param_mismatch: (byKind.path_param_mismatch || []).length,
    auth_mismatch: (byKind.auth_mismatch || []).length,
    doc_missing: (byKind.doc_missing || []).length,
    schema_field_undocumented: (byKind.schema_field_undocumented || []).length,
    schema_field_missing_in_doc: (byKind.schema_field_missing_in_doc || []).length,
    index_link_drift: (byKind.index_link_drift || []).length
  },
  findings: active,
  acknowledged: ackd
};

// audit.json (DB-ingest shape — stable keys)
fs.writeFileSync(OUT_JSON, JSON.stringify({
  tool: 'api-doc', generatedAt: data.generatedAt, stats: data.stats,
  findings: active.map(function (f) {
    return { kind: f.kind, key: f.key, severity: f.severity, detail: f.detail,
             path: f.path || null, method: f.method || null, file: f.file || f.docFile || null, line: f.line || null };
  })
}, null, 2), 'utf8');

fs.writeFileSync(OUT_HTML, renderHtml(data), 'utf8');

/* ── console ─────────────────────────────────────────────────────────────── */
console.log('');
console.log('  code routes        ' + data.stats.codeRoutes);
console.log('  documented eps     ' + data.stats.docEndpoints);
console.log('  findings           ' + data.stats.findings + '   (' + data.stats.acknowledged + ' acknowledged)');
[['undocumented_endpoint', 'undocumented'], ['stale_doc_endpoint', 'stale doc'],
 ['method_mismatch', 'method mismatch'], ['path_param_mismatch', 'param mismatch'],
 ['auth_mismatch', 'auth mismatch'], ['doc_missing', 'doc missing'],
 ['schema_field_undocumented', 'schema undoc field'], ['schema_field_missing_in_doc', 'schema field missing'],
 ['index_link_drift', 'index/link drift']].forEach(function (k) {
  if (data.stats[k[0]]) console.log('    ' + k[1].padEnd(18) + data.stats[k[0]]);
});
var highs = active.filter(function (f) { return f.severity === 'high'; }).length;
if (highs) console.log('  ' + highs + ' high-severity finding(s) — see report.');
console.log('');
console.log('  report -> ' + OUT_HTML);

// Exit 0 on a successful run (audit-suite convention — a non-zero exit means a
// crashed tool). Regression gating is the ci-audit ratchet's job, not this code.
process.exit(0);

/* ── helpers ─────────────────────────────────────────────────────────────── */
function mutating(method) { return method !== 'GET'; }

/* backtick-wrapped `/api/…` paths in a summary doc. Skips brace-expansion
   shorthand + anything with whitespace/commas — only clean single paths. */
function extractApiPaths(text) {
  var out = {}, re = /`(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/api\/[^`]+)`/g, m;
  while ((m = re.exec(text))) {
    var p = m[1].trim().replace(/\?.*$/, '');
    if (/[{}\s,]/.test(p)) continue;
    if (!/^\/api\/[A-Za-z0-9_:*\/.-]+$/.test(p)) continue;
    out[p] = true;
  }
  return Object.keys(out);
}

/* fenced ```jsonc / ```json blocks in a doc section, classified request vs
   response by their first line, with keys grouped by object depth. */
function jsoncBlocks(section) {
  var blocks = [], re = /```(?:jsonc|json)\s*\n([\s\S]*?)```/g, m;
  while ((m = re.exec(section || ''))) {
    var body = m[1];
    var first = '';
    body.split('\n').some(function (l) { if (l.trim()) { first = l.trim(); return true; } return false; });
    var kind = /^\d{3}\b/.test(first) ? 'response'
             : /^(GET|POST|PUT|PATCH|DELETE)\b/.test(first) ? 'request' : '?';
    blocks.push({ kind: kind, keys: keysByDepth(body) });
  }
  return blocks;
}
function keysByDepth(s) {
  var byDepth = {}, depth = 0, i = 0, n = s.length;
  while (i < n) {
    var c = s[i];
    if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (c === '"') {
      var j = i + 1;
      while (j < n && s[j] !== '"') { if (s[j] === '\\') j += 2; else j++; }
      var key = s.slice(i + 1, j), k = j + 1;
      while (k < n && /\s/.test(s[k])) k++;
      if (s[k] === ':') (byDepth[depth] || (byDepth[depth] = [])).push(key);
      i = j + 1; continue;
    }
    i++;
  }
  return byDepth;
}
function schemaDiff(kind, method, rawPath, ep, docKeys, struct) {
  if (!docKeys.length || !struct.fields.length) return;
  var fieldSet = {}; struct.fields.forEach(function (f) { fieldSet[f] = true; });
  var docSet = {}; docKeys.forEach(function (k) { docSet[k] = true; });
  docKeys.forEach(function (k) {
    if (!fieldSet[k]) {
      add('schema_field_undocumented', 'med', method + ' ' + rawPath + ' {' + k + '}',
        'Doc ' + kind + ' block documents field "' + k + '" with no matching field in the ' + kind + ' struct.',
        { path: rawPath, method: method, docFile: ep.docFile, line: ep.line });
    }
  });
  struct.fields.forEach(function (f) {
    if (!docSet[f] && !struct.optional[f]) {
      add('schema_field_missing_in_doc', 'low', method + ' ' + rawPath + ' {' + f + '}',
        'Required ' + kind + ' field "' + f + '" is not documented in the doc ' + kind + ' block.',
        { path: rawPath, method: method, docFile: ep.docFile, line: ep.line });
    }
  });
}
function paramMismatch(codeRaw, docRaw) {
  var cs = codeRaw.split('/'), ds = docRaw.split('/');
  if (cs.length !== ds.length) return null;
  var codeP = [], docP = [];
  for (var i = 0; i < cs.length; i++) {
    var c = cs[i], d = ds[i];
    var cparam = c.charAt(0) === ':', dparam = d.charAt(0) === ':';
    if (cparam && dparam && c !== d) { codeP.push(c); docP.push(d); }
  }
  return codeP.length ? { code: codeP.join(','), doc: docP.join(',') } : null;
}

/* ── HTML report (dark, tabbed — the crossing-audit idiom) ───────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>RedPash API-doc audit</title><style>' + CSS + '</style></head><body>',
    '<header><h1>API-doc audit <span class="muted">· api-routes.md ↔ axum routes</span></h1>',
    '<div class="sub" id="sub"></div></header>',
    '<section class="cards" id="cards"></section>',
    '<nav class="tabs" id="tabs"></nav>',
    '<div class="panel" id="panel"></div>',
    '<script>var DATA=' + json + ';</script><script>' + JS + '</script>',
    '</body></html>'
  ].join('\n');
}

var CSS = [
  ':root{--bg:#0d1117;--panel:#11161f;--panel2:#161c28;--line:#222b3a;--text:#d6dbe5;',
  '--muted:#7c8699;--accent:#b3001b;--accent2:#5b8cff;--bad:#ff5d6c;--warn:#e0a64b;--ok:#3fb56b}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);',
  'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}',
  'header{padding:22px 26px 14px;border-bottom:1px solid var(--line)}',
  'h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}.muted{color:var(--muted);font-weight:400}',
  '.sub{margin-top:4px;color:var(--muted);font-size:12px}',
  '.cards{display:flex;flex-wrap:wrap;gap:10px;padding:16px 26px}',
  '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:118px}',
  '.card .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}',
  '.card .l{font-size:11px;color:var(--muted);margin-top:2px}',
  '.card.bad .n{color:var(--bad)}.card.warn .n{color:var(--warn)}.card.ok .n{color:var(--ok)}',
  '.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--line);flex-wrap:wrap}',
  '.tab{background:none;border:0;color:var(--muted);padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:2px solid transparent}',
  '.tab.active{color:var(--text);border-bottom-color:var(--accent)}',
  '.panel{padding:14px 26px 80px}',
  'table{width:100%;border-collapse:collapse}',
  'thead th{position:sticky;top:0;background:var(--panel);text-align:left;z-index:2;font-size:11px;',
  'text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}',
  'tbody tr{border-bottom:1px solid var(--line)}tbody tr:hover{background:var(--panel)}',
  'tbody td{padding:7px 10px;vertical-align:top}',
  '.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:#e6ebf2}',
  '.sev{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:5px;font-weight:700}',
  '.sev.high{background:rgba(255,93,108,.16);color:var(--bad)}.sev.med{background:rgba(224,166,75,.16);color:var(--warn)}',
  '.sev.low{background:rgba(124,134,153,.18);color:var(--muted)}',
  '.where{color:var(--muted);font-size:11px;margin-top:3px;font-family:ui-monospace,Menlo,Consolas,monospace}',
  '.empty{padding:40px;text-align:center;color:var(--muted)}'
].join('');

var JS = [
  "(function(){'use strict';var D=DATA;",
  "function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c];});}",
  "document.getElementById('sub').textContent=D.root+'  —  '+D.stats.codeRoutes+' routes, '+D.stats.docEndpoints+' documented  —  generated '+new Date(D.generatedAt).toLocaleString();",
  "var cards=[['Code routes',D.stats.codeRoutes,''],['Documented',D.stats.docEndpoints,''],",
  "['Findings',D.stats.findings,D.stats.findings?'bad':'ok'],['Acknowledged',D.stats.acknowledged,'']];",
  "document.getElementById('cards').innerHTML=cards.map(function(c){return '<div class=\"card '+c[2]+'\"><div class=\"n\">'+c[1]+'</div><div class=\"l\">'+c[0]+'</div></div>';}).join('');",
  "var kinds=['undocumented_endpoint','stale_doc_endpoint','method_mismatch','path_param_mismatch','auth_mismatch','doc_missing','schema_field_undocumented','schema_field_missing_in_doc','index_link_drift'];",
  "var groups={};kinds.forEach(function(k){groups[k]=[];});D.findings.forEach(function(f){(groups[f.kind]||(groups[f.kind]=[])).push(f);});",
  "var tabsEl=document.getElementById('tabs');var order=kinds.filter(function(k){return groups[k]&&groups[k].length;});",
  "if(!order.length)order=['(none)'];",
  "tabsEl.innerHTML=order.map(function(k,i){var n=groups[k]?groups[k].length:0;return '<button class=\"tab'+(i===0?' active':'')+'\" data-k=\"'+k+'\">'+k.replace(/_/g,' ')+' ('+n+')</button>';}).join('');",
  "function paint(k){var rows=groups[k]||[];var panel=document.getElementById('panel');",
  "if(!rows.length){panel.innerHTML='<div class=empty>No findings.</div>';return;}",
  "panel.innerHTML='<table><thead><tr><th>Sev</th><th>Endpoint / key</th><th>Detail</th></tr></thead><tbody>'+rows.map(function(f){",
  "return '<tr><td><span class=\"sev '+f.severity+'\">'+f.severity+'</span></td>'+",
  "'<td><span class=\"mono\">'+esc(f.key)+'</span><div class=\"where\">'+esc(f.file||f.docFile||'')+(f.line?(':'+f.line):'')+'</div></td>'+",
  "'<td>'+esc(f.detail)+'</td></tr>';}).join('')+'</tbody></table>';}",
  "for(var i=0;i<tabsEl.children.length;i++)(function(b){b.addEventListener('click',function(){",
  "for(var j=0;j<tabsEl.children.length;j++)tabsEl.children[j].classList.remove('active');b.classList.add('active');paint(b.getAttribute('data-k'));});})(tabsEl.children[i]);",
  "paint(order[0]);})();"
].join('\n');
