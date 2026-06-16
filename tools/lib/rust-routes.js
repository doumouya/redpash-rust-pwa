/* Purpose: shared Rust axum route extractor — dir-modules, depth-N nests, HTTP methods, generic nest-gates.
   Doc: docs/internal/code/backend/api-routes.md (the route catalog this parses against). */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash shared route extractor — the single code-side API surface parser
   ---------------------------------------------------------------------------
   The js-rust-boundary contract crosses at /api routes + shared DTOs. Tools
   that need the *code-side* route set consume this lib (api-doc-audit today;
   crossing- / list-endpoint-rbac-audit when ported), so the extraction logic
   lives in exactly one place (a fix lands for every consumer at once).

   LEAN LAYOUT (adapted from the prerelease tree): route modules are FLAT files
   directly under `backend/crates/api/src/` (auth.rs, me.rs, …) — there is no
   `routes/` subdirectory — and the top-level router is assembled in `main.rs`,
   not `routes/mod.rs`. `files` is the one DIRECTORY module (`files/mod.rs`).
   `main.rs` mounts `.route("/health", …)` directly plus a `.nest("/<prefix>",
   <mod>::routes())` per module; the whole set hangs off `.nest("/api", …)`,
   so every served path is `/api/<prefix>/…` (and `/api/health`).

   What it does:
     • Roots at main.rs as the API entry: emits its direct `.route()`s (today
       `/api/health`) AND descends each `.nest("/p", mod::routes())`.
     • Resolves FLAT modules `<mod>.rs` and the DIRECTORY module `files/mod.rs`.
     • Recurses `.nest()` to arbitrary depth (none today, but kept generic).
     • Captures the HTTP method(s) per `.route("/p", get(h).post(h2))`.
     • Detects a platform-admin nest gate GENERICALLY on any `.nest()` whose
       paren-matched span carries a GATE_MW `.layer(...)`. In the lean cut the
       admin gate is IN-HANDLER (`caller.is_platform_admin`), not a nest layer,
       so this fires for nothing today — by design, no false nest-gate flags.
       Add the mw name here if a nest-layer gate ever lands.

   Returns one record per (method, path):
     { method, path (raw, e.g. /api/files/:rid/steps/preview),
       pathNorm (params → :_), file, line, handler,
       rbac: { source: 'nest-layer'|'handler', hint: 'platform_admin'|null } }

   Heuristic — regex over Rust source text (no AST dep, matching the audit
   suite + the no-frameworks rule). Read the route file to confirm a hit.

   Usage:  var { rustRoutes, norm, stripQuery } = require('../lib/rust-routes');
           var routes = rustRoutes(repoRoot);
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

/* Middleware names that, when chained as a `.layer(...)` onto a nest, gate the
   whole subtree. The lean cut gates admin IN-HANDLER, so there is no such
   middleware today — list it here if a nest-layer gate is ever introduced. */
var GATE_MW = [];

/* Lean: route modules are flat under src/ (no routes/ subdir). */
var ROUTES_REL = 'backend/crates/api/src';
/* The API router is assembled in main.rs (prerelease used routes/mod.rs). */
var ENTRY_REL = 'backend/crates/api/src/main.rs';

function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

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

function lineOf(text, idx) {
  var n = 1;
  for (var i = 0; i < idx && i < text.length; i++) if (text.charAt(i) === '\n') n++;
  return n;
}

/* drop the ?query — depth-aware so a `${a ? b : c}` ternary inside a JS path
   isn't mistaken for the query separator (shared with crossing-audit). */
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
   slash dropped. (shared with crossing-audit) */
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

/* join a parent prefix with a relative .route()/.nest() path literal. Collapses
   double slashes, drops the trailing slash a bare "/" route would leave. */
function joinPath(a, b) {
  var p = (a + b).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

/* the source file backing a route module: flat `<mod>.rs`, else the directory
   module's `<mod>/mod.rs` (where the dir module registers all its .route()s).
   Lean: modules live directly under src/, so `rel` is the bare module path. */
function moduleFile(routesDir, mod) {
  var flat = path.join(routesDir, mod + '.rs');
  if (fs.existsSync(flat)) return { abs: flat, rel: mod + '.rs' };
  var dirMod = path.join(routesDir, mod, 'mod.rs');
  if (fs.existsSync(dirMod)) return { abs: dirMod, rel: mod + '/mod.rs' };
  return null;
}

/* the method verbs chained in a `.route("/p", <chain>)` handler expression.
   `\b` anchors so axum::routing::patch(...) matches the same as patch(...). */
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

/* ── DTO / handler signature resolution (for schema field-name parity) ─────── */

/* the searchable source of a module: its own file + (for dir modules) every
   sibling .rs — handlers referenced as `state_ops::step_preview` in files/mod.rs
   are defined in files/state_ops.rs, so signature lookup needs the whole dir. */
function moduleSearchText(routesDir, mod) {
  var flat = path.join(routesDir, mod + '.rs');
  if (fs.existsSync(flat)) return strip(read(flat) || '');
  var dir = path.join(routesDir, mod);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    var parts = [];
    fs.readdirSync(dir).forEach(function (f) { if (/\.rs$/.test(f)) parts.push(strip(read(path.join(dir, f)) || '')); });
    return parts.join('\n');
  }
  return '';
}

/* given a handler name (bare or `mod::fn`) and the module search text, pull the
   request body type (Json<T> param) and response type (Json<U> in the Ok arm). */
function handlerTypes(searchText, handler) {
  if (!handler) return { reqType: null, respType: null };
  var bare = handler.split('::').pop();
  var fnRe = new RegExp('async\\s+fn\\s+' + bare + '\\s*\\(', 'g');
  var fm = fnRe.exec(searchText);
  if (!fm) return { reqType: null, respType: null };
  // signature spans from the param `(` to the body `{`
  var pOpen = searchText.indexOf('(', fm.index);
  var pClose = matchParens(searchText, pOpen);
  if (pClose < 0) return { reqType: null, respType: null };
  var params = searchText.slice(pOpen + 1, pClose);
  var bodyBrace = searchText.indexOf('{', pClose);
  var ret = bodyBrace > pClose ? searchText.slice(pClose + 1, bodyBrace) : '';

  var reqM = params.match(/Json\s*<\s*([A-Za-z_][\w:]*)\s*>/);
  // response: the Json<…> inside Result<…, AppError> (handles (StatusCode, Json<U>))
  var respM = ret.match(/Json\s*<\s*([A-Za-z_][\w:]*)\s*>/);
  return {
    reqType: reqM ? reqM[1].split('::').pop() : null,
    respType: respM ? respM[1].split('::').pop() : null
  };
}

var SHARED_DIR_REL = 'backend/crates/shared/src';
var _sharedIdx = null;

/* index every `struct Name { … }` in one source text into `map`. Last writer
   wins is avoided (`if (!map[name])`) so within a scope the first def holds. */
function indexStructs(s, map) {
  var re = /(?:#\[serde\(([^)]*)\)\]\s*)?(?:pub\s+)?struct\s+([A-Za-z_]\w*)\s*\{/g, m;
  while ((m = re.exec(s))) {
    var attr = m[1] || '', name = m[2];
    var open = s.indexOf('{', m.index);
    var close = matchBraces(s, open);
    if (close < 0) continue;
    if (!map[name]) map[name] = { renameAll: (attr.match(/rename_all\s*=\s*"([^"]+)"/) || [])[1] || null,
                                   body: s.slice(open + 1, close) };
  }
}

/* shared-crate structs (UserProfile, ProjectSummary, Company, …) — no name
   collisions there, so a single cached index is safe. */
function sharedStructIndex(root) {
  if (_sharedIdx && _sharedIdx.root === root) return _sharedIdx.map;
  var map = {};
  (function walk(d) {
    var ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      var full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.rs$/.test(e.name)) indexStructs(strip(read(full) || ''), map);
    });
  })(path.join(root, SHARED_DIR_REL));
  _sharedIdx = { root: root, map: map };
  return map;
}

/* the module search text backing a route file (me.rs → me module; files/mod.rs
   → the whole files/ dir). Local request/response structs are defined here —
   resolved BEFORE the shared crate so a name shared across modules (e.g. two
   different `PatchBody`s) picks the handler's own one. The legacy `routes/`
   prefix strip is a harmless no-op on lean's bare module paths. */
function moduleTextForFile(root, fileRel) {
  if (!fileRel) return '';
  var mod = String(fileRel).replace(/^routes\//, '').replace(/\/mod\.rs$/, '').replace(/\.rs$/, '').split('/')[0];
  return moduleSearchText(path.join(root, ROUTES_REL), mod);
}
function matchBraces(s, openIdx) {
  if (s.charAt(openIdx) !== '{') return -1;
  var d = 1, i = openIdx + 1;
  while (i < s.length && d > 0) { var c = s.charAt(i); if (c === '{') d++; else if (c === '}') d--; if (d === 0) return i; i++; }
  return -1;
}
function applyRenameAll(name, conv) {
  if (!conv) return name;
  if (conv === 'camelCase') return name.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
  if (conv === 'snake_case') return name;
  if (conv === 'SCREAMING_SNAKE_CASE') return name.toUpperCase();
  if (conv === 'kebab-case') return name.replace(/_/g, '-');
  if (conv === 'PascalCase') { var c = name.replace(/_([a-z])/g, function (_, x) { return x.toUpperCase(); }); return c.charAt(0).toUpperCase() + c.slice(1); }
  return name;
}

/* resolve a type name to its wire field set. Returns:
     { fields:[wireName…], listElem:<TypeName>|null }  or null when unresolvable.
   Honors #[serde(rename)], struct #[serde(rename_all)], #[serde(flatten)]
   (one level), and detects the `{ items: Vec<Elem> }` list-wrapper.
   Conservative: returns null rather than guess when a type isn't found. */
function dtoFields(root, typeName, localText, _seen) {
  if (!typeName) return null;
  var local = localText ? {} : null;
  if (local) indexStructs(localText, local);
  var st = (local && local[typeName]) || sharedStructIndex(root)[typeName];
  if (!st) return null;
  _seen = _seen || {};
  if (_seen[typeName]) return { fields: [], listElem: null };
  _seen[typeName] = 1;

  // list-wrapper:  pub items: Vec<Elem>   (single data field)
  var lw = st.body.match(/items\s*:\s*Vec\s*<\s*([A-Za-z_][\w:]*)\s*>/);
  var dataFields = st.body.match(/^\s*(?:pub\s+)?[a-z_]\w*\s*:/gm) || [];
  if (lw && dataFields.length === 1) return { fields: ['items'], optional: {}, listElem: lw[1].split('::').pop() };

  var fields = [], optional = {};
  // field lines, capturing an optional #[serde(...)] attr immediately above
  var fre = /(?:#\[serde\(([^)]*)\)\]\s*)?(?:pub\s+)?([a-z_]\w*)\s*:\s*([^,\n]+)/g, fm;
  while ((fm = fre.exec(st.body))) {
    var attr = fm[1] || '', fname = fm[2], ftype = fm[3];
    if (/\bskip\b/.test(attr)) continue;
    if (/\bflatten\b/.test(attr)) {
      var inner = (ftype.match(/([A-Za-z_][\w:]*)/) || [])[1];
      var sub = inner ? dtoFields(root, inner.split('::').pop(), localText, _seen) : null;
      if (sub) sub.fields.forEach(function (x) { fields.push(x); if (sub.optional[x]) optional[x] = true; });
      continue;
    }
    var ren = attr.match(/rename\s*=\s*"([^"]+)"/);
    var wire = ren ? ren[1] : applyRenameAll(fname, st.renameAll);
    fields.push(wire);
    if (/^\s*Option\s*</.test(ftype) || /\bdefault\b/.test(attr)) optional[wire] = true;
  }
  return { fields: fields, optional: optional, listElem: null };
}

/* parse routes/mod.rs top-level `.nest("<prefix>", <mod>::routes()...)` calls,
   paren-matched so a multi-line `.layer(require_platform_admin_mw)` chained
   onto the nest is captured. (absorbs list-endpoint-rbac-audit::parseNestGates) */
function parseTopNests(modStripped, modRaw) {
  var nests = [], re = /\.nest\s*\(/g, m;
  while ((m = re.exec(modStripped))) {
    var open = modStripped.indexOf('(', m.index);
    var close = matchParens(modStripped, open);
    if (close < 0) { re.lastIndex = m.index + 5; continue; }
    var span = modStripped.slice(open + 1, close);
    var pfx = span.match(/"(\/[^"]*)"/);
    var mod = span.match(/(?:super::)?([a-z_]+)\s*::\s*routes\s*\(/);
    if (pfx && mod) {
      var gateMw = null;
      for (var g = 0; g < GATE_MW.length; g++) {
        if (span.indexOf(GATE_MW[g]) >= 0) { gateMw = GATE_MW[g]; break; }
      }
      nests.push({ prefix: pfx[1], module: mod[1], gated: !!gateMw,
                   gateMw: gateMw, line: lineOf(modRaw, m.index) });
    }
    re.lastIndex = close;
  }
  return nests;
}

/* recurse a module file: emit its .route()s under `prefix`, then descend into
   any `.nest("/sub", child::routes())` it declares, carrying prefix + gate. */
function extractModule(routesDir, mod, prefix, rbac, out, visited, depth) {
  if (depth > 8) return;
  var key = mod + '@' + prefix;
  if (visited.has(key)) return;
  visited.add(key);

  var mf = moduleFile(routesDir, mod);
  if (!mf) return;
  var raw = read(mf.abs);
  if (raw == null) return;
  var s = strip(raw);
  var searchText = moduleSearchText(routesDir, mod); // file + dir siblings, for handler sigs

  // .route("/p", get(h).post(h2)) — one path, one-or-more methods.
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
    collectMethods(chain).forEach(function (method) {
      var handler = handlerFor(chain, method);
      var types = handlerTypes(searchText, handler);
      out.push({
        method: method,
        path: full,
        pathNorm: norm(full),
        file: mf.rel,
        line: line,
        handler: handler,
        reqType: types.reqType,
        respType: types.respType,
        rbac: { source: rbac.source, hint: rbac.hint }
      });
    });
    rRe.lastIndex = close;
  }

  // .nest("/sub", child::routes()) — descend, inheriting the parent gate.
  var nRe = /\.nest\s*\(/g, n;
  while ((n = nRe.exec(s))) {
    var nopen = s.indexOf('(', n.index);
    var nclose = matchParens(s, nopen);
    if (nclose < 0) { nRe.lastIndex = n.index + 5; continue; }
    var nspan = s.slice(nopen + 1, nclose);
    var sub = nspan.match(/^\s*"([^"]*)"/);
    var child = nspan.match(/(?:super::)?([a-z_]+)\s*::\s*routes\s*\(/);
    if (sub && child) {
      var childGated = rbac.gated;
      for (var g = 0; g < GATE_MW.length; g++) {
        if (nspan.indexOf(GATE_MW[g]) >= 0) { childGated = true; break; }
      }
      var childRbac = childGated
        ? { source: 'nest-layer', hint: 'platform_admin', gated: true }
        : { source: 'handler', hint: null, gated: false };
      extractModule(routesDir, child[1], joinPath(prefix, sub[1]), childRbac, out, visited, depth + 1);
    }
    nRe.lastIndex = nclose;
  }
}

/* MAIN — every /api route the backend serves, with method + gate.
   Lean: main.rs is the API entry. The api_router is built there with the
   /health route + a `.nest("/<prefix>", <mod>::routes())` per module, all
   mounted under `.nest("/api", api_router)`. We root extractModule at main.rs
   under the `/api` prefix: its direct `.route("/health", …)` becomes
   /api/health, and each module nest descends to /api/<prefix>/…. The outer
   `.nest("/api", api_router)` line is skipped (api_router is a variable, not a
   `<mod>::routes()` call, so the child regex never matches it). */
function rustRoutes(root) {
  var routesDir = path.join(root, ROUTES_REL);
  var entry = path.join(root, ENTRY_REL);
  if (!fs.existsSync(entry)) throw new Error('API entry not found: ' + entry);

  var out = [];
  var visited = new Set();
  // The entry "module" is main.rs (resolved by moduleFile as the flat
  // `main.rs`); prefix `/api`; ungated root.
  extractModule(routesDir, 'main', '/api',
    { source: 'handler', hint: null, gated: false }, out, visited, 0);

  // dedupe by (method, raw path) — a child module nested under the same prefix
  // twice would otherwise double-count; distinct parents stay distinct.
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

module.exports = { rustRoutes: rustRoutes, norm: norm, stripQuery: stripQuery,
                   dtoFields: dtoFields, moduleTextForFile: moduleTextForFile, GATE_MW: GATE_MW,
                   _internals: { strip: strip, matchParens: matchParens, lineOf: lineOf,
                   parseTopNests: parseTopNests, moduleFile: moduleFile, handlerTypes: handlerTypes } };

/* CLI: `node tools/lib/rust-routes.js [repoRoot]` dumps the route table. */
if (require.main === module) {
  var root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', '..');
  var routes = rustRoutes(root);
  console.log(routes.length + ' routes\n');
  routes.forEach(function (r) {
    var gate = r.rbac.hint ? '  [' + r.rbac.hint + ']' : '';
    console.log('  ' + r.method.padEnd(6) + r.path + gate + '   (' + r.file + ':' + r.line + ')');
  });
}
