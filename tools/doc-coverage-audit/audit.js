#!/usr/bin/env node
/* Purpose: docs ⇄ code drift enforcer for the LEAN docs tree.
 * Doc: docs/internal/specs/docs-reorg.md (acceptance criterion 5) */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash (lean) — doc-coverage audit
   ---------------------------------------------------------------------------
   The lean docs tree is a CURATED topic-doc set, not the predecessor's
   per-file atomic-doc mirror. So this tool does NOT enforce a source-file →
   atomic-doc mapping, breadcrumbs, or `## Purpose / ## Public surface /
   ## Drift-prone areas` headings (all prerelease-era conventions). Instead it
   guards the mechanical contract the lean docs spine actually states
   (docs/INDEX.md header, docs/REDMAP.md, docs/internal/specs/docs-reorg.md):

     1. index_missing    — every `.md` under docs/ has a row in docs/INDEX.md.
     2. index_dangling   — every doc-link in docs/INDEX.md resolves to a file.
     3. redmap_missing   — every non-spec doc is mapped in docs/REDMAP.md's
                           "doc ⇄ code-area" table (specs are covered by the
                           wildcard `internal/specs/*` row).
     4. orphan_link      — every relative `.md` link inside any doc resolves to
                           a real file (catches the relocated-doc dangle, e.g.
                           the old `backend.md` under code/frontend/).
     5. next_era_naming  — the retired next-era naming: `*-next` / `RedPash-next`
                           doc titles and the dropped `redpash_next` / `*_next`
                           DB name, anywhere under docs/ or in CLAUDE.md.

   docs/archive/ is EXCLUDED from every check — archived docs are frozen history,
   out of the live-spine contract (no INDEX/REDMAP row; retired naming is expected).

   Heuristic, not a parser — regex + small file walks. Findings carry enough
   context (file + line + snippet + what's expected) to confirm in seconds.

   Output:
     - report.html  (browsable, grouped by finding kind + severity)
     - audit.json   (ingest-compatible — same shape as rs-audit / css-audit)
     - console summary (health-check shape: exit code = finding count)

   Usage:  node tools/doc-coverage-audit/audit.js [repoRoot]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT     = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', '..');
var DOCS     = path.join(ROOT, 'docs');
var OUT_HTML = path.join(__dirname, 'report.html');
var OUT_JSON = path.join(__dirname, 'audit.json');

/* ── helpers ─────────────────────────────────────────────────────────────── */

function walk(dir, pred, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    // docs/archive/ is frozen history (retired docs) — out of the live-spine
    // contract: no INDEX/REDMAP row required, and retired naming is expected.
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'archive') return;
    var full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, pred, out);
    else if (ent.isFile() && pred(full)) out.push(full);
  });
  return out;
}

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function relDocs(p) { return path.relative(DOCS, p).replace(/\\/g, '/'); }
function exists(p) { try { fs.statSync(p); return true; } catch (_) { return false; } }
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

/* All docs under docs/, relative to docs/ (so `INDEX.md`, `decisions/x.md`,
   `internal/code/backend/README.md`, …). */
function enumerateDocs() {
  return walk(DOCS, function (f) { return f.endsWith('.md'); })
    .map(relDocs)
    .sort();
}

/* Extract every markdown link target `](target)` from text, with line number.
   Returns [{ target, line }]. Anchors (#…) and absolute/URL targets are kept
   verbatim — the caller decides which to resolve. */
function extractLinks(text) {
  var links = [];
  var lines = text.split('\n');
  var re = /\]\(([^)]+)\)/g;
  for (var i = 0; i < lines.length; i++) {
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      links.push({ target: m[1].trim(), line: i + 1 });
    }
  }
  return links;
}

function isExternal(target) {
  return /^(https?:|mailto:|#)/i.test(target);
}

/* ── findings ────────────────────────────────────────────────────────────── */

var findings = [];
function flag(kind, file, line, expected, snippet) {
  findings.push({ kind: kind, file: file, line: line || 0,
                  expected: expected, snippet: snippet || '' });
}

var allDocs = enumerateDocs();                              // relative to docs/
var docSet  = {};
allDocs.forEach(function (d) { docSet[d] = true; });

/* ── 1 + 2: docs/INDEX.md completeness ───────────────────────────────────── */

var indexAbs  = path.join(DOCS, 'INDEX.md');
var indexText = readFileSafe(indexAbs) || '';
// Every link target in INDEX.md that points at a doc (relative .md path).
var indexedDocs = {};
extractLinks(indexText).forEach(function (lnk) {
  var t = lnk.target.replace(/#.*$/, '');                   // strip anchor
  if (isExternal(t) || !t.endsWith('.md')) return;
  var norm = t.replace(/^\.\//, '');
  indexedDocs[norm] = true;
  // index_dangling: the row points at a file that isn't there.
  if (!docSet[norm]) {
    flag('index_dangling', 'docs/INDEX.md', lnk.line,
         'INDEX.md row target must exist',
         'links to docs/' + norm + ' (not found)');
  }
});

// index_missing: a doc on disk with no row in INDEX.md. INDEX.md itself is the
// index, so it needn't list itself — but it does (harmless), so just skip it.
allDocs.forEach(function (d) {
  if (d === 'INDEX.md') return;
  if (!indexedDocs[d]) {
    flag('index_missing', 'docs/' + d, 0,
         'add a one-line row in docs/INDEX.md (the audit gates it)', '');
  }
});

/* ── 3: docs/REDMAP.md cross-reference completeness ───────────────────────── */

var redmapAbs  = path.join(DOCS, 'REDMAP.md');
var redmapText = readFileSafe(redmapAbs) || '';
// REDMAP maps docs by their docs-relative path written `as inline code`, e.g.
//   `internal/code/backend/api-routes.md` | …code area…
// Specs are covered by a single wildcard row `internal/specs/*`. INDEX/REDMAP
// are the maps themselves, so they don't need a self-row.
var redmapSpecsWildcard = /internal\/specs\/\*/.test(redmapText);
allDocs.forEach(function (d) {
  if (d === 'INDEX.md' || d === 'REDMAP.md') return;
  if (d.indexOf('internal/specs/') === 0 && redmapSpecsWildcard) return;
  // mention by the docs-relative path is enough (the table writes it as code).
  if (redmapText.indexOf(d) === -1) {
    flag('redmap_missing', 'docs/' + d, 0,
         'map this doc to its code area(s) in docs/REDMAP.md', '');
  }
});

/* ── 4: orphan_link — relative .md links that don't resolve ───────────────── */

walk(DOCS, function (f) { return f.endsWith('.md'); }).forEach(function (abs) {
  var text = readFileSafe(abs);
  if (text == null) return;
  var dir = path.dirname(abs);
  extractLinks(text).forEach(function (lnk) {
    var t = lnk.target.replace(/#.*$/, '');
    if (isExternal(t) || t === '') return;
    if (!t.endsWith('.md')) return;                         // only check doc links
    var resolved = path.resolve(dir, t);
    if (!exists(resolved)) {
      flag('orphan_link', rel(abs), lnk.line,
           'link target must resolve to a real file',
           'links to ' + lnk.target);
    }
  });
});

/* ── 5: next_era_naming — the retired next-era residue ────────────────────── */

// Allowlist the META lines that legitimately NAME the retired tokens to define
// what this very check forbids (REDMAP's rule sentence, the docs-reorg spec's
// "Known drift" + acceptance criteria). They quote the tokens to retire them;
// flagging them would be self-referential noise.
var NEXT_RE = /redpash[-_ ]next|redpash_next|RedPash-next|\bnext-era\b|[a-z0-9]+_next\b|[a-z0-9]+-next\b/i;
function isMetaSelfReference(relPath, line) {
  if (relPath === 'docs/REDMAP.md') return true;            // the rule sentence
  if (relPath === 'docs/internal/specs/docs-reorg.md') return true; // the spec describing the drift
  // a markdown link/code target that legitimately ends in -next is unlikely in
  // lean; keep the net tight — only the two meta docs are exempt.
  return false;
}
var scanTargets = walk(DOCS, function (f) { return f.endsWith('.md'); });
var claudeMd = path.join(ROOT, 'CLAUDE.md');
if (exists(claudeMd)) scanTargets.push(claudeMd);
scanTargets.forEach(function (abs) {
  var text = readFileSafe(abs);
  if (text == null) return;
  var r = rel(abs);
  text.split('\n').forEach(function (line, i) {
    if (!NEXT_RE.test(line)) return;
    if (isMetaSelfReference(r, i + 1)) return;
    flag('next_era_naming', r, i + 1,
         'retire next-era naming (*-next / RedPash-next / redpash_next)',
         line.trim().slice(0, 120));
  });
});

/* ── aggregate ───────────────────────────────────────────────────────────── */

var KIND_META = {
  orphan_link:     { severity: 'high',   why: 'A relative doc link points at a file that does not exist.'                       },
  index_dangling:  { severity: 'high',   why: 'A docs/INDEX.md row links to a doc that is not on disk.'                         },
  index_missing:   { severity: 'medium', why: 'A doc on disk has no row in docs/INDEX.md.'                                      },
  redmap_missing:  { severity: 'medium', why: 'A doc is not mapped to a code area in docs/REDMAP.md.'                           },
  next_era_naming: { severity: 'low',    why: 'Retired next-era naming (*-next / RedPash-next / redpash_next DB).'              },
};

var SEV_ORDER = { high: 0, medium: 1, low: 2 };
function sev(k) { return (KIND_META[k] || { severity: 'low' }).severity; }

findings.sort(function (a, b) {
  var sa = SEV_ORDER[sev(a.kind)];
  var sb = SEV_ORDER[sev(b.kind)];
  if (sa !== sb) return sa - sb;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
});

var stats = {
  totalDocs: allDocs.length,
  totalFindings: findings.length,
  high:   findings.filter(function (f) { return sev(f.kind) === 'high'; }).length,
  medium: findings.filter(function (f) { return sev(f.kind) === 'medium'; }).length,
  low:    findings.filter(function (f) { return sev(f.kind) === 'low'; }).length,
  byKind: {},
};
findings.forEach(function (f) {
  stats.byKind[f.kind] = (stats.byKind[f.kind] || 0) + 1;
});

// coverage: docs that have BOTH an INDEX row and a REDMAP mapping (the lean
// "documented" bar) vs total docs.
var indexedCount = allDocs.filter(function (d) {
  return d === 'INDEX.md' || indexedDocs[d];
}).length;
var redmapMissing = stats.byKind.redmap_missing || 0;
var coverage = {
  index:  { total: allDocs.length, covered: indexedCount,
            pct: allDocs.length ? Math.round(indexedCount / allDocs.length * 1000) / 10 : 100 },
  redmap: { total: allDocs.length, covered: allDocs.length - redmapMissing,
            pct: allDocs.length ? Math.round((allDocs.length - redmapMissing) / allDocs.length * 1000) / 10 : 100 },
};

var data = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  model: 'lean-curated-topic-docs',
  stats: stats,
  coverage: coverage,
  rules: Object.keys(KIND_META).map(function (k) {
    return { kind: k, severity: KIND_META[k].severity, why: KIND_META[k].why,
             count: stats.byKind[k] || 0 };
  }),
  findings: findings,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2), 'utf8');

/* ── render html ─────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(d) {
  var coverageCards = [
    ['index', d.coverage.index], ['redmap', d.coverage.redmap],
  ].map(function (pair) {
    var c = pair[1];
    return '<div class="card"><b>' + c.pct + '%</b>'
      + '<div class="sub">' + esc(pair[0]) + ' · ' + c.covered + ' / ' + c.total + '</div></div>';
  }).join('');
  var rulesRows = d.rules.map(function (r) {
    return '<tr class="sev-' + r.severity + '">'
      + '<td><span class="pill ' + r.severity + '">' + r.severity + '</span></td>'
      + '<td><span class="mono">' + esc(r.kind) + '</span><div class="sub">' + esc(r.why) + '</div></td>'
      + '<td class="num">' + r.count + '</td>'
      + '</tr>';
  }).join('');
  var findRows = d.findings.map(function (f) {
    var meta = d.rules.filter(function (r) { return r.kind === f.kind; })[0] || { severity: 'low' };
    return '<tr class="sev-' + meta.severity + '">'
      + '<td><span class="pill ' + meta.severity + '">' + meta.severity + '</span></td>'
      + '<td><span class="mono">' + esc(f.kind) + '</span></td>'
      + '<td><span class="mono">' + esc(f.file) + (f.line ? ':' + f.line : '') + '</span></td>'
      + '<td><span class="sub">' + esc(f.expected) + '</span>'
      +     (f.snippet ? '<div class="sub">' + esc(f.snippet) + '</div>' : '') + '</td>'
      + '</tr>';
  }).join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>doc-coverage-audit</title>',
    '<style>',
    'body{font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#11111b;color:#cdd6f4;margin:1.5rem;}',
    'h1{font-size:1.1rem;margin:0 0 .5rem;color:#cba6f7;}',
    '.meta{color:#6c7086;font-size:.75rem;margin-bottom:1rem;}',
    '.summary{display:flex;gap:.75rem;margin-bottom:1rem;flex-wrap:wrap;}',
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
    '.num{text-align:right;font-variant-numeric:tabular-nums;color:#cdd6f4;}',
    'h2{font-size:.85rem;margin:1.25rem 0 .5rem;color:#94e2d5;text-transform:uppercase;letter-spacing:.04em;}',
    '</style></head><body>',
    '<h1>doc-coverage-audit <span class="sub">(lean — curated topic docs)</span></h1>',
    '<div class="meta">generated ' + esc(d.generatedAt) + '  ·  ' + esc(d.root) + '  ·  ' + d.stats.totalDocs + ' docs</div>',
    '<div class="summary">',
    coverageCards,
    '<div class="card"><b>' + d.stats.totalFindings + '</b><div class="sub">findings</div></div>',
    '<div class="card"><b>' + d.stats.high + '</b><div class="sub">high</div></div>',
    '<div class="card"><b>' + d.stats.medium + '</b><div class="sub">medium</div></div>',
    '<div class="card"><b>' + d.stats.low + '</b><div class="sub">low</div></div>',
    '</div>',
    '<h2>Rules</h2>',
    '<table><thead><tr><th>sev</th><th>kind / why</th><th class="num">hits</th></tr></thead>',
    '<tbody>' + rulesRows + '</tbody></table>',
    '<h2>Findings</h2>',
    '<table><thead><tr><th>sev</th><th>kind</th><th>location</th><th>expected / note</th></tr></thead>',
    '<tbody>' + (findRows || '<tr><td colspan=4 class="sub">No findings — docs spine is clean.</td></tr>') + '</tbody></table>',
    '</body></html>',
  ].join('\n');
}

fs.writeFileSync(OUT_HTML, renderHtml(data), 'utf8');

/* ── console summary (health-check shape: exit = finding count) ──────────── */

console.log('');
console.log('  docs enumerated   ' + stats.totalDocs);
console.log('    index    ' + coverage.index.covered  + ' / ' + coverage.index.total  + '   (' + coverage.index.pct  + '% in INDEX.md)');
console.log('    redmap   ' + coverage.redmap.covered + ' / ' + coverage.redmap.total + '   (' + coverage.redmap.pct + '% mapped in REDMAP.md)');
console.log('  findings          ' + stats.totalFindings
  + '   (' + stats.high + ' high, ' + stats.medium + ' medium, ' + stats.low + ' low)');
Object.keys(KIND_META).forEach(function (k) {
  var n = stats.byKind[k] || 0;
  var mark = n === 0 ? '✓' : (KIND_META[k].severity === 'high' ? '✗' : '⚠');
  console.log('    ' + mark + '  ' + k + (n ? '  (' + n + ')' : ''));
});
console.log('  report -> ' + path.relative(process.cwd(), OUT_HTML));

process.exit(stats.totalFindings);
