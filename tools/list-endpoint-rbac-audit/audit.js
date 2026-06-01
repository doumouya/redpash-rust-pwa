#!/usr/bin/env node
/* Purpose: backend list-endpoint RBAC posture audit — classifies db::list_* by reach.
 * Doc: docs/internal/code/tools/audit-suite/list-endpoint-rbac-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash list-endpoint-rbac-audit — reach-aware vs strict-membership scanner

   Surfaced from real-world Kafka loader use 2026-06-01: the loader landed
   a CSV into a project Em (platform admin + company owner) couldn't see in
   `/api/projects`, because `db::list_projects` filters strictly by direct
   owner membership instead of routing through the reach-aware resolver
   (`rbac::require_view` / the `principals()` closure / cascade scopes).

   Same architectural shape as the codec registry + adversarial-LLM suites:
   build the *structural detector* for the bug class so one finding becomes
   N. Em's keystone, [[build-for-unknown-failures]]:

     > "we should build tools for the error we don't know yet"

   This audit IS that tool for the RBAC-list-divergence class.

   ── what it scans ─────────────────────────────────────────────────────────
   Every `pub async fn list_* / find_all_* / fetch_all_*` in
   `backend/crates/api/src/db/` that returns `Vec<T>`. For each, classify
   its WHERE clause / param shape:

     reach-aware       — uses `principals()` set, `= ANY($1)`, `GRANT_SQL`,
                         `resolve_grant`, `require_view`, or accepts a
                         `viewer: Option<&[String]>`. **CORRECT** — the row
                         filter respects the cascade resolver, so callers
                         see what the entity-membership model says they
                         should see (direct + scope + team reach).
                         Exemplar: `list_cases`.

     strict-owner      — filters `member_redpash_id = $1 AND role='owner'`
                         (or equivalent direct-membership check) without
                         any cascade JOIN. **BUG CLASS** — company owners,
                         platform admins, team members miss rows they have
                         reach on. Exemplar: `list_projects` (CAS_3B0DAD92).

     scope-filtered    — filters by a scope rid (project_redpash_id,
                         file_redpash_id, case_id, object_redpash_id = $1)
                         instead of a caller rid. RBAC enforced at the
                         ROUTE LAYER via `require_view(scope)` before this
                         function runs. Verify the route gate before
                         pronouncing OK. Exemplar: `list_files_in_project`.

     caller-blind      — no per-caller filter; returns the whole table or
                         filters by static predicates only (e.g. admin
                         endpoints, public sentinels). The ROUTE must
                         gate (`is_platform_admin` or similar) — verify
                         the gate exists. Exemplar: `list_users`,
                         `list_global_sentinels`.

     ambiguous         — pattern didn't match any of the above. Read the
                         function + decide.

   ── what it does NOT do ──────────────────────────────────────────────────
   Not a parser. Heuristic regex + brace-counting (like auth-audit, rs-audit,
   crossing-audit). Good enough to point at the work; read the code to
   confirm a hit. False positives are expected for hand-rolled SQL that
   doesn't use the project's conventional shapes — those land in 'ambiguous'.

   Does NOT walk routes/ to verify the gate on scope-filtered / caller-blind
   findings. That's v2 once the inventory stabilizes (cross-ref shape is
   already in auth-audit and can be borrowed). v1 is the inventory.

   ── outputs ──────────────────────────────────────────────────────────────
   stdout summary + audit.json (machine) + audit.html (human).

   Usage:  node audit.js [backendDir]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT     = path.resolve(__dirname, '../..');
var SRC_DIR  = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'backend/crates/api/src/db');
var OUT_JSON = path.join(__dirname, 'audit.json');
var OUT_HTML = path.join(__dirname, 'audit.html');

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
  'scope-filtered': 'yellow',  // verify route gate
  'caller-blind':   'yellow',  // verify route gate
  'strict-owner':   'red',     // bug class
  'ambiguous':      'yellow',  // needs eyeballs
};

/* ── source walking ──────────────────────────────────────────────────────── */
function walkRust(dir, acc) {
  acc = acc || [];
  for (var entry of fs.readdirSync(dir, { withFileTypes: true })) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRust(full, acc);
    } else if (entry.isFile() && full.endsWith('.rs')) {
      acc.push(full);
    }
  }
  return acc;
}

/* Strip comments + string literals — position-preserving (spaces).
   Note: by intent the SQL inside `r#"..."#` and `"..."` IS stripped, so
   the classifier reads regex hits from a SEPARATE "sqlOnly" extract
   (see extractSql below) rather than the stripped body. The body strip
   is for finding fn boundaries + param shapes only. */
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
/* Pulls out everything inside `r#"..."#` (raw strings) and `"..."` so the
   classifier can grep for `WHERE`, `member_redpash_id`, etc. without the
   comment-strip false-positiving on identifiers that appear in surrounding
   Rust code (struct fields, etc.). */
function extractSql(rawBody) {
  var hits = [];
  // raw string r#"..."# / r##"..."## / r"..."
  var rawRe = /r(#*)"([\s\S]*?)"\1/g;
  var m;
  while ((m = rawRe.exec(rawBody)) !== null) {
    hits.push(m[2]);
  }
  // plain string literals — multi-line via `\n` escapes or sqlx::query("foo\nbar")
  var strRe = /"((?:\\.|[^"\\])*)"/g;
  while ((m = strRe.exec(rawBody)) !== null) {
    hits.push(m[1]);
  }
  return hits.join('\n---\n');
}

/* Find every file-level `const NAME: &str = "<sql>";` (with optional `pub`)
   so a function that does `format!("{FOO_SELECT} WHERE ...")` can be
   classified against the EXPANDED SQL. Without this, anything that splices
   in a shared SELECT constant (PROJECT_SELECT, CHART_COLS, CASE_SELECT,
   COMPANY_COLS, GRANT_SQL, EDGES_SQL, ...) presents a fragment to the
   classifier — the constraints `role = 'owner'` / cascade joins live in the
   constant, not the function body, so the function looks ambiguous. */
function extractFileConstants(rawText) {
  var out = {};
  // Forms:
  //   const NAME: &str = "..."  + (optional newline-continued concat)
  //   const NAME: &str = "..." + "..." ;
  //   const NAME: &str = r#" ... "#;
  // Plus the simple body-string concat shape used in db/mod.rs.
  // Keep it dumb — grab from `const` to the next `;` and pull every string
  // literal inside that span.
  var re = /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*([\s\S]*?);\s*$/gm;
  var m;
  while ((m = re.exec(rawText)) !== null) {
    var name = m[1];
    var body = m[2];
    out[name] = extractSql(body);
  }
  return out;
}

/* Expand `{CONST_NAME}` placeholders inside a function's SQL using the
   file-level const map. A shallow one-pass expansion is enough for the
   project's actual usage (constants are not nested in nested constants
   in the current codebase). */
function expandPlaceholders(sql, constants) {
  return sql.replace(/\{([A-Z][A-Z0-9_]*)\}/g, function (full, name) {
    return constants[name] != null ? constants[name] : full;
  });
}

/* ── discover fn ──────────────────────────────────────────────────────────
   Match every top-level `pub async fn <ListName>(<params>) -> sqlx::Result<Vec<_>>`
   where <ListName> starts with list_ / find_all / fetch_all / select_all /
   get_all. The return-type check disambiguates list-from-single-record gets. */

var NAME_RE = /^[ \t]*pub\s+async\s+fn\s+((?:list|find_all|fetch_all|select_all|get_all)_[a-zA-Z0-9_]+|list_[a-zA-Z0-9_]+)\s*\(/gm;

function findListFns(rawText, strippedText) {
  var out = [];
  var m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(strippedText)) !== null) {
    var fnName = m[1];
    var openParen = m.index + m[0].length - 1;        // back to "("
    var closeParen = matchParens(strippedText, openParen);
    if (closeParen < 0) continue;
    var params = strippedText.slice(openParen + 1, closeParen);

    // Return type: find next "->" then read until "{".
    var arrow = strippedText.indexOf('->', closeParen + 1);
    var braceStart = strippedText.indexOf('{', closeParen + 1);
    if (braceStart < 0) continue;
    var braceEnd = matchBraces(strippedText, braceStart);
    if (braceEnd < 0) { NAME_RE.lastIndex = braceStart + 1; continue; }
    var retType = (arrow >= 0 && arrow < braceStart)
      ? strippedText.slice(arrow + 2, braceStart).trim()
      : '';

    // Only list-shaped fns (returns Vec<_>). Tolerates the common
    // sqlx::Result<Vec<T>> + Result<Vec<T>, AppError> + Vec<T> shapes.
    if (!/Vec\s*</.test(retType)) {
      NAME_RE.lastIndex = braceEnd;
      continue;
    }

    out.push({
      name:   fnName,
      params: params,
      ret:    retType,
      body:   rawText.slice(braceStart + 1, braceEnd),   // raw, for SQL grep
      start:  m.index,
      end:    braceEnd,
    });
    NAME_RE.lastIndex = braceEnd;
  }
  return out;
}

/* ── classifier ──────────────────────────────────────────────────────────── */
function classify(fn, constants) {
  var sql = expandPlaceholders(extractSql(fn.body), constants || {});
  var params = fn.params;
  var hints = [];

  // 1) REACH-AWARE — wins over strict-owner when both signals coexist.
  if (/=\s*ANY\(\$/.test(sql))                  hints.push('= ANY($n)');
  if (/\bGRANT_SQL\b/.test(fn.body))            hints.push('uses GRANT_SQL');
  if (/resolve_grant\(/.test(fn.body))          hints.push('resolve_grant(');
  if (/\brequire_view\(/.test(fn.body))         hints.push('require_view(');
  if (/principals?\s*:/.test(params))           hints.push('principals param');
  if (/viewer\s*:\s*Option<&\[String\]>/.test(params)) hints.push('viewer: Option<&[String]>');
  if (/\bprincipals\(/.test(fn.body))           hints.push('principals(');
  // Inline-SQL reach (CAS_3B0DAD92 fix shape): a platform-admin bypass and/or a
  // company-cascade in the access WHERE are reach-aware too — and they keep this
  // from FALSE-flagging a query whose owner-DISPLAY join uses `role = 'owner'`
  // (e.g. projects.rs PROJECT_SELECT) as strict-owner.
  if (/role\s*=\s*'admin'/.test(sql))           hints.push("platform-admin bypass (role='admin')");
  if (/object_redpash_id\s*=\s*\w+\.company_id/.test(sql)) hints.push('company cascade (object = company_id)');
  if (hints.length) {
    return { class: CLASS.REACH_AWARE, hints: hints };
  }

  // 2) STRICT-OWNER — direct membership filter without cascade.
  //    member_redpash_id = $N AND role = 'owner' (in any order in the SQL).
  var hasMember = /member_redpash_id\s*=\s*\$\d+/.test(sql);
  var hasOwner  = /role\s*=\s*'owner'/.test(sql);
  if (hasMember && hasOwner) {
    var h = ['member_redpash_id = $n', "role = 'owner'"];
    // Subquery vs JOIN shape — caller can grep the function to see which.
    if (/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+memberships/i.test(sql)) h.push('EXISTS(memberships) subquery');
    if (/JOIN\s+LATERAL[\s\S]{0,120}?memberships/i.test(sql))         h.push('LATERAL memberships join');
    return { class: CLASS.STRICT_OWNER, hints: h };
  }
  if (hasMember && !hasOwner) {
    // Direct membership but NOT pinned to owner role (could be member-level
    // direct lookup — list_memberships_for_user, list_company_members). Less
    // bug-prone but flag as ambiguous so it gets a human read.
    return { class: CLASS.AMBIGUOUS,
             hints: ['member_redpash_id = $n WITHOUT role pin — verify intent'] };
  }

  // 3) SCOPE-FILTERED — filters by a *parent-scope* rid arg. The route
  //    must `require_view` the scope before calling this.
  if (/project_redpash_id\s*=\s*\$/.test(sql))   return { class: CLASS.SCOPE_FILTERED, hints: ['project_redpash_id = $n — route gates scope'] };
  if (/file_redpash_id\s*=\s*\$/.test(sql))      return { class: CLASS.SCOPE_FILTERED, hints: ['file_redpash_id = $n — route gates scope'] };
  if (/object_redpash_id\s*=\s*\$/.test(sql))    return { class: CLASS.SCOPE_FILTERED, hints: ['object_redpash_id = $n — route gates scope'] };
  if (/case_id\s*=\s*\$/.test(sql))              return { class: CLASS.SCOPE_FILTERED, hints: ['case_id = $n — route gates scope'] };
  if (/request_id\s*=\s*\$/.test(sql))           return { class: CLASS.SCOPE_FILTERED, hints: ['request_id = $n — internal correlation'] };
  if (/company_id\s*=\s*\$/.test(sql))           return { class: CLASS.SCOPE_FILTERED, hints: ['company_id = $n — route gates scope'] };

  // 4) CALLER-BLIND — no $1 bind site (or only static filters). Acceptable
  //    for admin endpoints + public sentinels IF the route gates.
  if (!/\$\d+/.test(sql))                        return { class: CLASS.CALLER_BLIND, hints: ['no parameter binds — admin / public surface'] };

  // 5) Unclassified.
  return { class: CLASS.AMBIGUOUS, hints: ['unmatched pattern — read the function'] };
}

/* ── main ───────────────────────────────────────────────────────────────── */
function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('list-endpoint-rbac-audit: dir not found:', SRC_DIR);
    process.exit(2);
  }
  var files = walkRust(SRC_DIR);
  var findings = [];
  for (var f of files) {
    var raw       = fs.readFileSync(f, 'utf8');
    var stripped  = strip(raw);
    var constants = extractFileConstants(raw);
    var fns       = findListFns(raw, stripped);
    for (var fn of fns) {
      var verdict = classify(fn, constants);
      findings.push({
        file:        path.relative(ROOT, f),
        line:        lineOf(raw, fn.start),
        function:    fn.name,
        params:      fn.params.replace(/\s+/g, ' ').slice(0, 220),
        ret:         fn.ret,
        class:       verdict.class,
        health:      CLASS_HEALTH[verdict.class],
        hints:       verdict.hints,
      });
    }
  }

  // Sort findings: red first (strict-owner = bug class), then yellow, then green.
  var ORDER = { red: 0, yellow: 1, green: 2 };
  findings.sort(function (a, b) {
    return (ORDER[a.health] - ORDER[b.health]) ||
           a.file.localeCompare(b.file) || a.line - b.line;
  });

  var byClass = {};
  for (var c of Object.values(CLASS)) byClass[c] = 0;
  for (var fnd of findings) byClass[fnd.class]++;

  var stats = {
    total:        findings.length,
    red:          findings.filter(function (f) { return f.health === 'red'; }).length,
    yellow:       findings.filter(function (f) { return f.health === 'yellow'; }).length,
    green:        findings.filter(function (f) { return f.health === 'green'; }).length,
    byClass:      byClass,
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
  console.log('found:   ' + stats.total + ' list endpoints');
  console.log('');
  console.log('  reach-aware     ' + byClass['reach-aware']    + '  ✓ (correct)');
  console.log('  scope-filtered  ' + byClass['scope-filtered'] + '  ⚠ (verify route gate)');
  console.log('  caller-blind    ' + byClass['caller-blind']   + '  ⚠ (verify route gate)');
  console.log('  ambiguous       ' + byClass['ambiguous']      + '  ⚠ (read the function)');
  console.log('  strict-owner    ' + byClass['strict-owner']   + '  🐛 BUG CLASS');
  console.log('');

  if (byClass['strict-owner'] > 0) {
    console.log('strict-owner findings (no cascade — company owners + platform admins blind):');
    for (var f of findings) {
      if (f.class === CLASS.STRICT_OWNER) {
        console.log('  ' + f.file + ':' + f.line + '  ' + f.function);
      }
    }
    console.log('');
    console.log('Fix path: route through rbac::require_view / accept a `principals` arg + filter by `= ANY($1)`.');
    console.log('Exemplar of the correct shape: db::list_cases (accepts `viewer: Option<&[String]>`).');
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
    + '<p>generated ' + escHtml(p.generatedAt) + ' &middot; scanned <code>' + escHtml(p.srcDir) + '</code></p>'
    + '<div class="stats">'
    +   '<div class="red">strict-owner: ' + p.stats.byClass['strict-owner'] + '</div>'
    +   '<div class="yellow">scope-filtered: ' + p.stats.byClass['scope-filtered'] + '</div>'
    +   '<div class="yellow">caller-blind: ' + p.stats.byClass['caller-blind'] + '</div>'
    +   '<div class="yellow">ambiguous: ' + p.stats.byClass['ambiguous'] + '</div>'
    +   '<div class="green">reach-aware: ' + p.stats.byClass['reach-aware'] + '</div>'
    + '</div>'
    + '<p><b>strict-owner</b> = bug class (filters direct membership only, no cascade — company owners + platform admins blind to reach-visible rows). '
    + 'Fix: route through <code>rbac::require_view</code> or accept a <code>principals</code> arg and filter <code>= ANY($1)</code>. '
    + 'Exemplar of the correct shape: <code>db::list_cases</code>.</p>'
    + '<table><thead><tr><th>file:line</th><th>function</th><th>class</th><th>hints</th><th>return</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>'
    + '</body></html>';
}

main();
