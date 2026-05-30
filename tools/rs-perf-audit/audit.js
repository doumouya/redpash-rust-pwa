#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash Rust — performance audit
   ---------------------------------------------------------------------------
   Sibling of rs-audit (which covers structural / refactoring health: LOC,
   repeated lines, big matches). This one scans for known performance
   anti-patterns that cost real CPU or allocations on the request path.

   The rule set was seeded by the 2026-05-29 perf audit of the backend:
   the 7 candidates that came out of that pass are encoded here as live
   checks, so the moment one regresses (or a new instance shows up in a
   future PR) the audit surfaces it. Each rule carries a stable `id` so a
   sanctioned exception can opt out inline:

       // rs-perf-allow: polars-collect-then-slice — intentional, see CAS_…

   The rules are heuristic (regex + small look-ahead), not AST — same trade
   rs-audit and css-audit make. False positives are fine when each finding
   carries enough context (file:line + snippet) to confirm in seconds.

   Output:
     - report.html  (browsable, ranked by severity)
     - audit.json   (machine-readable; future ingest hook)
     - console summary (matches the rs-audit shape)

   Exit code: 0. Informational only — promote to gating after the seeded
   findings are fixed and the audit is reliably green.

   Usage:  node audit.js [backendDir]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var SRC_DIR  = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '..', 'backend');
var OUT_HTML = path.join(__dirname, 'report.html');
var OUT_JSON = path.join(__dirname, 'audit.json');

/* ── helpers ─────────────────────────────────────────────────────────────── */

function walkRust(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    if (ent.name === 'target' || ent.name === 'node_modules') return;
    var full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkRust(full, out);
    else if (ent.isFile() && ent.name.endsWith('.rs')) out.push(full);
  });
  return out;
}

function rel(p) { return path.relative(SRC_DIR, p); }

function crateOf(file) {
  // backend/crates/<crate>/src/...  →  <crate>
  var m = file.match(/crates[\\/]+([^\\/]+)/);
  return m ? m[1] : 'unknown';
}

function snippet(lines, i, span) {
  span = span || 1;
  var end = Math.min(lines.length, i + span);
  return lines.slice(i, end).join('\n').trim();
}

function allowed(lines, i, ruleId) {
  // Inline opt-out: `// rs-perf-allow: <ruleId>` on the line OR within 3 above.
  var probe = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
  return new RegExp('rs-perf-allow:\\s*' + ruleId.replace(/-/g, '\\-')).test(probe);
}

/* ── rule registry ───────────────────────────────────────────────────────────

   Each rule:
     id        kebab-case stable identifier (used by inline opt-out)
     severity  'high' | 'medium' | 'low'
     label     short human title
     why       one-line cost explanation (shows on the report)
     fix       one-line remediation pointer (shows on the report)
     detect    fn(file, lines, findings) → pushes { rule, file, line, snippet, note }

   Severities mirror the perf audit's ROI buckets; rerank as data lands. */

var RULES = [];

/* 1. polars-collect-then-slice ─────────────────────────────────────────────
   `.collect()` materialises the full LazyFrame; slicing AFTER means we
   allocated the whole result just to keep a page-sized window. Move the
   `.slice(offset, n)` (or `.limit(n)`) before `.collect()` and let Polars
   push the limit through. */
RULES.push({
  id: 'polars-collect-then-slice',
  severity: 'high',
  label: 'LazyFrame `.collect()` then `.slice(…)` — slice before collect',
  why:   'Full result materialised, then thrown away — scales O(rows) in vain.',
  fix:   'Move .slice(offset, n) (or .limit) onto the LazyFrame before collect.',
  detect: function (file, lines, findings) {
    var i;
    for (i = 0; i < lines.length; i++) {
      if (!/\.\s*collect\s*\(\s*\)/.test(lines[i])) continue;
      // Only DataFrame-style collect — skip iterator/string collects.
      if (/collect\s*::\s*</.test(lines[i])) continue;
      if (allowed(lines, i, 'polars-collect-then-slice')) continue;
      var look = Math.min(lines.length, i + 10);
      for (var j = i + 1; j < look; j++) {
        if (/\.\s*slice\s*\(/.test(lines[j])) {
          findings.push({
            rule: 'polars-collect-then-slice',
            file: rel(file), line: i + 1,
            snippet: snippet(lines, i, j - i + 1),
            note: 'slice at line ' + (j + 1) + ' is post-materialisation',
          });
          break;
        }
      }
    }
  },
});

/* 2. cache-evict-then-rehydrate ────────────────────────────────────────────
   `state.files.remove(rid)` followed by `hydrate(…)` re-replays every
   applied step from disk. After a validated step apply, INSERT the
   validated frame into the cache instead of evicting + repopulating. */
RULES.push({
  id: 'cache-evict-then-rehydrate',
  severity: 'high',
  label: 'Cache evict immediately followed by rehydrate (double replay)',
  why:   'Replays the full step pipeline twice — O(steps × rows) per edit.',
  fix:   'Insert the validated DF into the cache; skip the second hydrate.',
  detect: function (file, lines, findings) {
    var i;
    for (i = 0; i < lines.length; i++) {
      // Cache eviction: <something>.files.remove( OR <state>.<cache>.remove(&rid)
      if (!/\.\s*files\s*\.\s*remove\s*\(/.test(lines[i])
          && !/state\s*\.\s*files\s*\.\s*remove\s*\(/.test(lines[i])) continue;
      if (allowed(lines, i, 'cache-evict-then-rehydrate')) continue;
      var look = Math.min(lines.length, i + 6);
      for (var j = i + 1; j < look; j++) {
        if (/\bhydrate\s*\(/.test(lines[j])) {
          findings.push({
            rule: 'cache-evict-then-rehydrate',
            file: rel(file), line: i + 1,
            snippet: snippet(lines, i, j - i + 1),
            note: 'hydrate() at line ' + (j + 1) + ' will fully replay applied steps',
          });
          break;
        }
      }
    }
  },
});

/* 3. double-clone-value ────────────────────────────────────────────────────
   Two `.clone()` calls on the same hot identifier in a tight window —
   serde_json::Value, FilterSpec, params, etc. Usually means the data
   was cloned to build an intermediate and cloned again to consume it.
   Refactor to move once. */
RULES.push({
  id: 'double-clone-value',
  severity: 'high',
  label: 'Two `.clone()` calls on the same identifier in a tight window',
  why:   'Doubles allocation cost on every call — visible on hot paths.',
  fix:   'Restructure to move once; pass by &reference where possible.',
  detect: function (file, lines, findings) {
    // Identifiers worth watching — names common to hot paths.
    var HOT = /\b(params|spec|filter|frame|value|json|envelope|columns|step|steps|rows)\b/;
    var seen, i, m;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!/\.\s*clone\s*\(\s*\)/.test(line)) continue;
      // Pull the identifier just before .clone()
      m = line.match(/(\b[a-z_][a-z0-9_]*)\s*\.\s*clone\s*\(\s*\)/i);
      if (!m) continue;
      var ident = m[1];
      if (!HOT.test(ident)) continue;
      if (allowed(lines, i, 'double-clone-value')) continue;
      // Look back up to 15 lines for another .clone() on the same ident
      var lookBack = Math.max(0, i - 15);
      for (var j = lookBack; j < i; j++) {
        var m2 = lines[j].match(/(\b[a-z_][a-z0-9_]*)\s*\.\s*clone\s*\(\s*\)/i);
        if (m2 && m2[1] === ident) {
          findings.push({
            rule: 'double-clone-value',
            file: rel(file), line: j + 1,
            snippet: snippet(lines, j, i - j + 1),
            note: 'second .clone() on `' + ident + '` at line ' + (i + 1),
          });
          break;
        }
      }
    }
  },
});

/* 4. json-string-roundtrip ─────────────────────────────────────────────────
   `serde_json::to_string(x)` whose output is then handed to a fn that
   parses it back (`apply_filter`, `from_str`, `parse_json`, etc.). Skip
   the round-trip by passing `&Value` directly. */
RULES.push({
  id: 'json-string-roundtrip',
  severity: 'medium',
  label: 'serde_json `to_string` → `from_str` round-trip',
  why:   'Allocates + serialises + parses for nothing — 2 wasted allocs/req.',
  fix:   'Pass &serde_json::Value directly; refactor the callee.',
  detect: function (file, lines, findings) {
    var i;
    for (i = 0; i < lines.length; i++) {
      if (!/serde_json::to_string\s*\(/.test(lines[i])) continue;
      if (allowed(lines, i, 'json-string-roundtrip')) continue;
      // Look ahead up to 8 lines for a re-parse signal
      var look = Math.min(lines.length, i + 8);
      for (var j = i; j < look; j++) {
        if (/\b(from_str|apply_filter|deserialize|parse_json|serde_json::from)/.test(lines[j])
            && (j > i || /from_str|deserialize/.test(lines[j]))) {
          findings.push({
            rule: 'json-string-roundtrip',
            file: rel(file), line: i + 1,
            snippet: snippet(lines, i, j - i + 1),
            note: 're-parse signal at line ' + (j + 1),
          });
          break;
        }
      }
    }
  },
});

/* 5. hardcoded-small-pool ──────────────────────────────────────────────────
   `PgPoolOptions::new().max_connections(N)` with N ≤ 16 and no env::var
   override in the same file — fine for dev, will starve under prod load
   when fire-and-forget logging holds connections. */
RULES.push({
  id: 'hardcoded-small-pool',
  severity: 'medium',
  label: 'PG pool size hardcoded to a small literal with no env override',
  why:   'Default headroom; concurrent + fire-and-forget logging starves the pool.',
  fix:   'Read max_connections from an env var (REDPASH_DB_POOL or similar).',
  detect: function (file, lines, findings) {
    var hasEnv = lines.some(function (l) { return /env::var\s*\(/.test(l); });
    var i;
    for (i = 0; i < lines.length; i++) {
      var m = lines[i].match(/max_connections\s*\(\s*(\d+)\s*\)/);
      if (!m) continue;
      if (allowed(lines, i, 'hardcoded-small-pool')) continue;
      var n = parseInt(m[1], 10);
      if (n > 16) continue;
      // Only flag if there's no env override in this file (heuristic — the
      // file pattern in state.rs is one constant + a builder).
      if (hasEnv && /max_connections\([^)]*env/.test(lines[i])) continue;
      findings.push({
        rule: 'hardcoded-small-pool',
        file: rel(file), line: i + 1,
        snippet: snippet(lines, i, 1),
        note: 'max_connections(' + n + ') — no env::var override in this file',
      });
    }
  },
});

/* 6. unbounded-delete-cleanup ──────────────────────────────────────────────
   `DELETE FROM <growable>_log WHERE at < …` without a supporting partial
   index. As the log table grows the cleanup scan itself becomes the
   bottleneck (and the cron may overlap itself). Add a partial index on
   the retention predicate. */
RULES.push({
  id: 'unbounded-delete-cleanup',
  severity: 'medium',
  label: 'Retention DELETE on a *_log table — check for a supporting index',
  why:   'A 60M-row scan during cleanup is the bottleneck the cleanup creates.',
  fix:   'Add a partial index on the retention predicate (at < threshold).',
  detect: function (file, lines, findings) {
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Look for SQL DELETE referencing a *_log table or known log tables.
      var m = line.match(/DELETE\s+FROM\s+([a-z_]+(?:_log|events|request_log))/i);
      if (!m) continue;
      if (allowed(lines, i, 'unbounded-delete-cleanup')) continue;
      findings.push({
        rule: 'unbounded-delete-cleanup',
        file: rel(file), line: i + 1,
        snippet: snippet(lines, i, 3),
        note: 'cleanup target: `' + m[1] + '` — verify a partial index supports the WHERE',
      });
    }
  },
});

/* 7. blocking-io-in-async ──────────────────────────────────────────────────
   `std::fs::*` calls inside files that declare `async fn`. v1 heuristic:
   flag every blocking call in a file with async fns and leave the
   reviewer to confirm scope. Wrap in `tokio::task::spawn_blocking` when
   inside an async handler. */
RULES.push({
  id: 'blocking-io-in-async',
  severity: 'low',
  label: 'Sync std::fs call in a file with `async fn` — wrap in spawn_blocking?',
  why:   'Blocks the tokio worker; starves other handlers under contention.',
  fix:   'Wrap the read/write in tokio::task::spawn_blocking, or use tokio::fs.',
  detect: function (file, lines, findings) {
    var hasAsync = lines.some(function (l) { return /\basync\s+fn\b/.test(l); });
    if (!hasAsync) return;
    var BLOCK = /std::fs::(read_to_string|read|read_dir|write|metadata|create_dir|File::open|File::create)/;
    var i;
    for (i = 0; i < lines.length; i++) {
      if (!BLOCK.test(lines[i])) continue;
      if (allowed(lines, i, 'blocking-io-in-async')) continue;
      // Crude: skip if `spawn_blocking` appears within the previous 4 lines.
      var probe = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      if (/spawn_blocking|tokio::fs::/.test(probe)) continue;
      findings.push({
        rule: 'blocking-io-in-async',
        file: rel(file), line: i + 1,
        snippet: snippet(lines, i, 1),
        note: 'file declares async fn — confirm caller is not on the request path',
      });
    }
  },
});

/* 8. n-plus-one-sqlx (bonus) ───────────────────────────────────────────────
   `sqlx::query*` inside a `for` body — the classic per-row query. v1
   heuristic: a `sqlx::query` line preceded by a `for … {` opener within
   the last 30 lines, with the `for`'s brace still open. */
RULES.push({
  id: 'n-plus-one-sqlx',
  severity: 'high',
  label: 'sqlx::query inside a for/iter loop body (N+1 pattern)',
  why:   'Per-row round-trip — O(rows × RTT) instead of one batched query.',
  fix:   'Hoist to one query with WHERE … IN (…) or a join; collect once.',
  detect: function (file, lines, findings) {
    var stack = [];   // open for-block start lines, ordered
    var depth = 0;
    var forDepth = []; // brace depth at each open for
    var i;
    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Update brace depth (very crude — strings/comments ignored).
      var opens = (line.match(/{/g) || []).length;
      var closes = (line.match(/}/g) || []).length;
      // Detect a for/while/iter chain opening a block on this line.
      var startsLoop = /\b(for|while)\b[^{;]*\{/.test(line)
                    || /\.\s*(iter|iter_mut|into_iter|for_each)\s*\(/.test(line);
      if (startsLoop && opens > closes) {
        stack.push({ start: i, snippet: line.trim() });
        forDepth.push(depth + opens - closes);
      }
      depth += opens - closes;
      // Inside any open loop?
      while (stack.length && depth < forDepth[forDepth.length - 1]) {
        stack.pop();
        forDepth.pop();
      }
      if (!stack.length) continue;
      if (allowed(lines, i, 'n-plus-one-sqlx')) continue;
      if (/sqlx::query/.test(line)) {
        var top = stack[stack.length - 1];
        findings.push({
          rule: 'n-plus-one-sqlx',
          file: rel(file), line: i + 1,
          snippet: snippet(lines, i, 1),
          note: 'inside loop opened at line ' + (top.start + 1) + ': ' + top.snippet,
        });
      }
    }
  },
});

/* ── scan ────────────────────────────────────────────────────────────────── */

var files = walkRust(SRC_DIR);
var findings = [];
var crateStats = {};

files.forEach(function (f) {
  var crate = crateOf(f);
  crateStats[crate] = (crateStats[crate] || 0) + 1;
  var text;
  try { text = fs.readFileSync(f, 'utf8'); }
  catch (e) { return; }
  var lines = text.split('\n');
  RULES.forEach(function (r) { r.detect(f, lines, findings); });
});

/* ── aggregate ───────────────────────────────────────────────────────────── */

var bySeverity = { high: 0, medium: 0, low: 0 };
var byRule = {};
findings.forEach(function (f) {
  bySeverity[ruleSeverity(f.rule)] = (bySeverity[ruleSeverity(f.rule)] || 0) + 1;
  byRule[f.rule] = (byRule[f.rule] || 0) + 1;
});

function ruleSeverity(id) {
  for (var k = 0; k < RULES.length; k++) if (RULES[k].id === id) return RULES[k].severity;
  return 'low';
}
function ruleMeta(id) {
  for (var k = 0; k < RULES.length; k++) if (RULES[k].id === id) return RULES[k];
  return { id: id, label: id, severity: 'low', why: '', fix: '' };
}

var SEV_ORDER = { high: 0, medium: 1, low: 2 };
findings.sort(function (a, b) {
  var sa = SEV_ORDER[ruleSeverity(a.rule)];
  var sb = SEV_ORDER[ruleSeverity(b.rule)];
  if (sa !== sb) return sa - sb;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
});

var data = {
  generatedAt: new Date().toISOString(),
  srcDir: SRC_DIR,
  stats: {
    filesScanned: files.length,
    crates: Object.keys(crateStats).length,
    findings: findings.length,
    high: bySeverity.high,
    medium: bySeverity.medium,
    low: bySeverity.low,
    byRule: byRule,
  },
  rules: RULES.map(function (r) {
    return { id: r.id, severity: r.severity, label: r.label, why: r.why, fix: r.fix,
             count: byRule[r.id] || 0 };
  }),
  findings: findings.map(function (f) {
    var meta = ruleMeta(f.rule);
    return {
      rule: f.rule, severity: meta.severity, label: meta.label,
      file: f.file, line: f.line, note: f.note || '',
      snippet: f.snippet,
    };
  }),
};

/* ── emit json + html ───────────────────────────────────────────────────── */

fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2), 'utf8');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(d) {
  var rulesRows = d.rules.map(function (r) {
    return '<tr class="sev-' + r.severity + '">'
      + '<td><span class="pill ' + r.severity + '">' + r.severity + '</span></td>'
      + '<td><span class="mono">' + esc(r.id) + '</span><div class="sub">' + esc(r.label) + '</div></td>'
      + '<td class="num">' + r.count + '</td>'
      + '<td class="sub">' + esc(r.why) + '<div class="fix">→ ' + esc(r.fix) + '</div></td>'
      + '</tr>';
  }).join('');
  var findRows = d.findings.map(function (f) {
    return '<tr class="sev-' + f.severity + '">'
      + '<td><span class="pill ' + f.severity + '">' + f.severity + '</span></td>'
      + '<td><span class="mono">' + esc(f.rule) + '</span></td>'
      + '<td><span class="mono">' + esc(f.file) + ':' + f.line + '</span>'
      +     (f.note ? '<div class="sub">' + esc(f.note) + '</div>' : '') + '</td>'
      + '<td><pre>' + esc(f.snippet) + '</pre></td>'
      + '</tr>';
  }).join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>rs-perf-audit</title>',
    '<style>',
    'body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#11111b;color:#cdd6f4;margin:1.5rem;}',
    'h1{font-size:1.1rem;margin:0 0 .5rem;color:#cba6f7;}',
    '.meta{color:#6c7086;font-size:.75rem;margin-bottom:1rem;}',
    '.summary{display:flex;gap:.75rem;margin-bottom:1rem;}',
    '.card{padding:.5rem .75rem;border:1px solid #313244;border-radius:.4rem;background:#181825;}',
    '.card b{font-size:1.05rem;color:#cdd6f4;}',
    'table{width:100%;border-collapse:collapse;margin-bottom:1.25rem;}',
    'th,td{padding:.4rem .5rem;border-bottom:1px solid #313244;vertical-align:top;text-align:left;}',
    'th{color:#a6adc8;font-weight:600;background:#181825;}',
    'tr.sev-high{background:rgba(243,139,168,.05);}',
    'tr.sev-medium{background:rgba(249,226,175,.04);}',
    '.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.65rem;text-transform:uppercase;font-weight:700;}',
    '.pill.high{background:rgba(243,139,168,.22);color:#f38ba8;}',
    '.pill.medium{background:rgba(249,226,175,.18);color:#f9e2af;}',
    '.pill.low{background:rgba(166,227,161,.18);color:#a6e3a1;}',
    '.mono{font-family:inherit;color:#89b4fa;}',
    '.sub{color:#6c7086;font-size:.72rem;margin-top:.15rem;}',
    '.fix{color:#a6e3a1;font-size:.72rem;margin-top:.1rem;}',
    '.num{text-align:right;font-variant-numeric:tabular-nums;color:#cdd6f4;}',
    'pre{margin:0;padding:.4rem .5rem;background:#1e1e2e;border-radius:.3rem;font-size:.72rem;color:#bac2de;white-space:pre-wrap;}',
    'h2{font-size:.85rem;margin:1.25rem 0 .5rem;color:#94e2d5;text-transform:uppercase;letter-spacing:.04em;}',
    '</style></head><body>',
    '<h1>rs-perf-audit</h1>',
    '<div class="meta">generated ' + esc(d.generatedAt) + '  ·  ' + esc(d.srcDir) + '</div>',
    '<div class="summary">',
    '<div class="card"><b>' + d.stats.filesScanned + '</b><div class="sub">files scanned</div></div>',
    '<div class="card"><b>' + d.stats.findings + '</b><div class="sub">total findings</div></div>',
    '<div class="card"><b>' + d.stats.high + '</b><div class="sub">high</div></div>',
    '<div class="card"><b>' + d.stats.medium + '</b><div class="sub">medium</div></div>',
    '<div class="card"><b>' + d.stats.low + '</b><div class="sub">low</div></div>',
    '</div>',
    '<h2>Rules</h2>',
    '<table><thead><tr><th>sev</th><th>id</th><th class="num">hits</th><th>why → fix</th></tr></thead>',
    '<tbody>' + rulesRows + '</tbody></table>',
    '<h2>Findings</h2>',
    '<table><thead><tr><th>sev</th><th>rule</th><th>location</th><th>snippet</th></tr></thead>',
    '<tbody>' + (findRows || '<tr><td colspan=4 class="sub">No findings — perf rules clean.</td></tr>') + '</tbody></table>',
    '</body></html>',
  ].join('\n');
}

fs.writeFileSync(OUT_HTML, renderHtml(data), 'utf8');

/* ── console summary (matches the rs-audit shape) ────────────────────────── */

console.log('');
console.log('  files scanned     ' + data.stats.filesScanned
  + '   (' + Object.keys(crateStats).map(function (c) {
      return c + ' ' + crateStats[c];
    }).join(', ') + ')');
console.log('  findings          ' + data.stats.findings
  + '   (' + bySeverity.high + ' high, '
  + bySeverity.medium + ' medium, '
  + bySeverity.low + ' low)');
RULES.forEach(function (r) {
  var n = byRule[r.id] || 0;
  var mark = n === 0 ? '✓' : (r.severity === 'high' ? '✗' : '⚠');
  console.log('    ' + mark + '  ' + r.id + (n ? '  (' + n + ')' : ''));
});
if (findings.length) {
  console.log('');
  console.log('  top findings:');
  findings.slice(0, 8).forEach(function (f) {
    console.log('    · [' + ruleSeverity(f.rule) + '] ' + f.rule + '  —  ' + f.file + ':' + f.line);
  });
}
console.log('  report -> ' + path.relative(process.cwd(), OUT_HTML));
