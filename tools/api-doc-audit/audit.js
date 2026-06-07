#!/usr/bin/env node
/* Purpose: API doc↔code parity audit — undocumented / stale / method / param / auth drift.
   Doc: docs/internal/code/tools/audit-suite/api-doc-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash API-doc audit — does the hand-written doc match the served route?
   ---------------------------------------------------------------------------
   The code (axum routes in backend/crates/api/src/routes/) is the single
   source of truth. The hand-written `docs/api/*.md` contract pages drift from
   it. This tool extracts both sides and diffs them, the way crossing-audit
   diffs JS calls against routes — but here the doc surface is the other side.

   Code side  : tools/lib/rust-routes.js (the shared extractor — method + path
                + nest-layer RBAC gate).
   Doc side   : docs/api/*.md endpoint headings  ## `METHOD /api/path`  (incl.
                compound  `…/undo` and `/redo`  /  `…/cleanness` and `DELETE`).

   Findings:
     undocumented_endpoint  route served, no doc heading covers it
     stale_doc_endpoint     doc heading for a path no route serves
     method_mismatch        same path, doc/code methods differ
     path_param_mismatch    same normalised path, raw :param NAME differs
     auth_mismatch          code route is platform-admin-gated, doc says public/open
     doc_missing            a route module has no docs/api/<module>.md at all

   Intentional gaps live in tools/api-doc-audit/acks.json (not flagged).

   v1 = endpoint-set parity (this file). Schema field-name parity + the REDMAP /
   api-routes.md / INDEX surfaces land in later steps (see the plan).

   Usage:  node audit.js [repoRoot]
   Output: ./report.html  +  ./audit.json  +  a console summary.  Exit 1 on
           any high-severity finding (so audit.sh surfaces it).
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');
var routesLib = require('../lib/rust-routes');
var norm = routesLib.norm;

var ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
// API docs moved into the rebuilt internal tree (CAS_701CF65E): the per-resource
// WHY pages live under docs/internal/rest-api/, alongside the generated route
// table in that section's index.md (which is skipped below — it's not a module doc).
var DOCS_API = path.join(ROOT, 'docs', 'internal', 'rest-api');
var OUT_HTML = path.join(__dirname, 'report.html');
var OUT_JSON = path.join(__dirname, 'audit.json');
var ACKS_FILE = path.join(__dirname, 'acks.json');

var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }
function lineOf(text, idx) { var n = 1; for (var i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++; return n; }

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

/* ── doc side — parse docs/api/*.md endpoint headings ─────────────────────── */
/* a heading is  ## `METHOD /api/path`  with optional  and `…`  compounds:
     ## `POST /api/files/:rid/undo` and `/redo`        (sibling path, same method)
     ## `POST /api/files/:rid/cleanness` and `DELETE`  (same path, extra method) */
var HEAD_RE = /^#{2,3}\s+`(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^`]+)`(.*)$/gm;
var HEAD_RE_NOBT = /^#{2,3}\s+(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)\s*$/gm;
// table-row form (admin.md / monitoring.md):  | `GET /api/admin/users` | … | … |
var TABLE_RE = /^\|\s*`(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^`]+)`\s*\|/gm;

function parseDocFile(rel, text) {
  var fmTitle = '';
  var fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) { var t = fm[1].match(/^title:\s*(.+)$/m); if (t) fmTitle = t[1].trim(); }

  var eps = [], m;
  HEAD_RE.lastIndex = 0;
  while ((m = HEAD_RE.exec(text))) {
    var method = m[1], p = stripTrailingPunct(m[2].trim()), trailer = m[3] || '';
    var line = lineOf(text, m.index);
    eps.push({ method: method, path: p, line: line, docFile: rel, section: sectionAt(text, m.index) });
    // compound `…` tokens
    var cm, cre = /and\s+`([^`]+)`/g;
    while ((cm = cre.exec(trailer))) {
      var tok = cm[1].trim();
      if (METHODS.indexOf(tok.toUpperCase()) >= 0) {
        eps.push({ method: tok.toUpperCase(), path: p, line: line, docFile: rel, section: '', compound: true });
      } else if (tok.charAt(0) === '/') {
        var base = p.replace(/\/[^/]*$/, '');
        eps.push({ method: method, path: stripTrailingPunct(base + tok), line: line, docFile: rel, section: '', compound: true });
      }
    }
  }
  // fallback: non-backtick headings (rare)
  HEAD_RE_NOBT.lastIndex = 0;
  while ((m = HEAD_RE_NOBT.exec(text))) {
    var pp = stripTrailingPunct(m[2].trim());
    if (!eps.some(function (e) { return e.method === m[1] && e.path === pp; })) {
      eps.push({ method: m[1], path: pp, line: lineOf(text, m.index), docFile: rel, section: sectionAt(text, m.index) });
    }
  }

  // table-row endpoints (admin / monitoring document their surface as a table)
  TABLE_RE.lastIndex = 0;
  while ((m = TABLE_RE.exec(text))) {
    var tp = stripTrailingPunct(m[2].trim());
    if (!eps.some(function (e) { return e.method === m[1] && e.path === tp; })) {
      eps.push({ method: m[1], path: tp, line: lineOf(text, m.index), docFile: rel, section: '' });
    }
  }

  var retired = /\(retired\)/i.test(fmTitle) || (eps.length === 0 && /retired|stub/i.test(text));
  return { eps: eps, retired: retired, title: fmTitle, claimsOpen: docSaysOpen(text) };
}

function stripTrailingPunct(p) { return p.replace(/[\s.,:;]+$/, '').replace(/\?.*$/, ''); }
function sectionAt(text, headIdx) {
  var nl = text.indexOf('\n', headIdx);
  var next = text.indexOf('\n## ', nl < 0 ? headIdx : nl);
  return text.slice(headIdx, next < 0 ? Math.min(text.length, headIdx + 1200) : next);
}

/* ── code side — module → docs/api/<module>.md expectation ────────────────── */
function resourceOf(apiPath) { var seg = apiPath.split('/'); return seg[2] || ''; }

/* ── auth heuristic (conservative — only the high-signal understatement) ──── */
function docSaysOpen(section) {
  // Strong "this endpoint is open" phrases only. NOT `unauthenticated`/`anonymous`
  // — those legitimately appear in 401 error tables, so matching them would
  // false-flag a correctly-gated doc that merely documents its 401.
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

// doc set
var docByNorm = {};
var docFiles = [];
// Skip index.md — that's the section landing + the GENERATED route table
// (table rows, not per-resource `## METHOD /api/path` headings), not a module doc.
try { docFiles = fs.readdirSync(DOCS_API).filter(function (f) { return /\.md$/.test(f) && f !== 'index.md'; }); } catch (e) {}
var retiredFiles = [];
var docMeta = {}; // docFile rel → { claimsOpen, gated:0 }
docFiles.forEach(function (f) {
  var rel = 'docs/internal/rest-api/' + f;
  var parsed = parseDocFile(rel, read(path.join(DOCS_API, f)) || '');
  docMeta[rel] = { claimsOpen: parsed.claimsOpen, gated: 0, line: 1 };
  if (parsed.retired) retiredFiles.push(f.replace(/\.md$/, ''));
  parsed.eps.forEach(function (ep) {
    var n = norm(ep.path);
    var e = docByNorm[n] || (docByNorm[n] = { methods: {}, raw: ep.path, docFile: ep.docFile, line: ep.line, section: ep.section });
    e.methods[ep.method] = ep;
  });
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
        'Route served but no docs/api heading documents it.',
        { path: r.path, method: method, file: r.file, line: r.line });
    } else if (!d.methods[method]) {
      add('method_mismatch', 'med',
        method + ' ' + r.path,
        'Code serves ' + method + ' ' + r.path + ' but the doc for this path documents only [' + Object.keys(d.methods).join(', ') + '].',
        { path: r.path, method: method, file: r.file, line: r.line, docFile: d.docFile });
    }
  });
});

// 2. doc → code : stale_doc_endpoint / method_mismatch / param mismatch / auth
Object.keys(docByNorm).forEach(function (n) {
  var d = docByNorm[n];
  var c = codeByNorm[n];
  Object.keys(d.methods).forEach(function (method) {
    var ep = d.methods[method];
    if (!c) {
      if (retiredFiles.indexOf(resourceOf(ep.path)) >= 0) return; // retired stub page
      add('stale_doc_endpoint', 'med',
        method + ' ' + ep.path,
        'Doc documents ' + method + ' ' + ep.path + ' but no route serves this path.',
        { path: ep.path, method: method, docFile: ep.docFile, line: ep.line });
    } else if (!c.methods[method]) {
      add('method_mismatch', 'med',
        method + ' ' + ep.path,
        'Doc documents ' + method + ' ' + ep.path + ' but code serves only [' + Object.keys(c.methods).join(', ') + '] there.',
        { path: ep.path, method: method, docFile: ep.docFile, line: ep.line });
    }
  });
  // param-name diff (same normalised path, raw segments differ)
  if (c) {
    var pm = paramMismatch(c.raw, d.raw);
    if (pm) {
      add('path_param_mismatch', 'low',
        d.raw + ' ≠ ' + c.raw,
        'Doc path param name(s) ' + pm.doc + ' differ from code ' + pm.code + ' (same route).',
        { path: c.raw, docFile: d.docFile, line: d.line });
    }
    // tally gated routes per doc file for the file-level auth check below
    if (c.rbac && c.rbac.hint === 'platform_admin' && docMeta[d.docFile]) docMeta[d.docFile].gated++;
  }
});

// 2b. auth_mismatch (file-level): a doc whose routes are platform-admin-gated in
// code but whose prose describes access as public/open — RBAC has landed, doc
// hasn't caught up. One finding per doc file, not per endpoint.
Object.keys(docMeta).forEach(function (rel) {
  var meta = docMeta[rel];
  if (meta.claimsOpen && meta.gated > 0) {
    add('auth_mismatch', 'high', 'auth ' + rel,
      meta.gated + ' route(s) documented in ' + rel + ' are platform-admin-gated in code (nest .layer), but the doc describes access as public/open.',
      { path: '/' + rel, docFile: rel, line: 1 });
  }
});

// 3. doc_missing : a code resource module with no docs/api/<module>.md
var resources = {};
code.forEach(function (r) { resources[resourceOf(r.path)] = true; });
Object.keys(resources).sort().forEach(function (res) {
  if (!res) return;
  if (!fs.existsSync(path.join(DOCS_API, res + '.md'))) {
    add('doc_missing', 'med', res, 'Route module /api/' + res + '/* has no docs/internal/rest-api/' + res + '.md page.', { path: '/api/' + res });
  }
});

// 4. schema field-name parity : doc jsonc blocks ↔ request/response struct fields.
// Conservative — skips whenever a type or block can't be confidently resolved,
// and only flags REQUIRED struct fields as missing (optional/Option<> fields are
// legitimately omitted from examples).
Object.keys(docByNorm).forEach(function (n) {
  var c = codeByNorm[n]; var d = docByNorm[n];
  if (!c) return;
  Object.keys(d.methods).forEach(function (method) {
    var cr = c.methods[method], ep = d.methods[method];
    if (!cr || !ep || !ep.section) return;
    var blocks = jsoncBlocks(ep.section);
    if (!blocks.length) return;
    var localText = routesLib.moduleTextForFile(ROOT, cr.file); // module-scoped struct resolution
    // request body
    if (cr.reqType) {
      var rb = blocks.filter(function (b) { return b.kind === 'request'; })[0];
      var rf = routesLib.dtoFields(ROOT, cr.reqType, localText);
      if (rb && rf && !rf.listElem) schemaDiff('request', method, cr.raw || cr.path, ep, (rb.keys[1] || []), rf);
    }
    // response body (unwrap a list element when present)
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

// 5. secondary surfaces — REDMAP "API quick reference" + per-object rows,
// internal/subsystems/api-routes.md, and docs/INDEX.md's API-section links.
// These are navigation/summary docs (intentionally not exhaustive), so the
// valuable checks are STALE entries (a listed path no route serves) + INDEX
// link integrity — not exhaustive per-endpoint coverage.
var codeNormSet = {}, codeNormList = [];
code.forEach(function (r) { if (!codeNormSet[r.pathNorm]) { codeNormSet[r.pathNorm] = true; codeNormList.push(r.pathNorm); } });
// a doc path is a nest-PREFIX reference (not stale) when some real route lives
// under it, e.g. `/api/auth` covering /api/auth/google/start.
function isPrefixOfRoute(n) { return codeNormList.some(function (c) { return c.indexOf(n + '/') === 0; }); }

[['docs/REDMAP.md', 'REDMAP'], ['docs/internal/subsystems/api-routes.md', 'api-routes.md']].forEach(function (surf) {
  var text = read(path.join(ROOT, surf[0]));
  if (text == null) return;
  extractApiPaths(text).forEach(function (raw) {
    if (raw.indexOf('*') >= 0) return;        // wildcard/glob summary notation
    var n = norm(raw);
    if (!codeNormSet[n] && !isPrefixOfRoute(n) && !ackMatch(acks.stale_doc_endpoint, raw)) {
      add('index_link_drift', 'med', surf[1] + ' ' + raw,
        surf[1] + ' lists `' + raw + '` but no route serves it (stale entry).',
        { path: raw, docFile: surf[0] });
    }
  });
});

// INDEX.md API-section link integrity
var indexText = read(path.join(ROOT, 'docs', 'INDEX.md'));
if (indexText != null) {
  var linked = {}, lm, lre = /\(api\/([a-z0-9_-]+)\.md\)/g;
  while ((lm = lre.exec(indexText))) linked[lm[1]] = true;
  docFiles.forEach(function (f) {
    var slug = f.replace(/\.md$/, '');
    if (slug === 'overview') return;
    var isRetired = retiredFiles.indexOf(slug) >= 0;
    if (!linked[slug] && !isRetired) {
      add('index_link_drift', 'low', 'INDEX omits api/' + slug,
        'docs/INDEX.md API section does not link the existing docs/api/' + slug + '.md page.',
        { path: '/api/' + slug, docFile: 'docs/INDEX.md' });
    } else if (linked[slug] && isRetired) {
      add('index_link_drift', 'low', 'INDEX links retired api/' + slug,
        'docs/INDEX.md links docs/api/' + slug + '.md, which is a retired stub.',
        { path: '/api/' + slug, docFile: 'docs/INDEX.md' });
    }
  });
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

// audit.json (DB-ingest shape — stable keys; ingestion wired in Step 5)
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

// Exit 0 on a successful run (the audit-suite convention — audit.sh treats a
// non-zero exit as a crashed tool). Regression gating is ci-audit's job via
// audit.run_diff once findings are DB-ingested (Step 5), not this exit code.
process.exit(0);

/* ── helpers ─────────────────────────────────────────────────────────────── */
function mutating(method) { return method !== 'GET'; }

/* backtick-wrapped `/api/…` paths in a summary doc (REDMAP table / api-routes).
   Skips brace-expansion shorthand (`/api/files/:rid/{steps,undo}`) and anything
   with whitespace/commas — only clean single paths, to avoid false "stale". */
function extractApiPaths(text) {
  var out = {}, re = /`(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/api\/[^`]+)`/g, m;
  while ((m = re.exec(text))) {
    var p = m[1].trim().replace(/\?.*$/, '');
    if (/[{}\s,]/.test(p)) continue;          // shorthand / prose — skip
    if (!/^\/api\/[A-Za-z0-9_:*\/.-]+$/.test(p)) continue;
    out[p] = true;
  }
  return Object.keys(out);
}

/* fenced ```jsonc / ```json blocks in a doc section, classified request vs
   response by their first line (a `200 OK`-style status → response; a
   `POST /api/…` method line → request), with keys grouped by object depth. */
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
/* JSON object keys grouped by enclosing-object depth (1 = root object,
   2 = an object nested one level down, e.g. inside an `items:[…]` array).
   String-aware: line + block comments are skipped only OUTSIDE strings, so a
   `"https://…"` value (whose `//` is inside the string) doesn't truncate it. */
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
/* diff a doc block's keys against a struct's wire fields. Emits:
     schema_field_undocumented   — doc key with no matching struct field
     schema_field_missing_in_doc — REQUIRED struct field absent from the block */
function schemaDiff(kind, method, rawPath, ep, docKeys, struct) {
  if (!docKeys.length || !struct.fields.length) return; // nothing to compare with confidence
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
    '<header><h1>API-doc audit <span class="muted">· docs/api ↔ axum routes</span></h1>',
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
  "var kinds=['undocumented_endpoint','stale_doc_endpoint','method_mismatch','path_param_mismatch','auth_mismatch','doc_missing'];",
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
