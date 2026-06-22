#!/usr/bin/env node
/* Purpose: .claude orchestrator reference integrity — every gate script + doc a
 * role prompt names must exist, so a renamed/dropped gate or relocated doc fails
 * THIS tool, not a /feature dispatch (the F50/F29 class — agent-system-review-2026-06-12.md).
 * Doc: docs/internal/specs/agent-system-review-2026-06-12.md (F29/F50). */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash (lean) — claude-refs audit
   ---------------------------------------------------------------------------
   The /feature role chain lives in `.claude/` (agents/*.md, commands/feature.md)
   + the skills. The prompts DISPATCH gate scripts (`sh tools/ci.sh`) and cite
   docs (the architect's reading list). When a script is renamed or a doc moves,
   the prompt silently rots: a cold subagent runs a missing command (errors, or a
   tolerant wrapper skips the gate) or 404s its reading list. F50 was exactly this
   — `tools/audit.sh` / `health-check.sh` / `page-verify/verify.js` named in the
   prompts never existed on lean. This audit makes that fail the ratchet instead.

   It scans `.claude/{agents,commands,skills}/**.md` for:

     1. dead_command — a `tools/<path>.{sh,mjs,js}` reference whose file is not on
        disk (the F50 class). Placeholder tokens (`*`, `<…>`) are skipped.
     2. dead_md_link — a markdown link `](…​.md)` that does not resolve relative
        to the prompt file (a relocated cross-reference).
     3. dead_doc_ref — a backticked repo-relative `docs/…​.md` or `.claude/…​.md`
        path that is not on disk (the F29 reading-list class).

   Scope is `.claude/` ONLY — a docs/ file (e.g. agent-system-review.md itself)
   legitimately NAMES dead scripts as findings; scanning it would false-positive.

   Heuristic (regex + path stat), matching the audit-suite convention.

   Output: audit.json (ratchet-compatible `findings[]`), report.html, exit=count.
   Usage:  node tools/claude-refs-audit/audit.js [repoRoot]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT     = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..');
var CLAUDE   = path.join(ROOT, '.claude');
var SUBDIRS  = ['agents', 'commands', 'skills'];
var OUT_HTML = path.join(__dirname, 'report.html');
var OUT_JSON = path.join(__dirname, 'audit.json');

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function exists(p) { try { fs.statSync(p); return true; } catch (_) { return false; } }
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

function walk(dir, out) {
  out = out || [];
  if (!exists(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    if (ent.name === 'node_modules' || ent.name === '.git') return;
    var full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
  });
  return out;
}

// A token is a placeholder (not a literal path) if it carries a glob/angle var.
function isPlaceholder(tok) { return /[<>*]/.test(tok); }

var findings = [];
function flag(kind, file, line, ref, note) {
  findings.push({ kind: kind, file: file, line: line || 0, ref: ref, note: note || '' });
}

var files = [];
SUBDIRS.forEach(function (d) { walk(path.join(CLAUDE, d), files); });
files.sort();

files.forEach(function (abs) {
  var text = readSafe(abs);
  if (text == null) return;
  var r = rel(abs);
  var dir = path.dirname(abs);
  var lines = text.split('\n');

  // dedupe (kind+ref) within a file — a script named 3× is one drift, not three.
  var seen = {};
  function once(kind, ref) { var k = kind + '|' + ref; if (seen[k]) return false; seen[k] = 1; return true; }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i], m;

    // 1. dead_command — tools/<path>.{sh,mjs,js} that isn't on disk.
    var cmdRe = /(?:^|[^\w/])(tools\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:sh|mjs|js))\b/g;
    while ((m = cmdRe.exec(line)) !== null) {
      var cmd = m[1];
      if (isPlaceholder(cmd)) continue;
      if (!exists(path.join(ROOT, cmd)) && once('dead_command', cmd)) {
        flag('dead_command', r, i + 1, cmd, 'referenced gate script does not exist on disk');
      }
    }

    // 2. dead_md_link — markdown link to a .md that doesn't resolve from this file.
    var linkRe = /\]\(([^)]+)\)/g;
    while ((m = linkRe.exec(line)) !== null) {
      var target = m[1].trim().replace(/#.*$/, '');
      if (target === '' || /^(https?:|mailto:|#)/i.test(target) || !target.endsWith('.md')) continue;
      if (isPlaceholder(target)) continue;
      if (!exists(path.resolve(dir, target)) && once('dead_md_link', target)) {
        flag('dead_md_link', r, i + 1, target, 'link target does not resolve from this file');
      }
    }

    // 3. dead_doc_ref — backticked repo-relative docs/… or .claude/… path: a .md
    // FILE or a DIRECTORY (trailing /). Reading lists cite both (the architect
    // names `docs/REDMAP.md` + `docs/decisions/`). The /feature state ledger
    // (`docs/internal/state/`) is created at runtime (Step 0), not committed —
    // exempt it so a created-on-use output isn't read as a dead reference.
    var docRe = /`((?:docs|\.claude)\/[A-Za-z0-9_][A-Za-z0-9_./-]*(?:\.md|\/))`/g;
    while ((m = docRe.exec(line)) !== null) {
      var doc = m[1];
      if (isPlaceholder(doc)) continue;
      if (doc.indexOf('docs/internal/state/') === 0) continue;   // runtime ledger, created on use
      if (!exists(path.join(ROOT, doc)) && once('dead_doc_ref', doc)) {
        flag('dead_doc_ref', r, i + 1, doc, doc.slice(-1) === '/'
          ? 'cited directory does not exist on disk' : 'cited doc path does not exist on disk');
      }
    }
  }
});

/* ── aggregate ───────────────────────────────────────────────────────────── */

var KIND_META = {
  dead_command:  { severity: 'high',   why: 'A role prompt dispatches a tools/ gate script that is not on disk.' },
  dead_md_link:  { severity: 'medium', why: 'A markdown link in a .claude prompt points at a file that does not resolve.' },
  dead_doc_ref:  { severity: 'medium', why: 'A .claude prompt cites a docs/ or .claude/ path that is not on disk.' },
};
var SEV_ORDER = { high: 0, medium: 1, low: 2 };
function sev(k) { return (KIND_META[k] || { severity: 'low' }).severity; }

findings.sort(function (a, b) {
  var d = SEV_ORDER[sev(a.kind)] - SEV_ORDER[sev(b.kind)];
  if (d) return d;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
});

var stats = { filesScanned: files.length, totalFindings: findings.length,
              high: 0, medium: 0, low: 0, byKind: {} };
findings.forEach(function (f) {
  stats[sev(f.kind)]++;
  stats.byKind[f.kind] = (stats.byKind[f.kind] || 0) + 1;
});

var data = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  scope: '.claude/{' + SUBDIRS.join(',') + '}/**.md',
  stats: stats,
  rules: Object.keys(KIND_META).map(function (k) {
    return { kind: k, severity: KIND_META[k].severity, why: KIND_META[k].why, count: stats.byKind[k] || 0 };
  }),
  findings: findings,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2), 'utf8');

/* ── html ────────────────────────────────────────────────────────────────── */

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
var findRows = findings.map(function (f) {
  return '<tr class="sev-' + sev(f.kind) + '"><td><span class="pill ' + sev(f.kind) + '">' + sev(f.kind)
    + '</span></td><td class="mono">' + esc(f.kind) + '</td><td class="mono">' + esc(f.file) + ':' + f.line
    + '</td><td class="mono">' + esc(f.ref) + '<div class="sub">' + esc(f.note) + '</div></td></tr>';
}).join('');
var html = [
  '<!doctype html><html><head><meta charset="utf-8"><title>claude-refs-audit</title><style>',
  'body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#11111b;color:#cdd6f4;margin:1.5rem;}',
  'h1{font-size:1.1rem;color:#cba6f7;}.sub{color:#6c7086;font-size:.72rem;}',
  'table{width:100%;border-collapse:collapse;}th,td{padding:.4rem .5rem;border-bottom:1px solid #313244;text-align:left;vertical-align:top;}',
  '.mono{color:#89b4fa;}.pill{padding:1px 8px;border-radius:999px;font-size:.65rem;text-transform:uppercase;font-weight:700;}',
  '.pill.high{background:rgba(243,139,168,.22);color:#f38ba8;}.pill.medium{background:rgba(249,226,175,.18);color:#f9e2af;}',
  'tr.sev-high{background:rgba(243,139,168,.05);}</style></head><body>',
  '<h1>claude-refs-audit</h1>',
  '<div class="sub">generated ' + esc(data.generatedAt) + ' · ' + stats.filesScanned + ' prompt files · ' + stats.totalFindings + ' findings</div><br>',
  '<table><thead><tr><th>sev</th><th>kind</th><th>location</th><th>ref / note</th></tr></thead><tbody>',
  (findRows || '<tr><td colspan=4 class="sub">No findings — every .claude command + doc reference resolves.</td></tr>'),
  '</tbody></table></body></html>',
].join('\n');
fs.writeFileSync(OUT_HTML, html, 'utf8');

/* ── console (exit = finding count) ──────────────────────────────────────── */
console.log('');
console.log('  .claude prompts scanned  ' + stats.filesScanned);
console.log('  findings                 ' + stats.totalFindings
  + '   (' + stats.high + ' high, ' + stats.medium + ' medium)');
Object.keys(KIND_META).forEach(function (k) {
  var n = stats.byKind[k] || 0;
  console.log('    ' + (n === 0 ? '✓' : (sev(k) === 'high' ? '✗' : '⚠')) + '  ' + k + (n ? '  (' + n + ')' : ''));
});
console.log('  report -> ' + path.relative(process.cwd(), OUT_HTML));
process.exit(stats.totalFindings);
