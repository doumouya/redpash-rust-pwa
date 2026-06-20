#!/usr/bin/env node
/* Purpose: backend list/collection-endpoint RBAC posture audit — classifies
 * every collection-returning handler/db fn by reach.
 * Doc: docs/internal/code/backend/api-routes.md (RBAC reach model). */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash list-endpoint-rbac-audit — reach-aware vs strict-membership scanner

   Surfaced from real-world Kafka loader use 2026-06-01 (predecessor tree): a
   loader landed a CSV into a project Em (platform admin + company owner)
   couldn't see, because the projects list filtered strictly by direct owner
   membership instead of routing through the reach-aware resolver
   (the `principals()` closure / `= ANY($n)` reach predicate / `require_view`).

   Build the *structural detector* for the bug class so one finding becomes N.
   Em's keystone, [[build-for-unknown-failures]]:

     > "we should build tools for the error we don't know yet"

   This audit IS that tool for the RBAC-list-divergence class.

   ── LEAN ADAPTATION (vs the prerelease ancestor) ──────────────────────────
   The lean cut moved the backend off the prerelease shape this tool was first
   written against, so the discovery + gate model are re-grounded:

     • DB fns are NOT in a `backend/crates/api/src/db/` directory and do NOT
       use a `list_*`/`find_all_*` naming convention. List/read surfaces are
       HTTP route handlers (`async fn list / search / rail / me / list_steps …`)
       in FLAT modules under `backend/crates/api/src/<mod>.rs` (plus the one
       directory module `files/`). The collection-read SIGNAL is therefore
       `.fetch_all(` in the fn body — every fn that returns a collection — NOT
       a `pub async fn list_* -> Vec<_>` signature (which finds nothing here).

     • The route gate is PER-HANDLER, not a nest `.layer()`. Lean gates a
       handler in its own body via `caller.is_platform_admin` (admin bypass /
       leak-free 404) and/or `rbac::require_view / require_action / require_rule`
       BEFORE the read. The router is assembled in `main.rs` with bare
       `.nest("/<prefix>", <mod>::routes())` and NO `require_platform_admin_mw`
       `.layer()` — so the prerelease v2 nest-gate machinery (GATE_MW /
       EXPECT_NEST_GATE / parseNestGates) does NOT map to lean and is REPLACED
       by an in-handler gate detector. (Same lean conventions documented in the
       sibling crossing-audit + admin-scope-audit headers.)

     • The reach-aware VOCABULARY is the lean canonical: the
       `viewer: Option<Vec<String>>` closure (`None` ⇒ platform admin, else
       `rbac::principals(...)`) threaded as `= ANY($n)` into the reach predicate
       `($n::text[] IS NULL OR EXISTS (... member_redpash_id = ANY($n) ...))`.
       Exemplars: `objects::list`, `projects::list`, `files::list`, `rail::rail`,
       `search::search`. The `db::*` reach helpers (`principals`, `resolve_grant`,
       `grant_edges`, `company_of`) are reach-aware by construction.

   ── classes ───────────────────────────────────────────────────────────────
     reach-aware    — uses the `= ANY($n)` reach predicate, a `viewer`/principals
                      closure, an `is_platform_admin` bypass, or calls a reach
                      helper (`principals(`, `resolve_grant(`, `require_view(`,
                      `require_action(`). **CORRECT** — respects the cascade.
     strict-owner   — filters `member_redpash_id = $n AND role = 'owner'` without
                      any cascade/principals reach. **BUG CLASS** — company
                      owners, platform admins, team members miss reachable rows.
     scope-filtered — filters by a parent-scope rid (project_id, file_id,
                      object_id, company_id = $n) instead of caller reach. RBAC
                      MUST be enforced in-handler via `require_view(scope)` BEFORE
                      the read — verify the in-handler gate. Exemplar:
                      `files::list_steps` (calls `require_action(... View)`).
     caller-blind   — no per-caller / per-scope filter; returns the whole table
                      or static-predicate rows. The handler MUST gate
                      (`is_platform_admin` / `require_*`) — verify the in-handler
                      gate. Exemplar: `admin` surfaces, public sentinels.
     ambiguous      — pattern didn't match; read the function + decide.

   ── what it does NOT do ──────────────────────────────────────────────────
   Not a parser. Heuristic regex + brace-counting (like auth-audit, rs-audit,
   crossing-audit). Good enough to point at the work; read the code to confirm.
   False positives are expected for hand-rolled SQL outside the conventional
   shapes — those land in 'ambiguous'.

   ── outputs ──────────────────────────────────────────────────────────────
   stdout summary + audit.json (machine) + audit.html (human).

   Usage:  node audit.js [apiSrcDir]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT     = path.resolve(__dirname, '../..');
var SRC_DIR  = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'backend/crates/api/src');
var OUT_JSON = path.join(__dirname, 'audit.json');
var OUT_HTML = path.join(__dirname, 'audit.html');
var MAIN_RS  = path.join(SRC_DIR, 'main.rs');

/* ── lean reach / gate vocabulary — SECURITY POLICY, not heuristics ──────────
   These declare the reach-model invariants the audit reads against. They are
   the lean canonical shapes (see objects::list / files::list_steps / rbac.rs).
     IN_HANDLER_GATE  — fn-body tokens that constitute an in-handler RBAC gate.
                        A scope-filtered or caller-blind read carrying one of
                        these IS gated (lean gates per-handler, not per-nest).
     REACH_HELPER     — fn-body tokens whose presence makes the fn reach-aware
                        (it threads or computes the principal/cascade closure). */
var IN_HANDLER_GATE = ['is_platform_admin', 'require_view(', 'require_action(', 'require_rule(', 'require_admin('];
var REACH_HELPER    = ['principals(', 'resolve_grant(', 'rbac_with_clause(', 'grant_edges('];

/* ── classification taxonomy ─────────────────────────────────────────────── */
var CLASS = {
  REACH_AWARE:    'reach-aware',
  STRICT_OWNER:   'strict-owner',
  SCOPE_FILTERED: 'scope-filtered',
  CALLER_BLIND:   'caller-blind',
  AMBIGUOUS:      'ambiguous',
};

var CLASS_HEALTH = {
  'reach-aware':    'green',
  'scope-filtered': 'yellow',  // verify in-handler gate
  'caller-blind':   'yellow',  // verify in-handler gate
  'strict-owner':   'red',     // bug class
  'ambiguous':      'yellow',  // needs eyeballs
};

/* ── source walking ──────────────────────────────────────────────────────── */
function walkRust(dir, acc) {
  acc = acc || [];
  var ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (var entry of ents) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRust(full, acc);
    } else if (entry.isFile() && full.endsWith('.rs')) {
      acc.push(full);
    }
  }
  return acc;
}

/* Strip comments — position-preserving (spaces). String literals are KEPT so
   the SQL inside `"..."` is visible; the classifier reads SQL from a separate
   `extractSql` extract, and the body strip is used only for finding fn
   boundaries + param shapes. */
function strip(text) {
  return text
    .replace(/\/\/[^\n]*/g,       function (m) { return ' '.repeat(m.length); })
    .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
}

function matchParens(s, openIdx) {
  if (s.charAt(openIdx) !== '(') return -1;
  var d = 1, i = openIdx + 1;
  while (i < s.length && d > 0) {
    var c = s.charAt(i);
    if      (c === '(') d++;
    else if (c === ')') d--;
    if (d === 0) return i;
    i++;
  }
  return -1;
}

function matchBraces(s, openIdx) {
  if (s.charAt(openIdx) !== '{') return -1;
  var d = 1, i = openIdx + 1;
  while (i < s.length && d > 0) {
    var c = s.charAt(i);
    if      (c === '{') d++;
    else if (c === '}') d--;
    if (d === 0) return i;
    i++;
  }
  return -1;
}

function lineOf(text, byteIdx) {
  var n = 1;
  for (var i = 0; i < byteIdx && i < text.length; i++) {
    if (text.charAt(i) === '\n') n++;
  }
  return n;
}

/* ── extract SQL literals from a function body ───────────────────────────── */
/* Pulls everything inside `r#"..."#` (raw strings) and `"..."` so the
   classifier can grep for `WHERE`, `member_redpash_id`, `= ANY(`, etc. without
   surrounding Rust identifiers false-positiving. */
function extractSql(rawBody) {
  var hits = [];
  var rawRe = /r(#*)"([\s\S]*?)"\1/g;
  var m;
  while ((m = rawRe.exec(rawBody)) !== null) hits.push(m[2]);
  var strRe = /"((?:\\.|[^"\\])*)"/g;
  while ((m = strRe.exec(rawBody)) !== null) hits.push(m[1]);
  return hits.join('\n---\n');
}

/* Find every file-level `const NAME: &str = "<sql>";` (with optional `pub`) so
   a fn that splices in a shared SQL const (e.g. objects.rs `const REACH`) is
   classified against the EXPANDED SQL. const-in-fn (`const REACH: &str = ...`
   inside the body) is also captured by extractSql on the body, but file-level
   consts need this pass. */
function extractFileConstants(rawText) {
  var out = {};
  var re = /(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*([\s\S]*?);/gm;
  var m;
  while ((m = re.exec(rawText)) !== null) {
    out[m[1]] = extractSql(m[2]);
  }
  return out;
}

/* Expand `{CONST_NAME}` placeholders (the format!("... {REACH} ...") shape)
   using the file-level const map. Shallow one-pass is enough for lean usage. */
function expandPlaceholders(sql, constants) {
  return sql.replace(/\{([A-Z][A-Z0-9_]*)\}/g, function (full, name) {
    return constants[name] != null ? constants[name] : full;
  });
}

/* ── discover collection-read fns ───────────────────────────────────────────
   LEAN: match every `async fn <name>(<params>) ... { <body> }` (pub or private
   — route handlers are private) whose body calls `.fetch_all(`. That is the
   collection-return signal in lean (replaces the prerelease `pub async fn
   list_* -> Vec<_>` signature heuristic, which matches nothing here). */
var NAME_RE = /\b(?:pub(?:\([^)]*\))?\s+)?async\s+fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g;

function findCollectionFns(rawText, strippedText) {
  var out = [];
  var m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(strippedText)) !== null) {
    var fnName = m[1];
    var openParen = strippedText.indexOf('(', m.index + m[0].length - 1);
    var closeParen = matchParens(strippedText, openParen);
    if (closeParen < 0) continue;
    var params = strippedText.slice(openParen + 1, closeParen);

    var braceStart = strippedText.indexOf('{', closeParen + 1);
    if (braceStart < 0) continue;
    var braceEnd = matchBraces(strippedText, braceStart);
    if (braceEnd < 0) { NAME_RE.lastIndex = braceStart + 1; continue; }

    var arrow = strippedText.indexOf('->', closeParen + 1);
    var retType = (arrow >= 0 && arrow < braceStart)
      ? strippedText.slice(arrow + 2, braceStart).trim()
      : '';

    var body = rawText.slice(braceStart + 1, braceEnd);   // raw, for SQL grep
    NAME_RE.lastIndex = braceEnd;

    // The collection-read signal: a `.fetch_all(` in the body. (A `fetch_one` /
    // `fetch_optional` is a single-record read — out of scope for a LIST audit.)
    if (!/\.fetch_all\s*\(/.test(body)) continue;

    out.push({
      name:   fnName,
      params: params,
      ret:    retType,
      body:   body,
      start:  m.index,
      end:    braceEnd,
    });
  }
  return out;
}

/* ── classifier ──────────────────────────────────────────────────────────── */
function classify(fn, constants) {
  var sql    = expandPlaceholders(extractSql(fn.body), constants || {});
  var params = fn.params;
  var body   = fn.body;
  var hints  = [];

  // 1) REACH-AWARE — wins over everything when a reach signal is present.
  if (/=\s*ANY\(\$/.test(sql))                          hints.push('= ANY($n) reach predicate');
  if (/::text\[\]\s+IS\s+NULL/i.test(sql))              hints.push('$n::text[] IS NULL (admin-bypass reach predicate)');
  if (/viewer\s*:\s*Option<&?\[?/.test(params))         hints.push('viewer: caller-scope param');
  if (/let\s+viewer\s*:\s*Option<Vec<String>>/.test(body)) hints.push('viewer closure (None=admin / principals)');
  REACH_HELPER.forEach(function (tok) {
    if (body.indexOf(tok) >= 0) hints.push('uses ' + tok.replace(/\($/, '') + '()');
  });
  // De-dupe hints (the same signal can fire twice).
  hints = hints.filter(function (h, i) { return hints.indexOf(h) === i; });
  if (hints.length) {
    return { class: CLASS.REACH_AWARE, hints: hints };
  }

  // 2) STRICT-OWNER — direct membership filter without cascade/reach.
  //    member_redpash_id = $n AND role = 'owner' (in any order).
  var hasMember = /member_redpash_id\s*=\s*\$\d+/.test(sql);
  var hasOwner  = /role\s*=\s*'owner'/.test(sql);
  if (hasMember && hasOwner) {
    var h = ['member_redpash_id = $n', "role = 'owner'"];
    if (/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+memberships/i.test(sql)) h.push('EXISTS(memberships) subquery');
    if (/JOIN\s+LATERAL[\s\S]{0,120}?memberships/i.test(sql))       h.push('LATERAL memberships join');
    return { class: CLASS.STRICT_OWNER, hints: h };
  }
  if (hasMember && !hasOwner) {
    return { class: CLASS.AMBIGUOUS,
             hints: ['member_redpash_id = $n WITHOUT role pin / reach — verify intent'] };
  }

  // 3) SCOPE-FILTERED — filters by a parent-scope rid arg. The handler MUST
  //    `require_view`/`require_action` the scope BEFORE the read (in-handler).
  if (/project_id\s*=\s*\$/.test(sql) || /project_redpash_id\s*=\s*\$/.test(sql))
    return { class: CLASS.SCOPE_FILTERED, hints: ['project(_redpash)_id = $n — handler must gate scope'] };
  if (/file_id\s*=\s*\$/.test(sql) || /file_redpash_id\s*=\s*\$/.test(sql))
    return { class: CLASS.SCOPE_FILTERED, hints: ['file(_redpash)_id = $n — handler must gate scope'] };
  if (/object_redpash_id\s*=\s*\$/.test(sql))
    return { class: CLASS.SCOPE_FILTERED, hints: ['object_redpash_id = $n — handler must gate scope'] };
  if (/company_id\s*=\s*\$/.test(sql))
    return { class: CLASS.SCOPE_FILTERED, hints: ['company_id = $n — handler must gate scope'] };

  // 4) CALLER-BLIND — no $n bind site (whole-table / static-predicate read).
  //    Acceptable for admin / catalog / public surfaces IF the handler gates.
  if (!/\$\d+/.test(sql))
    return { class: CLASS.CALLER_BLIND, hints: ['no parameter binds — admin / catalog / public surface'] };

  // 5) Unclassified — a $n filter that isn't a recognised scope/reach shape.
  return { class: CLASS.AMBIGUOUS, hints: ['unmatched $n filter — read the function'] };
}

/* Does this fn carry an IN-HANDLER gate? (lean gates per-handler, not per-nest) */
function inHandlerGate(fn) {
  var found = [];
  IN_HANDLER_GATE.forEach(function (tok) {
    if (fn.body.indexOf(tok) >= 0) found.push(tok.replace(/\($/, '') + (tok.endsWith('(') ? '()' : ''));
  });
  return found;
}

/* Is this fn a ROUTE HANDLER vs an internal db/helper? In lean a handler takes
   the `Caller` auth extractor (`caller: Caller` / `_caller: rbac::Caller`); a
   db helper takes `pool: &PgPool` / `&AppState` and is GATED BY ITS CALLER (the
   handler) — exactly the prerelease "scope-filtered / RBAC at the route layer"
   distinction. Only an UNGATED handler is a real leak; an ungated db helper is
   informational (its caller carries the gate). */
function isRouteHandler(fn) {
  return /(?:^|[,\s(])_?caller\s*:\s*(?:rbac::)?Caller\b/.test(fn.params);
}

/* ── route-nest mapping (lean: parse main.rs, NOT routes/mod.rs) ─────────────
   Mirrors crossing-audit: the router is assembled in main.rs with bare
   `.nest("/<prefix>", <mod>::routes())`. We map each module → its /api/<prefix>
   nest so a finding can report which surface exposes the fn. There is no nest
   `.layer()` gate in lean — gating is per-handler (see inHandlerGate). */
function parseModuleNests(mainRsText) {
  var byModule = {};
  if (!mainRsText) return byModule;
  var s = strip(mainRsText);
  var re = /\.nest\s*\(/g, m;
  while ((m = re.exec(s)) !== null) {
    var open  = s.indexOf('(', m.index);
    var close = matchParens(s, open);
    if (close < 0) { re.lastIndex = m.index + 5; continue; }
    var span = s.slice(open + 1, close);
    var pfx  = span.match(/"(\/[^"]*)"/);
    var mod  = span.match(/([a-z_]+)\s*::\s*routes\s*\(/);
    if (pfx && mod) byModule[mod[1]] = '/api' + pfx[1];   // "/auth" → "/api/auth"
    re.lastIndex = close;
  }
  return byModule;
}

/* ── main ───────────────────────────────────────────────────────────────── */
function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('list-endpoint-rbac-audit: dir not found:', SRC_DIR);
    process.exit(2);
  }

  var mainRs   = fs.existsSync(MAIN_RS) ? fs.readFileSync(MAIN_RS, 'utf8') : '';
  var modNests = parseModuleNests(mainRs);

  var files = walkRust(SRC_DIR);
  var findings = [];
  for (var f of files) {
    var raw       = fs.readFileSync(f, 'utf8');
    var stripped  = strip(raw);
    var constants = extractFileConstants(raw);
    var fns       = findCollectionFns(raw, stripped);
    var rel       = path.relative(ROOT, f).split(path.sep).join('/');
    // Module name for nest lookup: flat module is the basename sans .rs; the
    // `files/` directory module maps via its parent dir name.
    var base      = path.basename(f, '.rs');
    var modName   = (base === 'mod') ? path.basename(path.dirname(f)) : base;
    for (var fn of fns) {
      var verdict = classify(fn, constants);
      var gate    = inHandlerGate(fn);
      var handler = isRouteHandler(fn);
      findings.push({
        file:        rel,
        line:        lineOf(raw, fn.start),
        function:    fn.name,
        params:      fn.params.replace(/\s+/g, ' ').slice(0, 200),
        ret:         fn.ret.replace(/\s+/g, ' ').slice(0, 120),
        class:       verdict.class,
        health:      CLASS_HEALTH[verdict.class],
        hints:       verdict.hints,
        gate:        gate,
        kind:        handler ? 'route-handler' : 'db-helper',
        routeNest:   handler ? (modNests[modName] || null) : null,
      });
    }
  }

  // ── lean gate-aware recolor (replaces prerelease nest-gate v2) ────────────
  // db-SQL shape alone can't tell a leak from a read gated IN THE HANDLER. The
  // gate distinction is per-handler in lean, so recolor only applies to ROUTE
  // HANDLERS (take `Caller`):
  //   • handler, suspect class, WITH an in-handler gate  → GREEN.
  //   • handler, suspect class, NO gate + no reach filter → RED leak surface.
  // A db-HELPER (takes `pool`/`&AppState`, no `Caller`) is GATED BY ITS CALLER
  // — its scope-filtered/caller-blind shape stays YELLOW-informational (the
  // prerelease "RBAC enforced at the route layer — verify the gate" posture).
  findings.forEach(function (f) {
    var gated   = (f.gate || []).length > 0;
    var suspect = (f.class === CLASS.CALLER_BLIND || f.class === CLASS.SCOPE_FILTERED || f.class === CLASS.AMBIGUOUS);
    if (f.class === CLASS.STRICT_OWNER) {
      // Bug class — stays RED, never recolored. But a db-helper that matches the
      // strict-owner SQL shape may be an ownership-INVARIANT guard (e.g.
      // user_sole_owner_objects: "objects a user solely owns" — the role='owner'
      // filter IS the intent, not a reach miss), not a leaking list endpoint.
      // Carry that context so the human read is fast (false positives expected —
      // read the code to confirm).
      if (f.kind === 'db-helper') {
        f.hints = (f.hints || []).concat(
          'NOTE: db-helper, not a user-facing list — confirm whether the role=owner filter ' +
          'is an ownership invariant (e.g. sole-owner guard) vs a reach-filtered list before treating as a bug');
      }
      return;
    }
    if (f.kind === 'db-helper') {
      if (suspect) {
        f.hints = (f.hints || []).concat('db-helper — gated by its route-handler caller; verify the caller gates');
      }
      return;                                       // never red: gate lives upstream.
    }
    // route-handler:
    if (suspect && gated) {
      f.health = 'green';
      f.hints  = (f.hints || []).concat('in-handler gate: ' + f.gate.join(', '));
    } else if (suspect && !gated) {
      f.health = 'red';
      f.hints  = (f.hints || []).concat(
        'LEAK: route-handler collection read with NO in-handler gate (' + IN_HANDLER_GATE.join('/') +
        ') and no reach predicate — verify the handler scopes to caller reach');
    }
  });

  // Sort: red first (bug/leak), then yellow, then green.
  var ORDER = { red: 0, yellow: 1, green: 2 };
  findings.sort(function (a, b) {
    return (ORDER[a.health] - ORDER[b.health]) ||
           a.file.localeCompare(b.file) || a.line - b.line;
  });

  var byClass = {};
  for (var c of Object.values(CLASS)) byClass[c] = 0;
  for (var fnd of findings) byClass[fnd.class] = (byClass[fnd.class] || 0) + 1;

  var stats = {
    total:   findings.length,
    red:     findings.filter(function (f) { return f.health === 'red'; }).length,
    yellow:  findings.filter(function (f) { return f.health === 'yellow'; }).length,
    green:   findings.filter(function (f) { return f.health === 'green'; }).length,
    byClass: byClass,
  };

  var payload = {
    generatedAt: new Date().toISOString(),
    root:        ROOT,
    srcDir:      path.relative(ROOT, SRC_DIR),
    stats:       stats,
    findings:    findings,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUT_HTML, renderHtml(payload));

  // ── stdout summary ──
  console.log('list-endpoint-rbac-audit');
  console.log('────────────────────────');
  console.log('scanned: ' + payload.srcDir + ' (' + files.length + ' files)');
  console.log('found:   ' + stats.total + ' collection-read fns (.fetch_all)');
  console.log('');
  console.log('  reach-aware     ' + byClass['reach-aware']    + '  ✓ (correct)');
  console.log('  scope-filtered  ' + byClass['scope-filtered'] + '  ⚠ (verify in-handler gate)');
  console.log('  caller-blind    ' + byClass['caller-blind']   + '  ⚠ (verify in-handler gate)');
  console.log('  ambiguous       ' + byClass['ambiguous']      + '  ⚠ (read the function)');
  console.log('  strict-owner    ' + byClass['strict-owner']   + '  🐛 BUG CLASS');
  console.log('');
  console.log('  health: ' + stats.red + ' red · ' + stats.yellow + ' yellow · ' + stats.green + ' green');
  console.log('');

  if (byClass['strict-owner'] > 0) {
    console.log('strict-owner findings (no cascade — company owners + platform admins blind):');
    findings.filter(function (f) { return f.class === CLASS.STRICT_OWNER; })
            .forEach(function (f) { console.log('  ' + f.file + ':' + f.line + '  ' + f.function); });
    console.log('');
    console.log('Fix: thread the `viewer = principals(...)` closure + filter `= ANY($n)`, or gate the');
    console.log('handler with rbac::require_view. Exemplar shape: objects::list / projects::list.');
  }

  var redLeaks = findings.filter(function (f) {
    return f.health === 'red' && /LEAK:/.test((f.hints || []).join(' '));
  });
  if (redLeaks.length) {
    console.log('');
    console.log('ungated route-handler collection reads (no in-handler gate, no reach predicate):');
    redLeaks.forEach(function (f) {
      console.log('  ' + f.file + ':' + f.line + '  ' + f.function + (f.routeNest ? '  ' + f.routeNest : ''));
    });
  }
}

/* ── HTML report ────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(p) {
  var rows = p.findings.map(function (f) {
    return '<tr class="r-' + f.health + '">'
      +    '<td>' + escHtml(f.file) + ':' + f.line + '</td>'
      +    '<td><code>' + escHtml(f.function) + '</code></td>'
      +    '<td>' + escHtml(f.kind) + (f.routeNest ? ' ' + escHtml(f.routeNest) : '') + '</td>'
      +    '<td>' + escHtml(f.class) + '</td>'
      +    '<td>' + escHtml((f.hints || []).join('; ')) + '</td>'
      +    '<td><code>' + escHtml(f.ret) + '</code></td>'
      +    '</tr>';
  }).join('\n');

  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>list-endpoint-rbac-audit</title>'
    + '<style>'
    + 'body{font-family:system-ui,sans-serif;margin:2rem;color:#222;}'
    + 'h1{margin-top:0}'
    + 'table{border-collapse:collapse;width:100%;font-size:.85rem;font-family:ui-monospace,monospace}'
    + 'th,td{border:1px solid #ddd;padding:.35rem .5rem;text-align:left;vertical-align:top}'
    + 'th{background:#f4f4f4;position:sticky;top:0}'
    + 'tr.r-red    td{background:#fde0e0}'
    + 'tr.r-yellow td{background:#fff6d6}'
    + 'tr.r-green  td{background:#e6f7e6}'
    + '.stats{display:flex;gap:1rem;margin:1rem 0}'
    + '.stats div{padding:.5rem .8rem;border:1px solid #ddd;border-radius:.4rem}'
    + '.stats .red    {background:#fde0e0}'
    + '.stats .yellow {background:#fff6d6}'
    + '.stats .green  {background:#e6f7e6}'
    + '</style></head><body>'
    + '<h1>list-endpoint-rbac-audit</h1>'
    + '<p>generated ' + escHtml(p.generatedAt) + ' &middot; scanned <code>' + escHtml(p.srcDir) + '</code> '
    + '&middot; ' + p.stats.total + ' collection-read fns</p>'
    + '<div class="stats">'
    +   '<div class="red">strict-owner: ' + p.stats.byClass['strict-owner'] + '</div>'
    +   '<div class="yellow">scope-filtered: ' + p.stats.byClass['scope-filtered'] + '</div>'
    +   '<div class="yellow">caller-blind: ' + p.stats.byClass['caller-blind'] + '</div>'
    +   '<div class="yellow">ambiguous: ' + p.stats.byClass['ambiguous'] + '</div>'
    +   '<div class="green">reach-aware: ' + p.stats.byClass['reach-aware'] + '</div>'
    + '</div>'
    + '<p><b>strict-owner</b> = bug class (filters direct membership only, no cascade — company owners + '
    + 'platform admins blind to reach-visible rows). Fix: thread the <code>viewer = principals(...)</code> '
    + 'closure + filter <code>= ANY($n)</code>, or gate the handler with <code>rbac::require_view</code>. '
    + 'Lean gates PER-HANDLER (no nest <code>.layer()</code>) — the gate column shows the in-handler gate found.</p>'
    + '<table><thead><tr><th>file:line</th><th>function</th><th>kind / nest</th><th>class</th><th>hints</th><th>return</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>'
    + '</body></html>';
}

main();
