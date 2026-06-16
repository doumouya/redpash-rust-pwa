#!/usr/bin/env node
/* Purpose: backend route auth-posture + ownership-hygiene scanner.
 * Doc: docs/internal/code/backend/auth-audit.md (lean tree) */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash auth-audit — ownership-hygiene scanner  (LEAN-adapted)

   Em-greenlit RBAC prep (Torv → Gus, Internal-Slack 2026-05-24): a
   mechanical regression net for ownership hygiene. RBAC on a leaky
   surface = leaky RBAC.

   Walks every backend route handler. For each handler that path-
   extracts a resource id, checks a reach gate appears before any
   db::* mutation OR Json(...) return. For each mutation handler,
   checks that event::record fires for the audit trail. Flags the
   misses; counts the healthy uses for trend.

   ── LEAN ADAPTATIONS (vs prerelease) ────────────────────────────────────
   The lean cut DOES NOT use the prerelease ownership model
   (ensure_owner / require_member / company_role / users_share_company).
   Lean's auth model is:
     • `Caller` — an axum FromRequestParts extractor; its presence in a
       handler's params means the request is session-authenticated
       ("extraction IS the gate", types.rs).
     • per-resource reach gates live in rbac.rs:
         rbac::require_action(.., rid, Action::View|Edit|..)
         rbac::require_view(..)
         rbac::require_rule(.., rid, |g| ..)   ← objects.rs::create's
                                                  IDOR guard on scope_parent_id
   So Cat-1's gate recognizer keys on the rbac::require_* family, NOT
   ensure_owner. Cat-4's reach gate additionally recognizes require_rule
   (lean's name; prerelease used require_grant) so objects.rs::create
   stays green.

   Layout: lean has NO crates/api/src/routes/ subdir — handlers live
   flat under crates/api/src/*.rs plus crates/api/src/files/. The scan
   walks crates/api/src recursively.

   Three pattern categories:

   1. **Route-level reach** — every handler with Path(rid):
      must call an rbac::require_* reach gate before writing or
      returning that resource's data. Cat-1 flag = potential leak.

   2. **Cross-resource transitive** — DEFERRED to v2 (needs a curated
      catalog first).

   3. **Audit-trail completeness** — every mutation handler should
      emit event::record / event::info|warn|error. Cat-3 flag =
      audit-gap (silent mutation).

   4. **scope_parent_id / parent injection (IDOR)** — handler reads a
      caller-supplied parent/scope id from the body AND binds it into a
      DB write WITHOUT a reach check on that id.

   Heuristic, not a parser — brace-counting + regex on the raw text,
   like rs-audit. Good enough to point at the work; read the code
   to confirm a hit.

   Usage:  node audit.js [backendDir]
   Output: ./report.html  +  ./audit.json  +  console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var SRC_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '..', 'backend');
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
  // Handlers in lean's flat crates/api/src/*.rs are typically `async fn`
  // (module-private); the pub variant appears for cross-module helpers.
  // Match both shapes.
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
   don't (and shouldn't) call a reach gate — admin-scoped surfaces,
   read-only globals, intentionally dev-permissive handlers. The
   annotation text gets captured for the report so reviewers see WHY
   it's acknowledged, not just THAT it is. */
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
   on Path<i64> or Path<MyTuple> are acceptable for v1. */
function extractsRid(params) {
  return /\bPath\s*\(\s*(?:\(.*?\)|\w+)\s*\)/.test(params);
}

/* Has a per-resource reach gate somewhere in the body. LEAN gate set —
   the rbac::require_* family from crates/api/src/rbac.rs:
     - require_action — coarse Action::{View,Edit,..} reach gate, the
       most common per-resource gate (objects/projects/group/settings).
     - require_view — read-reach gate.
     - require_rule — predicate reach gate (used for the scope_parent_id
       IDOR guard in objects.rs::create).
   The legacy `require_grant` name is kept too (prerelease vocabulary)
   so the gate recognizer is forward/backward compatible. Qualified by
   rbac::, crate::rbac::, super::, or bare. Add the next gate here when
   it lands. */
function callsOwnershipGate(body) {
  return /\b(?:crate::)?rbac::(?:require_action|require_view|require_rule|require_grant)\s*\(/.test(body)
      || /\b(?:super::)?(?:require_action|require_view|require_rule|require_grant)\s*\(/.test(body);
}

/* Mutates the DB. Either calls db::insert_/update_/delete_ OR
   returns a 2xx-with-side-effect status. Also catches the lean
   `db::register_entity` / `db::grant_owner` mutation helpers and
   raw `sqlx::query("INSERT|UPDATE|DELETE …")` writes. */
function isMutation(body) {
  if (/\bdb::(insert|update|delete|patch|create|set|add|remove|record|persist|store|register|grant|revoke)_?\w*\s*\(/.test(body)) return true;
  if (/\bsqlx::query(?:_as|_scalar)?\s*\(\s*"?\s*(?:INSERT|UPDATE|DELETE)\b/i.test(body)) return true;
  if (/StatusCode::CREATED\b/.test(body))      return true;
  if (/StatusCode::NO_CONTENT\b/.test(body))   return true;
  return false;
}

/* Has an event-emit call (the audit-trail emit). Recognizes both
   the raw `event::record(EventDraft {...})` shape and the ergonomic
   builder shape lean uses: `event::info|warn|error(db, kind, msg, ..)`.
   Per-handler check — either form satisfies the audit-trail
   requirement. */
function callsEventRecord(body) {
  return /\b(?:crate::)?event::(?:record|info|warn|error)\s*\(/.test(body);
}

/* ── Cat-4: unchecked scope_parent_id / parent binds (IDOR class) ─────────────
   The IDOR class objects.rs::create fixed: a handler reads a caller-supplied
   parent/scope id from the request body AND binds it into a DB write WITHOUT a
   reach check on that id. Three predicates, all over the comment/string-
   stripped handler body (params for the destructure shape). v1 field-name set
   is narrow on purpose — `/\b(scope_parent|parent)_id\b/` only — so
   `project_id`/`owner_id`/`source_file_id`/`rid` (legitimately bound after
   their own checks) do NOT flood the report. Broaden later in response to a
   finding, not pre-emptively. */

/* (1) Reads a caller-supplied parent/scope id. True if the body or params
   carries a `scope_parent_id` / `…parent_id` token. */
function readsScopeParent(params, body) {
  var text = String(params || '') + '\n' + String(body || '');
  return /\b(?:scope_parent|parent)_id\b/.test(text);
}

/* (2) Binds that value into a DB write. True if the body has an INSERT/UPDATE
   SQL string AND a `.bind(` referencing the parent field, OR the parent field
   is passed to a `db::(insert|update|create|register)_…` / `register_entity`
   mutation call. The `.bind` arm requires BOTH the write keyword and a parent-
   bound argument so a read-only handler (no INSERT/UPDATE) never matches. */
function bindsParentToWrite(body) {
  var b = String(body || '');
  var hasWriteSql = /\b(?:INSERT|UPDATE)\b/i.test(b);
  var bindsParent = /\.bind\(\s*&?\s*(?:body\.)?\w*(?:scope_parent|parent)_id\b/.test(b);
  if (hasWriteSql && bindsParent) return true;
  // db::*_ / register_entity mutation that carries a parent field as an arg.
  var dbCall = /\bdb::(?:insert|update|create|register)_\w+\s*\([^;]*\b(?:scope_parent|parent)_id\b/.test(b)
            || /\bregister_entity\s*\([^;]*\b(?:scope_parent|parent)_id\b/.test(b);
  return dbCall;
}

/* (3) Has a reach check on the bound id. SEPARATE recognizer from Cat-1's
   callsOwnershipGate — keeping the gate sets distinct is what makes
   objects.rs::create green here. Matches the RBAC reach gates —
   require_rule (lean) / require_grant (prerelease) / require_view /
   require_action — qualified by rbac::, crate::rbac::, super::, or bare. */
function callsReachGate(body) {
  var b = String(body || '');
  return /\b(?:crate::)?rbac::(?:require_grant|require_rule|require_view|require_action)\s*\(/.test(b)
      || /\b(?:super::)?(?:require_grant|require_rule|require_view|require_action)\s*\(/.test(b);
}

/* Files whose handlers don't carry per-resource ownership by design.
   These get a relaxed Cat-1 check — handlers can extract Path(rid)
   without a reach gate if the resource is public, admin-scoped, or
   session-scoped via the Caller extractor alone. Lean flat layout
   (no routes/ prefix). Curated; expand when a new public-surface
   file lands. */
var PUBLIC_SURFACE_FILES = [
  'crates/api/src/auth.rs',     // login/logout/callback — session establishment
  'crates/api/src/session.rs',  // Caller extractor + cookie parse
  'crates/api/src/me.rs',       // self-scoped — caller IS the resource
  'crates/api/src/types.rs',    // type registry read — any authed caller
  'crates/api/src/rail.rs',     // nav tree — view-name path, not a resource rid
  'crates/api/src/search.rs',   // search over caller-reachable scope
  'crates/api/src/bootstrap.rs',// first-run seeding
];

/* Function names that show up as `(pub) async fn` but are NOT route
   handlers (extractor impls, pure helpers, SQL builders, the gate
   helpers themselves). Skip these — most are also filtered by the
   "must take an axum extractor" heuristic below, but name-listing the
   known ones keeps the inventory clean. LEAN names. */
var HELPER_NAMES = [
  'from_request_parts', // session.rs — the Caller extractor impl
  'read_cookie',        // session.rs / auth.rs — cookie parser
  'require_action',     // rbac.rs — the gate helpers themselves
  'require_view',
  'require_rule',
  'resolve_grant',      // rbac.rs — grant resolver
  'grant_edges',        // rbac.rs — edge loader
  'company_of',         // rbac.rs
  'principals',         // rbac.rs
  'load_contract',      // rbac.rs
  'payload',            // types.rs — pub wire-payload builder (no extractor)
  'workspace_tree_for', // rail.rs — pure tree builder
  'pref_groups',        // rail.rs — pure query helper
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

/* ── exports + main guard ────────────────────────────────────────────────────
   The classifiers are pure (string in, bool/value out) so they're unit-testable
   without running the scan. The whole scan/render/report body below is gated by
   `require.main === module` so `node audit.js` behaves identically, but
   `require('./audit.js')` is side-effect-free — that's what
   tools/auth-audit/test/scope-parent.test.js imports. */
module.exports = { readsScopeParent, bindsParentToWrite, callsReachGate, hasAuthAck };

if (require.main === module) {

console.log('Scanning ' + SRC_DIR + ' …');
// LEAN: handlers live flat under crates/api/src (no routes/ subdir).
var routesDir = path.join(SRC_DIR, 'crates/api/src');
var paths = walk(routesDir, []).sort();
if (!paths.length) { console.error('No .rs files under ' + routesDir); process.exit(1); }

var handlers = [];        // every detected pub async fn — full inventory
var leaks = [];           // cat-1: Path-extract handler missing a reach gate AND no ACK
var acknowledged = [];    // cat-1: missing gate BUT carries AUTH-AUDIT-ACK annotation
var auditGaps = [];       // cat-3: mutation handler missing event::record
var scopeParentLeaks = [];// cat-4: reads caller-supplied parent id, binds to write, no reach gate
var scopeParentAck = [];  // cat-4: same, but carries AUTH-AUDIT-ACK annotation
var ensureOwnerCalls = 0; // count of rbac::require_* reach-gate calls (whole-file)
var eventRecordCalls = 0;

paths.forEach(function (full) {
  var rel = path.relative(SRC_DIR, full).split(path.sep).join('/');
  var text = fs.readFileSync(full, 'utf8');
  var stripped = strip(text);

  // Whole-file occurrence counts (live signal). Counts any of the lean
  // reach gates — same set callsOwnershipGate() recognises.
  var eoMatches = stripped.match(/\b(?:crate::|super::)?rbac::(?:require_action|require_view|require_rule|require_grant)\s*\(|\b(?:super::)?(?:require_action|require_view|require_rule|require_grant)\s*\(/g);
  if (eoMatches) ensureOwnerCalls += eoMatches.length;
  // Counts the event::record sites and the event::info/warn/error
  // builder sites — same audit-trail signal.
  var erMatches = stripped.match(/\b(?:crate::)?event::(?:record|info|warn|error)\s*\(/g);
  if (erMatches) eventRecordCalls += erMatches.length;

  findHandlers(text, stripped).forEach(function (h) {
    if (HELPER_NAMES.indexOf(h.name) >= 0) return;
    // Heuristic: handlers take an axum extractor (State/Path/Json/
    // Query/Multipart/HeaderMap/Caller). Pure helpers / pure computes
    // that don't take an extractor get skipped. Caller is lean's
    // session extractor — its presence means an authed handler.
    if (!/\b(State|Path|Json|Query|Multipart|Form|HeaderMap|Bytes|Caller)\s*[<\(]?/.test(h.params)
        && !/\bCaller\b/.test(h.params)
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
          detail: 'Path-extracted handler without reach gate — acknowledged inline'
        });
      } else {
        leaks.push({
          file: rel, name: h.name,
          kind: 'no-reach-gate',
          detail: 'Path-extracted handler without an rbac::require_* reach gate'
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
    // Cat-4: caller-supplied parent id bound into a write without a reach gate.
    // SEPARATE gate set from Cat-1 (callsReachGate) — require_rule on the
    // parent is what keeps objects.rs::create green here.
    if (readsScopeParent(h.params, h.body)
        && bindsParentToWrite(h.body)
        && !callsReachGate(h.body)) {
      if (ack) {
        scopeParentAck.push({
          file: rel, name: h.name,
          reason: ack,
          detail: 'reads caller-supplied parent id + binds it to a write without a reach gate — acknowledged inline'
        });
      } else {
        scopeParentLeaks.push({
          file: rel, name: h.name,
          kind: 'scope-parent-injection',
          detail: 'reads caller-supplied parent id + binds it to a write without require_rule/require_grant/require_view'
        });
      }
    }
  });
});

var byFileName = function (a, b) { return a.file.localeCompare(b.file) || a.name.localeCompare(b.name); };
handlers.sort(byFileName);
leaks.sort(byFileName);
acknowledged.sort(byFileName);
auditGaps.sort(byFileName);
scopeParentLeaks.sort(byFileName);
scopeParentAck.sort(byFileName);

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
    scopeParentLeaks: scopeParentLeaks.length,
  },
  handlers:         handlers,
  leaks:            leaks,
  acknowledged:     acknowledged,
  auditGaps:        auditGaps,
  scopeParentLeaks: scopeParentLeaks,
  scopeParentAck:   scopeParentAck,
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
    '  <h1>Auth-audit <span class="muted">· RedPash</span></h1>',
    '  <div class="sub" id="sub"></div>',
    '</header>',
    '<section class="cards" id="cards"></section>',
    '<nav class="tabs">',
    '  <button class="tab active" data-tab="leaks">Reach-gate leaks</button>',
    '  <button class="tab" data-tab="scopeparent">Scope-parent leaks</button>',
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
    '<div class="panel hidden" id="panel-scopeparent">',
    '  <div class="toolbar"><span class="count" id="count-scopeparent"></span></div>',
    '  <table id="t-scopeparent"><thead><tr>',
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
  "['reach-gate uses',    D.stats.ensureOwnerCalls, 'ok'],",
  "['event::record uses', D.stats.eventRecordCalls, 'ok'],",
  "['Reach-gate leaks',   D.stats.leaks,            D.stats.leaks?'bad':'ok'],",
  "['Scope-parent leaks', D.stats.scopeParentLeaks, D.stats.scopeParentLeaks?'bad':'ok'],",
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
  "['leaks','scopeparent','acks','audit','handlers'].forEach(function(p){",
  "document.getElementById('panel-'+p).classList.toggle('hidden',p!==t);});});",
  "function renderRows(id,rows,cols){",
  "var tb=document.querySelector('#'+id+' tbody');",
  "if(!rows.length){tb.innerHTML='<tr><td colspan=\"'+cols+'\" class=\"empty\">None.</td></tr>';return;}",
  "tb.innerHTML=rows.map(function(r){return '<tr><td><span class=\"mono\">'+esc(r.file)+'</span></td>'+",
  "'<td><span class=\"mono\">'+esc(r.name)+'</span></td>'+",
  "(cols===3?'<td>'+esc(r.detail||'')+'</td>':'')+'</tr>';}).join('');}",
  "document.getElementById('count-leaks').textContent=D.leaks.length+' leak(s)';",
  "renderRows('t-leaks',D.leaks,3);",
  "document.getElementById('count-scopeparent').textContent=D.scopeParentLeaks.length+' leak(s)';",
  "renderRows('t-scopeparent',D.scopeParentLeaks,3);",
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
console.log('  reach-gate uses    ' + data.stats.ensureOwnerCalls);
console.log('  event::record uses ' + data.stats.eventRecordCalls);
console.log('');
console.log('  reach-gate leaks   ' + data.stats.leaks
  + (data.stats.leaks ? '   ⚠  (Path(rid) handler, no rbac::require_* gate, no ACK)' : '   ✓'));
console.log('  scope-parent leaks ' + data.stats.scopeParentLeaks
  + (data.stats.scopeParentLeaks ? '   ⚠  (caller-supplied parent id bound to write, no reach gate)' : '   ✓'));
console.log('  acknowledged       ' + data.stats.acknowledged
  + (data.stats.acknowledged ? '   ●  (gate skipped + AUTH-AUDIT-ACK present)' : ''));
console.log('  audit-trail gaps   ' + data.stats.auditGaps
  + (data.stats.auditGaps ? '   ⚠  (mutation without event::record)' : '   ✓'));

if (leaks.length) {
  console.log('');
  console.log('  reach-gate leaks (top 10):');
  leaks.slice(0, 10).forEach(function (l) {
    console.log('    ' + l.file + '::' + l.name + '  —  ' + l.detail);
  });
}
if (scopeParentLeaks.length) {
  console.log('');
  console.log('  scope-parent leaks (top 10):');
  scopeParentLeaks.slice(0, 10).forEach(function (l) {
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

}  // end if (require.main === module)
