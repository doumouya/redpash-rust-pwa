#!/usr/bin/env node
/* Purpose: atomic-doc coverage + drift enforcer (atomic-doc-plan).
 * Doc: docs/internal/code/tools/audit-suite/doc-coverage-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash — doc-coverage audit
   ---------------------------------------------------------------------------
   Phase A of the atomic-doc plan (docs/internal/processes/atomic-doc-plan.md).
   Every source file under `tools/`, `frontend/scripts/`, and
   `backend/crates/` is expected to have a corresponding atomic doc under
   `docs/internal/code/<mirrored-path>.md`, AND a 2-line `Doc:` breadcrumb
   in the source pointing back at it. This tool enforces both directions.

   It also enforces *navigational* consistency: every top-level dir under
   `docs/internal/` must have a row in `docs/internal/index.md`'s shape
   ontology table, and every `.md` under `docs/internal/` should be
   referenced from `docs/internal/redmap.md`.

   Heuristic, not a parser — regex + small file walks. Findings carry
   enough context (file + line + snippet + expected doc path) to confirm
   in seconds.

   Source → doc mapping (per atomic-doc-plan §4 layout):

     backend/crates/<crate>/src/path/file.rs
       → docs/internal/code/backend/<crate>/path/file.md

     frontend/scripts/path/file.js
       → docs/internal/code/frontend/scripts/path/file.md

     tools/<name>-audit/audit.js
       → docs/internal/code/tools/audit-suite/<name>-audit.md

     tools/<name>.sh
       → docs/internal/code/tools/shell/<name>.md

     tools/{mcp-server,team,wasm-bench}/        ← single doc per dir
       → docs/internal/code/tools/<name>.md

     tools/{css-parallel,css-usage,csv-to-xlsx-rs}/   ← one-off cluster
       → docs/internal/code/tools/one-off/<name>.md

   Output:
     - report.html  (browsable, grouped by finding kind + pillar)
     - audit.json   (ingest-compatible — relax audit.run.tool CHECK to add
                    `doc-coverage` when the table comes back online)
     - console summary (matches rs-audit / rs-perf-audit shape)

   Exit code: 0. Informational only — promotion to gating waits until the
   ~156 baseline `missing_doc` findings are walked down by Phases B/C/D.

   Usage:  node audit.js [repoRoot]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');
var cp   = require('child_process');

var ROOT     = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', '..');
var OUT_HTML = path.join(__dirname, 'report.html');
var OUT_JSON = path.join(__dirname, 'audit.json');

/* ── tunables (decisions §10 of the atomic-doc-plan) ─────────────────────── */
var STALE_DAYS = 14;                                              // §10·2
var REQUIRED_HEADINGS = [                                         // §10·1
  '## Purpose',
  '## Public surface',
  '## Drift-prone areas',
];
var STUB_BODY_MIN = 40;                                           // body shorter than this counts as a stub

/* ── helpers ─────────────────────────────────────────────────────────────── */

function walk(dir, pred, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    if (ent.name === 'target' || ent.name === 'node_modules'
        || ent.name === '.git' || ent.name === '.playwright-mcp') return;
    var full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, pred, out);
    else if (ent.isFile() && pred(full)) out.push(full);
  });
  return out;
}

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function exists(p) { try { fs.statSync(p); return true; } catch (_) { return false; } }

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

/* Git mtime via `git log -1 --format=%ct <path>` — same trick rs-audit
   uses for "last touched". Uses execFileSync (no shell) so paths with
   shell metacharacters can't inject commands. Falls back to fs.mtime
   if git is unhappy (untracked file, path outside the repo). */
function gitMtime(absPath) {
  try {
    var out = cp.execFileSync('git',
      ['log', '-1', '--format=%ct', '--', absPath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (out) return parseInt(out, 10);
  } catch (_) { /* fall through */ }
  try { return Math.floor(fs.statSync(absPath).mtimeMs / 1000); } catch (_) { return 0; }
}

/* ── source → doc mapping ────────────────────────────────────────────────── */

/* Returns a list of { source, doc, pillar, kind } pairs. `source` is the
   path of the source file (or representative file for per-dir units);
   `doc` is the expected atomic-doc path. */
function enumerateUnits() {
  var units = [];

  // Backend: per-file. Drop `crates/` and `src/` from the mirror so the
  // doc tree reads as docs/internal/code/backend/api/routes/files/joins.md
  // (matches the layout in the plan §4).
  walk(path.join(ROOT, 'backend', 'crates'),
       function (f) { return f.endsWith('.rs'); })
    .forEach(function (f) {
      var r = rel(f).replace(/^backend\/crates\//, '');
      r = r.replace(/^([^\/]+)\/src\//, '$1/');   // drop the per-crate /src/
      var doc = 'docs/internal/code/backend/' + r.replace(/\.rs$/, '.md');
      units.push({ source: f, doc: path.join(ROOT, doc), pillar: 'backend', kind: 'rust-file' });
    });

  // Frontend: per-file. Mirror under code/frontend/scripts/...
  walk(path.join(ROOT, 'frontend', 'scripts'),
       function (f) { return f.endsWith('.js'); })
    .forEach(function (f) {
      var r = rel(f);
      var doc = 'docs/internal/code/' + r.replace(/\.js$/, '.md');
      units.push({ source: f, doc: path.join(ROOT, doc), pillar: 'frontend', kind: 'js-file' });
    });

  // Tools: per-category.
  // (a) audit-family — one doc per *-audit/ dir, mapped under audit-suite/.
  fs.readdirSync(path.join(ROOT, 'tools'), { withFileTypes: true })
    .filter(function (ent) {
      return ent.isDirectory() && /-audit$/.test(ent.name);
    })
    .forEach(function (ent) {
      var representative = path.join(ROOT, 'tools', ent.name, 'audit.js');
      // some -audit dirs may not have an audit.js yet — still flag them.
      var doc = 'docs/internal/code/tools/audit-suite/' + ent.name + '.md';
      units.push({
        source: representative,
        doc: path.join(ROOT, doc),
        pillar: 'tools',
        kind: 'audit-family',
        // mark when the source itself is missing (the dir exists but no audit.js)
        sourceMissing: !exists(representative),
      });
    });

  // (b) Shell scripts — tools/*.sh → code/tools/shell/<name>.md
  fs.readdirSync(path.join(ROOT, 'tools'), { withFileTypes: true })
    .filter(function (ent) { return ent.isFile() && ent.name.endsWith('.sh'); })
    .forEach(function (ent) {
      var name = ent.name.replace(/\.sh$/, '');
      var doc = 'docs/internal/code/tools/shell/' + name + '.md';
      units.push({
        source: path.join(ROOT, 'tools', ent.name),
        doc: path.join(ROOT, doc),
        pillar: 'tools',
        kind: 'shell-script',
      });
    });

  // (c) Per-dir tools — single doc covers the whole dir, regardless of
  //     internal file count: mcp-server, team, wasm-bench, memory-gc,
  //     parse-diag. (The last two aren't named in the plan §4 layout
  //     but follow the same shape — caught by this audit's first run.)
  ['mcp-server', 'team', 'wasm-bench', 'memory-gc', 'parse-diag'].forEach(function (name) {
    var dir = path.join(ROOT, 'tools', name);
    if (!exists(dir)) return;
    var doc = 'docs/internal/code/tools/' + name + '.md';
    // representative file: first .js / .ts / .html / .sh inside the dir
    var representative = pickRepresentative(dir);
    units.push({
      source: representative || dir,
      doc: path.join(ROOT, doc),
      pillar: 'tools',
      kind: 'per-dir-tool',
      sourceMissing: !representative,
    });
  });

  // (d) One-off cluster — css-parallel, css-usage, csv-to-xlsx-rs.
  ['css-parallel', 'css-usage', 'csv-to-xlsx-rs'].forEach(function (name) {
    var dir = path.join(ROOT, 'tools', name);
    if (!exists(dir)) return;
    var doc = 'docs/internal/code/tools/one-off/' + name + '.md';
    var representative = pickRepresentative(dir);
    units.push({
      source: representative || dir,
      doc: path.join(ROOT, doc),
      pillar: 'tools',
      kind: 'one-off',
      sourceMissing: !representative,
    });
  });

  // (e) Remaining tool dirs — PER-FILE, mirrored like frontend/scripts:
  //     tools/<dir>/<file>.js → docs/internal/code/tools/<dir>/<file>.md
  //     (matches the hand-authored docs: doc-gen/gen.md, lib/rust-routes.md,
  //     page-verify/verify.md, css-twin-verify/{verify,migrate}.md). Dynamic
  //     discovery (replaces the old hardcoded inclusion lists): any tools/<dir>/
  //     that isn't an *-audit dir (a), a per-dir-single tool (c), a one-off (d),
  //     or an excluded spike/output dir. A new per-file tool dir is picked up
  //     automatically. Top-level .js only (the convention these dirs use).
  var TOOL_DIR_SINGLE = { 'mcp-server': 1, 'team': 1, 'wasm-bench': 1, 'memory-gc': 1, 'parse-diag': 1 };
  var TOOL_DIR_ONEOFF = { 'css-parallel': 1, 'css-usage': 1, 'csv-to-xlsx-rs': 1 };
  var TOOL_DIR_SKIP   = { 'opfs-spike': 1, 'out': 1, 'node_modules': 1, 'screens': 1 };
  fs.readdirSync(path.join(ROOT, 'tools'), { withFileTypes: true })
    .filter(function (ent) {
      return ent.isDirectory() && !/-audit$/.test(ent.name)
        && !TOOL_DIR_SINGLE[ent.name] && !TOOL_DIR_ONEOFF[ent.name] && !TOOL_DIR_SKIP[ent.name];
    })
    .forEach(function (ent) {
      fs.readdirSync(path.join(ROOT, 'tools', ent.name), { withFileTypes: true })
        .filter(function (f) { return f.isFile() && f.name.endsWith('.js'); })
        .forEach(function (f) {
          var r = 'tools/' + ent.name + '/' + f.name;
          var doc = 'docs/internal/code/' + r.replace(/\.js$/, '.md');
          units.push({
            source: path.join(ROOT, r),
            doc: path.join(ROOT, doc),
            pillar: 'tools',
            kind: 'tool-file',
          });
        });
    });

  return units;
}

function pickRepresentative(dir) {
  var preferred = ['audit.js', 'server.js', 'index.js', 'main.js', 'main.rs', 'index.html'];
  for (var i = 0; i < preferred.length; i++) {
    var p = path.join(dir, preferred[i]);
    if (exists(p)) return p;
  }
  try {
    var entries = fs.readdirSync(dir).filter(function (n) { return !n.startsWith('.'); });
    for (var j = 0; j < entries.length; j++) {
      var full = path.join(dir, entries[j]);
      if (fs.statSync(full).isFile()) return full;
    }
  } catch (_) { /* empty */ }
  return null;
}

/* ── per-unit checks ─────────────────────────────────────────────────────── */

/* Pull the breadcrumb out of the source file's first 30 lines. Scans each
   line for a `Doc:` prefix after stripping a leading comment marker (//!, //,
   /*, *, #) AND/OR leading whitespace. The whitespace strip is the fix for the
   dominant JS style — a multi-line comment whose `Doc:` sits on an INDENTED
   continuation line with no marker:
       /* Purpose: ...
          Doc: docs/internal/code/.../x.md *​/
   The old single regex required a comment marker immediately before `Doc:`, so
   it silently missed every such file (35 false-positive missing_breadcrumb). */
function readBreadcrumb(srcPath) {
  var txt = readFileSafe(srcPath);
  if (!txt) return null;
  var lines = txt.split('\n').slice(0, 30);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s*(?:\/\/\!|\/\/|\/\*|\*|#)?\s*/, '');
    var m = /^Doc:\s*(\S+)/i.exec(line);
    if (m) return m[1].replace(/\*\/+$/, '');   // drop a trailing */ glued to the path
  }
  return null;
}

function checkRequiredHeadings(docText) {
  var missing = [];
  REQUIRED_HEADINGS.forEach(function (h) {
    if (docText.indexOf(h) === -1) missing.push(h);
  });
  return missing;
}

/* A doc may opt out of the stub check with `concise: true` in its YAML
   front-matter — for a genuinely small unit (a one-fn module, a tiny type)
   whose required sections are correctly brief, not under-written. Keeps the
   stub signal meaningful for actually-empty docs instead of blanket-lowering
   the threshold (atomic-doc-plan §10·1). */
function frontMatter(docText) {
  var m = docText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}
function isConcise(docText) {
  return /(^|\n)\s*concise:\s*true\b/.test(frontMatter(docText));
}

/* Stub detection: any required heading whose body (until the next
   `## ` heading or EOF) is shorter than STUB_BODY_MIN chars (after
   trim). Returns the names of stubbed sections. */
function findStubSections(docText) {
  if (isConcise(docText)) return [];
  var stubs = [];
  REQUIRED_HEADINGS.forEach(function (h) {
    var idx = docText.indexOf(h);
    if (idx === -1) return;
    var after = docText.slice(idx + h.length);
    var nextHeading = after.search(/\n##\s/);
    var body = nextHeading === -1 ? after : after.slice(0, nextHeading);
    if (body.replace(/\s+/g, ' ').trim().length < STUB_BODY_MIN) {
      stubs.push(h);
    }
  });
  return stubs;
}

function expectedDocRel(unit) {
  return rel(unit.doc);
}

/* ── scan ────────────────────────────────────────────────────────────────── */

var units = enumerateUnits();
var findings = [];

units.forEach(function (u) {
  // missing_doc: the most basic check.
  if (!exists(u.doc)) {
    findings.push({
      kind: 'missing_doc',
      pillar: u.pillar,
      file: rel(u.source),
      line: 0,
      expected: expectedDocRel(u),
      snippet: '',
    });
    return; // skip per-doc checks below
  }

  // Doc exists — read it once and run heading / stub / stale checks.
  var docText = readFileSafe(u.doc) || '';
  var missingHeads = checkRequiredHeadings(docText);
  missingHeads.forEach(function (h) {
    findings.push({
      kind: 'missing_required_heading',
      pillar: u.pillar,
      file: rel(u.doc),
      line: 0,
      expected: h,
      snippet: '',
    });
  });
  findStubSections(docText).forEach(function (h) {
    findings.push({
      kind: 'stub_doc',
      pillar: u.pillar,
      file: rel(u.doc),
      line: 0,
      expected: h + ' (body < ' + STUB_BODY_MIN + ' chars)',
      snippet: '',
    });
  });

  // stale_doc: source touched more recently than doc by > STALE_DAYS.
  if (!u.sourceMissing && exists(u.source)) {
    var srcT = gitMtime(u.source);
    var docT = gitMtime(u.doc);
    if (srcT && docT && srcT - docT > STALE_DAYS * 86400) {
      var days = Math.round((srcT - docT) / 86400);
      findings.push({
        kind: 'stale_doc',
        pillar: u.pillar,
        file: rel(u.doc),
        line: 0,
        expected: 'doc updated within ' + STALE_DAYS + ' days of source',
        snippet: 'source is ' + days + ' days newer than doc',
      });
    }
  }
});

/* Breadcrumb checks — separate pass because they read the source again,
   and a missing breadcrumb in a per-dir tool's representative file is
   noise. Only check for rust-file / js-file / shell-script / audit-family
   kinds. */
units.forEach(function (u) {
  if (u.kind === 'per-dir-tool' || u.kind === 'one-off') return;
  if (u.sourceMissing || !exists(u.source)) return;
  var crumb = readBreadcrumb(u.source);
  if (!crumb) {
    findings.push({
      kind: 'missing_breadcrumb',
      pillar: u.pillar,
      file: rel(u.source),
      line: 0,
      expected: 'Doc: ' + expectedDocRel(u),
      snippet: '',
    });
    return;
  }
  // wrong_breadcrumb: points to a path that doesn't exist or doesn't match the mirror rule.
  var normalised = crumb.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalised !== expectedDocRel(u)) {
    findings.push({
      kind: 'wrong_breadcrumb',
      pillar: u.pillar,
      file: rel(u.source),
      line: 0,
      expected: expectedDocRel(u),
      snippet: 'breadcrumb says: ' + crumb,
    });
  }
});

/* ── orphan_doc: every .md under docs/internal/code/ must map to a unit ── */

var unitDocs = {};
units.forEach(function (u) { unitDocs[rel(u.doc)] = true; });

walk(path.join(ROOT, 'docs', 'internal', 'code'),
     function (f) { return f.endsWith('.md'); })
  .forEach(function (f) {
    var r = rel(f);
    // index.md, _template.md, _nav.md (the generated back-index) are not unit docs.
    if (/(^|\/)(index|_template|_nav)\.md$/.test(r)) return;
    // CSS docs (frontend/styles/) have no per-file source-enumeration rule
    // (the touch-policy scopes to tools/ + frontend/scripts/ + backend/crates/),
    // so they're allowed "extra" docs, not orphans.
    if (r.indexOf('docs/internal/code/frontend/styles/') === 0) return;
    if (!unitDocs[r]) {
      findings.push({
        kind: 'orphan_doc',
        pillar: 'docs',
        file: r,
        line: 0,
        expected: 'no source file maps to this doc',
        snippet: '',
      });
    }
  });

/* ── navigational consistency ────────────────────────────────────────────── */

// unregistered_section: every top-level dir under docs/internal/ should
// be a row in docs/internal/index.md's Sections table.
var sectionsText = readFileSafe(path.join(ROOT, 'docs', 'internal', 'index.md')) || '';
var registeredSections = {};
// crude table-row parse: any markdown table row whose first cell is a
// markdown link [name](name/index.md) — that name is a registered section.
sectionsText.split('\n').forEach(function (line) {
  var m = /\|\s*\[([a-z][a-z0-9_-]*)\]\(([a-z0-9_-]+)\/index\.md\)/i.exec(line);
  if (m) registeredSections[m[1]] = true;
});

if (exists(path.join(ROOT, 'docs', 'internal'))) {
  fs.readdirSync(path.join(ROOT, 'docs', 'internal'), { withFileTypes: true })
    .filter(function (ent) { return ent.isDirectory() && !ent.name.startsWith('.'); })
    .forEach(function (ent) {
      if (!registeredSections[ent.name]) {
        findings.push({
          kind: 'unregistered_section',
          pillar: 'docs',
          file: 'docs/internal/' + ent.name + '/',
          line: 0,
          expected: 'row in docs/internal/index.md Sections table',
          snippet: '',
        });
      }
    });
}

// unindexed_internal_doc: every .md under docs/internal/ should be reachable
// from a navigation index. The spine docs are indexed from redmap.md; the
// per-file survival layer under code/ is indexed from the GENERATED
// code/_nav.md back-index (doc-gen --code-nav) — hand-listing 266 atomic docs
// in redmap is the "absorb the catalog" anti-pattern the atomic-doc-plan warns
// against, so the generator owns that index and this check reads it.
var redmapText  = readFileSafe(path.join(ROOT, 'docs', 'internal', 'redmap.md')) || '';
var codeNavText = readFileSafe(path.join(ROOT, 'docs', 'internal', 'code', '_nav.md')) || '';
// A doc is also "indexed" if its own section's index.md lists it by basename —
// every spine section (pages/, db/schemas/, rest-api/, db/rbac/, …) is its own
// nav, so the structure is self-indexing instead of duplicating a catalog into
// redmap (the "absorb the catalog" anti-pattern).
function dirIndexLists(absDocPath) {
  if (path.basename(absDocPath) === 'index.md') return false;
  var t = readFileSafe(path.join(path.dirname(absDocPath), 'index.md'));
  return !!t && t.indexOf(path.basename(absDocPath)) !== -1;
}
walk(path.join(ROOT, 'docs', 'internal'),
     function (f) { return f.endsWith('.md'); })
  .forEach(function (f) {
    var r = rel(f);
    if (r === 'docs/internal/redmap.md' || r === 'docs/internal/index.md') return;
    var fromInternal = r.replace(/^docs\/internal\//, '');
    var indexed = redmapText.indexOf(fromInternal) !== -1;
    // code/ docs: indexed via the generated back-index (links are relative to code/).
    if (!indexed && r.indexOf('docs/internal/code/') === 0) {
      if (/(^|\/)(index|_template|_nav)\.md$/.test(r)) { indexed = true; }
      else {
        var fromCode = r.replace(/^docs\/internal\/code\//, '');
        indexed = codeNavText.indexOf(fromCode) !== -1;
      }
    }
    // spine docs: indexed by their own section's index.md.
    if (!indexed) indexed = dirIndexLists(f);
    if (!indexed) {
      findings.push({
        kind: 'unindexed_internal_doc',
        pillar: 'docs',
        file: r,
        line: 0,
        expected: r.indexOf('docs/internal/code/') === 0
          ? 'listed in the generated docs/internal/code/_nav.md (run doc-gen --code-nav)'
          : 'cross-link from docs/internal/redmap.md',
        snippet: '',
      });
    }
  });

/* ── aggregate ───────────────────────────────────────────────────────────── */

var KIND_META = {
  missing_doc:              { severity: 'high',   why: 'Source file has no atomic doc.'                                                },
  missing_breadcrumb:       { severity: 'medium', why: 'Source file has no `Doc:` line in its first 30 lines.'                        },
  wrong_breadcrumb:         { severity: 'medium', why: '`Doc:` line points to a path that does not match the expected mirror.'        },
  stub_doc:                 { severity: 'low',    why: 'Required heading body is shorter than ' + STUB_BODY_MIN + ' chars.'           },
  stale_doc:                { severity: 'medium', why: 'Source has been touched more recently than the doc by > ' + STALE_DAYS + 'd.' },
  orphan_doc:               { severity: 'medium', why: 'Atomic doc exists but no source maps to it.'                                  },
  missing_required_heading: { severity: 'high',   why: 'Doc is missing one of the required headings.'                                 },
  unregistered_section:     { severity: 'high',   why: 'New section under docs/internal/ not in the shape-ontology table.'            },
  unindexed_internal_doc:   { severity: 'low',    why: 'Internal doc not cross-linked from docs/internal/redmap.md.'                  },
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
  totalUnits: units.length,
  totalFindings: findings.length,
  high: findings.filter(function (f) { return sev(f.kind) === 'high'; }).length,
  medium: findings.filter(function (f) { return sev(f.kind) === 'medium'; }).length,
  low: findings.filter(function (f) { return sev(f.kind) === 'low'; }).length,
  byKind: {},
  byPillar: {},
};
findings.forEach(function (f) {
  stats.byKind[f.kind]    = (stats.byKind[f.kind]    || 0) + 1;
  stats.byPillar[f.pillar] = (stats.byPillar[f.pillar] || 0) + 1;
});

var coverage = {};
['backend', 'frontend', 'tools'].forEach(function (p) {
  var total = units.filter(function (u) { return u.pillar === p; }).length;
  var missing = findings.filter(function (f) {
    return f.pillar === p && f.kind === 'missing_doc';
  }).length;
  coverage[p] = { total: total, documented: total - missing,
                  pct: total ? Math.round((total - missing) / total * 1000) / 10 : 0 };
});

var data = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  thresholds: { staleDays: STALE_DAYS, stubBodyMin: STUB_BODY_MIN,
                requiredHeadings: REQUIRED_HEADINGS },
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
  var coverageCards = ['backend', 'frontend', 'tools'].map(function (p) {
    var c = d.coverage[p];
    return '<div class="card"><b>' + c.pct + '%</b>'
      + '<div class="sub">' + esc(p) + ' · ' + c.documented + ' / ' + c.total + '</div></div>';
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
    '<h1>doc-coverage-audit</h1>',
    '<div class="meta">generated ' + esc(d.generatedAt) + '  ·  ' + esc(d.root) + '</div>',
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
    '<tbody>' + (findRows || '<tr><td colspan=4 class="sub">No findings — coverage is clean.</td></tr>') + '</tbody></table>',
    '</body></html>',
  ].join('\n');
}

fs.writeFileSync(OUT_HTML, renderHtml(data), 'utf8');

/* ── console summary (matches rs-audit / rs-perf-audit shape) ───────────── */

console.log('');
console.log('  units enumerated  ' + stats.totalUnits);
['backend', 'frontend', 'tools'].forEach(function (p) {
  var c = coverage[p];
  console.log('    ' + p.padEnd(10) + '   ' + c.documented + ' / ' + c.total
    + '   (' + c.pct + '% documented)');
});
console.log('  findings          ' + stats.totalFindings
  + '   (' + stats.high + ' high, '
  + stats.medium + ' medium, '
  + stats.low + ' low)');
Object.keys(KIND_META).forEach(function (k) {
  var n = stats.byKind[k] || 0;
  var mark = n === 0 ? '✓' : (KIND_META[k].severity === 'high' ? '✗' : '⚠');
  console.log('    ' + mark + '  ' + k + (n ? '  (' + n + ')' : ''));
});
console.log('  report -> ' + path.relative(process.cwd(), OUT_HTML));
