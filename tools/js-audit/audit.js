#!/usr/bin/env node
/* Purpose: frontend JS refactor audit — LOC / duplicates / unreachable (AST via Acorn).
 * Doc: docs/internal/code/frontend/ (audit-suite docs land here as the suite matures).
 * ──────────────────────────────────────────────────────────────────────────
   RedPash JS — refactoring audit (v2.0 AST Edition, lean-adapted)
   ---------------------------------------------------------------------------
   A static scan of the lean frontend/ tree. Codifies the refactor review into
   a repeatable CI/CD tool. Reconciled from prerelease's tools/js-audit/audit.js
   (the source of truth) and adapted to the lean cut's layout:

     - FE root is `frontend/` (prerelease had `frontend/scripts/`).
     - Boot/entry is `frontend/framework/boot/main.js`, referenced from
       `frontend/index.html` as `<script type=module src=/framework/boot/main.js>`.
     - Components live at `frontend/framework/<component>/<component>.js`;
       built pages at `frontend/apps/<app>/<page>/<page>.js`. The built-page
       set is the SECOND root source: main.js dynamic-imports each built page
       via a template literal (`/apps/${app}/${page}/${page}.js`) that the
       static graph can't follow, so we seed those roots from apps.js.
     - Module specifiers are relative (`./`, `../…`); absolute runtime URLs
       use `/framework/…` and `/apps/…` (prerelease's `/scripts/…` is retired).

   Upgrades over the regex version:
     - Acorn AST for 100% accurate import / definition extraction
       (no false positives from `function esc` inside comments or
       strings). Acorn is the one carve-out from the project's no-
       framework rule — sanctioned for static-analysis tooling
       under `tools/*` only, NEVER in frontend / backend runtime
       (see [[feedback-acorn-allowed-for-static-analysis]]).
     - CI/CD-ready: `process.exit(1)` when extracted-pattern count
       > 0 (regressions break the build, not just the report).

   DANGER: `--inject-probes` is destructive — it writes
       console.warn("🧟 ZOMBIE MODULE LOADED: …")
   into every statically-unreachable .js file so you can confirm
   at runtime which "dead" modules are actually loaded by paths
   the static graph can't see. **Run only on a clean tree** and
   revert with `git checkout frontend/` once you've inspected the
   browser console. Don't ship a build with probes.

   Usage:  node audit.js [srcDir] [--inject-probes]
   Output: ./report.html  +  a console summary
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

// Parse CLI arguments
const args = process.argv.slice(2);
const INJECT_PROBES = args.includes('--inject-probes');
const srcArg = args.find(a => !a.startsWith('--'));

// Lean FE root is `frontend/` (prerelease used `frontend/scripts`).
const SRC_DIR = srcArg
  ? path.resolve(srcArg)
  : path.join(__dirname, '..', '..', 'frontend');
const OUT = path.join(__dirname, 'report.html');
const GOD_LOC = 800;

/* ── pattern catalog ─────────────────────────────────────────────────────────
   Adapted to lean: prerelease's echarts/dropdown/list-page/kpi/file_type-gate
   patterns are dropped — those helpers (echarts-theme.js, dropdown.js,
   list-page.js, echarts-kpi.js) and the `file_type` caller-gate policy DO NOT
   exist in the lean cut (no echarts in the FE; no `file_type` concept; no
   DATA-ENDPOINT-ACK convention). Keeping them would emit permanent noise
   against a model lean doesn't have. What remains is structural + portable:
   the helper-dedup contract (esc/cssEsc must live only in boot/dom.js) and two
   vertical-agnostic "declined" watchers. `esc` is the live helper in lean
   (frontend/framework/boot/dom.js); `cssEsc` isn't defined yet but the guard
   stays so a future re-introduction outside dom.js trips the gate.            */
const PATTERNS = [
  { name: 'esc() redefined outside boot/dom.js', status: 'extracted',
    rx: /\bfunction\s+esc\s*\(/g, skip: /(^|\/)boot\/dom\.js$/,
    helper: 'import { esc } from "/framework/boot/dom.js"', saving: 1 },
  { name: 'cssEsc() redefined outside boot/dom.js', status: 'extracted',
    rx: /\bfunction\s+cssEsc\s*\(/g, skip: /(^|\/)boot\/dom\.js$/,
    helper: 'add cssEsc to /framework/boot/dom.js and import it', saving: 1 },

  { name: 'boot/dom.js helper import', status: 'live',
    rx: /\bfrom\s+['"][^'"]*\/dom\.js['"]/g, helper: '(helper)' },

  { name: 'inline-HTML string concat (\'<…\' + esc(…))', status: 'declined',
    rx: /(['"])<[^<>]*?\1\s*\+\s*esc\s*\(/g, helper: 'wait for convergence' },
  { name: 'setTimeout(…, ms) ad-hoc timing', status: 'declined',
    rx: /\bsetTimeout\s*\(/g, helper: 'wait for convergence' }
];

/* ── helper functions ────────────────────────────────────────────────────── */

// Pull the built-page module paths out of apps.js — these are dynamic-import
// roots (main.js: `import(`/apps/${app}/${page}/${page}.js`)`) the static
// import graph can't see because the specifier is a template literal. We read
// apps.js as text and extract every `{ id: "<page>", … built: true }` under
// its owning app block. Resilient to formatting: we walk app blocks by `id:`.
const discoverBuiltPageRoots = (srcDir, fileSet) => {
  const found = [];
  const appsPath = path.join(srcDir, 'framework', 'boot', 'apps.js');
  let txt;
  try { txt = fs.readFileSync(appsPath, 'utf8'); } catch { return found; }

  // Find each app block: `id: "<app>"` followed (later) by a `pages: [ … ]`.
  // We scan the whole APPS array, tracking the most-recent top-level app id.
  // App ids and page ids both appear as `id: "<x>"`; an app id is the first
  // id after `{` that is later followed by `pages:`. Simpler + robust enough:
  // capture the app id, then every page `{ … id: "<p>" … built: true }` until
  // the next app id. We approximate by splitting on `pages:` per app.
  const appRe = /id:\s*["']([\w-]+)["'][\s\S]*?pages:\s*\[([\s\S]*?)\]/g;
  let am;
  while ((am = appRe.exec(txt))) {
    const appId = am[1];
    const pagesBlock = am[2];
    // Each page object inside pagesBlock that has built: true.
    const pageRe = /\{([^{}]*)\}/g;
    let pm;
    while ((pm = pageRe.exec(pagesBlock))) {
      const obj = pm[1];
      if (!/\bbuilt:\s*true\b/.test(obj)) continue;
      const idm = /id:\s*["']([\w-]+)["']/.exec(obj);
      if (!idm) continue;
      const pageId = idm[1];
      const rel = `apps/${appId}/${pageId}/${pageId}.js`;
      if (fileSet[rel]) found.push(rel);
    }
  }
  return found;
};

// String-loaded runtime entrypoints the STATIC import graph fundamentally
// can't follow, but the SHIPPED app really loads:
//   - Web Workers:        new Worker(new URL("/framework/engine/engine-worker.js", …))
//   - wasm-bindgen glue:   import.meta.resolve("/wasm/data.js") / new URL("/wasm/…js")
// We sweep ALL files for these `/framework|/apps|/wasm/…js` URL-string targets
// and seed them as roots. (NOT framework-sandbox.html — that dev/QA harness
// statically imports every component, so counting it as a root would mask real
// production orphans, defeating the dead-code signal. Prerelease scanned only
// the shipped surface; we keep that intent.)
const discoverStringLoadRoots = (files, fileSet) => {
  const out = [];
  const re = /(?:new\s+Worker\s*\(\s*new\s+URL|import\.meta\.resolve|new\s+URL)\s*\(\s*['"`](\/(?:framework|apps|wasm)\/[A-Za-z0-9_.\/-]+\.js)['"`]/g;
  files.forEach(f => {
    let txt;
    try { txt = fs.readFileSync(f.full, 'utf8'); } catch { return; }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(txt))) {
      const rel = m[1].replace(/^\//, '');
      if (fileSet[rel]) out.push(rel);
    }
  });
  return out;
};

const discoverRoots = (srcDir, fileSet, files) => {
  const roots = {};
  const mark = (rel) => { if (fileSet[rel]) roots[rel] = true; };

  // 1. The <script type=module> boot entry declared in index.html, plus the
  //    boot module + service worker. Lean uses /framework/… and /apps/…
  //    absolute URLs (no /scripts/), so the regex captures those families.
  [ path.join(srcDir, 'index.html'),
    path.join(srcDir, 'framework', 'boot', 'main.js'),
    path.join(srcDir, 'service-worker.js') ].forEach(p => {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const re = /\/(?:framework|apps)\/[A-Za-z0-9_.\/-]+\.js/g;
      let m;
      while ((m = re.exec(txt))) mark(m[0].replace(/^\//, ''));
    } catch (e) { /* ignore missing */ }
  });

  // 2. Always treat the boot module + service worker as roots. index.html
  //    references main.js; the SW is registered by a string URL the static
  //    graph never sees, but it IS a shipped entrypoint.
  mark('framework/boot/main.js');
  mark('service-worker.js');

  // 3. Dynamic-import roots: every BUILT page module from apps.js. These are
  //    unreachable in the static graph (template-literal specifier) but are
  //    real entrypoints — without seeding them, every page + its private
  //    imports would show as false-positive "unreachable".
  discoverBuiltPageRoots(srcDir, fileSet).forEach(mark);

  // 4. Worker + wasm-glue string-load roots (see discoverStringLoadRoots).
  discoverStringLoadRoots(files, fileSet).forEach(mark);

  return roots;
};

const walk = (dir, acc = []) => {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && /\.js$/i.test(e.name)) acc.push(full);
  });
  return acc;
};

const resolveSpec = (fromRel, spec, fileSet) => {
  let p;
  if (spec.startsWith('.')) {
    p = path.posix.normalize(path.posix.dirname(fromRel) + '/' + spec);
  } else if (spec.startsWith('/framework/') || spec.startsWith('/apps/')) {
    // Lean absolute runtime URL → repo-relative (rel paths are SRC_DIR-relative,
    // and SRC_DIR is `frontend/`, so strip the leading slash).
    p = spec.slice(1);
  } else {
    return null;
  }
  const cands = [p, p + '.js', p.replace(/\/+$/, '') + '/index.js'];
  return cands.find(c => fileSet[c]) || null;
};

// Recursive AST walker for deep `require` or dynamic `import()` calls
const walkAst = (node, visitor) => {
  if (!node) return;
  visitor(node);
  for (const key in node) {
    if (node[key] && typeof node[key] === 'object') {
      if (Array.isArray(node[key])) {
        node[key].forEach(child => walkAst(child, visitor));
      } else if (typeof node[key].type === 'string') {
        walkAst(node[key], visitor);
      }
    }
  }
};

/* ── scan ────────────────────────────────────────────────────────────────── */
console.log(`Scanning ${SRC_DIR} …`);
const diskPaths = walk(SRC_DIR).sort();
if (!diskPaths.length) { console.error('No .js files found.'); process.exit(1); }

const fileSet = Object.fromEntries(diskPaths.map(full => [
  path.relative(SRC_DIR, full).split(path.sep).join('/'), true
]));

const files = diskPaths.map(full => ({
  full,
  rel: path.relative(SRC_DIR, full).split(path.sep).join('/'),
  defs: [],
  importSpecs: []
}));

const patternHits = PATTERNS.map(() => ({ total: 0, files: {} }));

files.forEach(f => {
  const text = fs.readFileSync(f.full, 'utf8');
  f.loc = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;

  // AST Parsing for bulletproof definition & import extraction
  try {
    const ast = acorn.parse(text, { ecmaVersion: 2024, sourceType: 'module' });

    // 1. Top-level Definitions
    ast.body.forEach(node => {
      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach(d => { if (d.id?.name) f.defs.push(d.id.name); });
      } else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        if (node.id?.name) f.defs.push(node.id.name);
      } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        if (node.declaration.type === 'VariableDeclaration') {
          node.declaration.declarations.forEach(d => { if (d.id?.name) f.defs.push(d.id.name); });
        } else if (node.declaration.id?.name) {
          f.defs.push(node.declaration.id.name);
        }
      }
    });

    // 2. Imports (Static, Dynamic, and Requires)
    walkAst(ast, node => {
      if (node.type === 'ImportDeclaration') {
        f.importSpecs.push(node.source.value);
      } else if (node.type === 'CallExpression') {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') {
          f.importSpecs.push(node.arguments[0].value);
        } else if (node.callee.type === 'Import' && node.arguments[0]?.type === 'Literal') {
          f.importSpecs.push(node.arguments[0].value);
        }
      }
    });
  } catch (e) {
    console.warn(`  ⚠️ AST Parse error in ${f.rel}: ${e.message} (Falling back to empty graph)`);
  }

  // Regex pass for Antipatterns — never lint the audit tool itself.
  if (/(^|\/)tools\/js-audit\//.test(f.rel)) return;
  PATTERNS.forEach((p, i) => {
    if (p.skip && p.skip.test(f.rel)) return;
    p.rx.lastIndex = 0;
    let pm, n = 0;
    while ((pm = p.rx.exec(text)) !== null) {
      if (pm.index === p.rx.lastIndex) p.rx.lastIndex++;

      // ACK Comment Logic (kept generic; no pattern uses it in lean yet)
      if (p.ackComment) {
        let lineStart = text.lastIndexOf('\n', pm.index - 1) + 1;
        let windowStart = lineStart;
        for (let w = 0; w < 6 && windowStart > 0; w++) {
          windowStart = text.lastIndexOf('\n', windowStart - 2) + 1;
        }
        if (p.ackComment.test(text.slice(windowStart, lineStart))) continue;
      }
      n++;
    }
    if (n > 0) {
      patternHits[i].total += n;
      patternHits[i].files[f.rel] = (patternHits[i].files[f.rel] || 0) + n;
    }
  });
});

/* ── Graph Analysis ──────────────────────────────────────────────────────── */
const importedBy = Object.fromEntries(files.map(f => [f.rel, []]));

files.forEach(f => {
  const seen = new Set();
  f.imports = [];
  f.importSpecs.forEach(spec => {
    const t = resolveSpec(f.rel, spec, fileSet);
    if (t && fileSet[t] && t !== f.rel && !seen.has(t)) {
      seen.add(t);
      f.imports.push(t);
      importedBy[t].push(f.rel);
    }
  });
});

const roots = discoverRoots(SRC_DIR, fileSet, files);
const byRel = Object.fromEntries(files.map(f => [f.rel, f]));
const reachable = new Set();
const queue = Object.keys(roots);

while (queue.length) {
  const cur = queue.shift();
  if (reachable.has(cur)) continue;
  reachable.add(cur);
  if (byRel[cur]) byRel[cur].imports.forEach(t => {
    if (!reachable.has(t)) queue.push(t);
  });
}

files.forEach(f => {
  f.importedBy = importedBy[f.rel];
  f.dead = !reachable.has(f.rel);
  f.god = f.loc > GOD_LOC;
});

/* ── Data Rollup ─────────────────────────────────────────────────────────── */
const defsByName = {};
files.forEach(f => {
  const seen = new Set();
  f.defs.forEach(name => {
    if (seen.has(name)) return;
    seen.add(name);
    (defsByName[name] = defsByName[name] || []).push(f.rel);
  });
});

const dupes = Object.entries(defsByName)
  .filter(([_, arr]) => arr.length >= 2)
  .map(([name, arr]) => ({ name, count: arr.length, files: arr.sort() }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const dead = files.filter(f => f.dead).sort((a, b) => b.loc - a.loc);
const REVISIT_THRESHOLD = 20;

const patterns = PATTERNS.map((p, i) => ({
  ...p,
  total: patternHits[i].total,
  files: Object.entries(patternHits[i].files).sort().map(([file, n]) => ({ file, n }))
}));

const regressions = patterns.filter(p => p.status === 'extracted' && p.total > 0).reduce((acc, p) => acc + p.total, 0);
const pending = patterns.filter(p => p.status === 'declined' && p.total > REVISIT_THRESHOLD).length;

const data = {
  generatedAt: new Date().toISOString(),
  srcDir: SRC_DIR, godLoc: GOD_LOC, revisitThreshold: REVISIT_THRESHOLD,
  stats: {
    files: files.length,
    loc: files.reduce((n, f) => n + f.loc, 0),
    deadModules: dead.length,
    deadLoc: dead.reduce((n, f) => n + f.loc, 0),
    dupSymbols: dupes.length,
    godObjects: files.filter(f => f.god).length,
    regressions, pendingDeclined: pending
  },
  files: files.map(f => ({
    rel: f.rel, loc: f.loc, defs: f.defs.length,
    imports: f.importSpecs.length, importedBy: f.importedBy.length,
    dead: f.dead, god: f.god
  })).sort((a, b) => b.loc - a.loc),
  dead: dead.map(f => ({ rel: f.rel, loc: f.loc })), dupes, patterns
};

/* ── HTML Generator (Template Literals) ──────────────────────────────────── */
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RedPash JS audit</title>
  <style>
    :root { --bg: #0d1117; --panel: #11161f; --panel2: #161c28; --line: #222b3a;
            --text: #d6dbe5; --muted: #7c8699; --accent: #b3001b; --accent2: #5b8cff;
            --bad: #ff5d6c; --warn: #e0a64b; --ok: #3fb56b; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, sans-serif; }
    header { padding: 22px 26px 14px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    .muted { color: var(--muted); font-weight: 400; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .cards { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 26px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; min-width: 118px; }
    .card .n { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .card .l { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .card.bad .n { color: var(--bad); } .card.warn .n { color: var(--warn); }
    .tabs { display: flex; gap: 4px; padding: 0 26px; border-bottom: 1px solid var(--line); }
    .tab { background: none; border: 0; color: var(--muted); padding: 10px 14px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .panel { padding: 14px 26px 80px; } .panel.hidden { display: none; }
    .toolbar { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
    .toolbar input { background: var(--panel2); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 7px 11px; width: 300px; }
    .chk { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 5px; cursor: pointer; }
    .count { color: var(--muted); font-size: 12px; margin-left: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th { position: sticky; top: 0; background: var(--panel); text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); padding: 9px 10px; border-bottom: 1px solid var(--line); cursor: pointer; }
    th.num { text-align: right; } th.sorted { color: var(--text); }
    th.sorted::after { content: " \\25be"; color: var(--accent2); } th.sorted.asc::after { content: " \\25b4"; }
    tbody tr { border-bottom: 1px solid var(--line); } tbody tr:hover { background: var(--panel); }
    tbody td { padding: 7px 10px; vertical-align: top; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; color: #e6ebf2; }
    .pill { display: inline-block; padding: 1px 6px; border-radius: 6px; font-size: 10px; font-weight: 600; margin-left: 6px; }
    .pill.bad { background: rgba(255,93,108,.15); color: var(--bad); } .pill.warn { background: rgba(224,166,75,.16); color: var(--warn); } .pill.ok { background: rgba(63,181,107,.16); color: var(--ok); } .pill.dim { background: #1d2433; color: var(--muted); }
    .where { color: var(--muted); font-size: 11px; margin-top: 3px; font-family: ui-monospace, Consolas, monospace; }
    .empty { padding: 40px; text-align: center; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>JS refactoring audit <span class="muted">· RedPash</span></h1>
    <div class="sub" id="sub"></div>
  </header>
  <section class="cards" id="cards"></section>
  <nav class="tabs">
    <button class="tab active" data-tab="files">Files</button>
    <button class="tab" data-tab="dead">Unreachable</button>
    <button class="tab" data-tab="dupes">Duplicate symbols</button>
    <button class="tab" data-tab="patterns">Patterns</button>
  </nav>

  <div class="panel" id="panel-files">
    <div class="toolbar"><input id="q-files" placeholder="Filter files…" autocomplete="off">
      <label class="chk"><input type="checkbox" id="only-god"> only god-objects</label>
      <span class="count" id="count-files"></span></div>
    <table id="t-files"><thead><tr>
      <th data-k="rel">File</th><th data-k="loc" class="num">LOC</th>
      <th data-k="defs" class="num">Defs</th><th data-k="imports" class="num">Imports</th><th data-k="importedBy" class="num">Imported by</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="panel hidden" id="panel-dead">
    <div class="toolbar"><span class="count" id="count-dead"></span></div>
    <table id="t-dead"><thead><tr>
      <th data-k="rel">Statically unreachable from any root — candidate, confirm</th><th data-k="loc" class="num">LOC</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="panel hidden" id="panel-dupes">
    <div class="toolbar"><input id="q-dupes" placeholder="Filter symbol names…" autocomplete="off">
      <span class="count" id="count-dupes"></span></div>
    <table id="t-dupes"><thead><tr>
      <th data-k="name">Symbol</th><th data-k="count" class="num">Files</th><th data-k="where">Defined in</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="panel hidden" id="panel-patterns">
    <div class="toolbar">
      <label class="chk"><input type="checkbox" id="only-regressions"> regressions only</label>
      <span class="count" id="count-patterns"></span></div>
    <table id="t-patterns"><thead><tr>
      <th data-k="status">Status</th><th data-k="name">Pattern</th><th data-k="total" class="num">Hits</th><th data-k="helper">Helper / verdict</th>
    </tr></thead><tbody></tbody></table>
  </div>

  <script>const DATA = ${JSON.stringify(data).replace(/<\//g, '<\\/')};</script>
  <script>
    // Modern ES6 UI Script
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

    document.getElementById('sub').textContent = \`\${DATA.srcDir}  —  generated \${new Date(DATA.generatedAt).toLocaleString()}\`;

    const cards = [
      ['Files', DATA.stats.files, ''], ['Lines of code', DATA.stats.loc, ''],
      ['Unreachable', DATA.stats.deadModules, 'bad'], ['Unreachable LOC', DATA.stats.deadLoc, 'bad'],
      ['Duplicate symbols', DATA.stats.dupSymbols, 'warn'],
      [\`God-objects (>\${DATA.godLoc})\`, DATA.stats.godObjects, 'warn'],
      ['Pattern regressions', DATA.stats.regressions, DATA.stats.regressions ? 'bad' : ''],
      ['Declined over threshold', DATA.stats.pendingDeclined, DATA.stats.pendingDeclined ? 'warn' : '']
    ];

    document.getElementById('cards').innerHTML = cards.map(c =>
      \`<div class="card \${c[2]}"><div class="n">\${c[1]}</div><div class="l">\${c[0]}</div></div>\`
    ).join('');

    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => tab.addEventListener('click', function() {
      tabs.forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      const tId = this.dataset.tab;
      ['files','dead','dupes','patterns'].forEach(p =>
        document.getElementById('panel-'+p).classList.toggle('hidden', p !== tId)
      );
    }));

    const sortRows = (rows, st) => rows.sort((a, b) => {
      const d = typeof a[st.k] === 'string' ? a[st.k].localeCompare(b[st.k]) : a[st.k] - b[st.k];
      return st.asc ? d : -d;
    });

    const wireSort = (id, st, renderFn) => {
      const ths = document.querySelectorAll(\`#\${id} thead th\`);
      const paint = () => ths.forEach(th => {
        th.classList.remove('sorted', 'asc');
        if (th.dataset.k === st.k) { th.classList.add('sorted'); if (st.asc) th.classList.add('asc'); }
      });
      ths.forEach(th => th.addEventListener('click', () => {
        if (!th.dataset.k) return;
        if (st.k === th.dataset.k) st.asc = !st.asc; else { st.k = th.dataset.k; st.asc = false; }
        paint(); renderFn();
      }));
      paint();
    };

    const fSort = {k:'loc', asc:false};
    const renderFiles = () => {
      const q = document.getElementById('q-files').value.toLowerCase();
      const og = document.getElementById('only-god').checked;
      const rows = DATA.files.filter(r => (!og || r.god) && (!q || r.rel.toLowerCase().includes(q)));
      sortRows(rows, fSort);
      document.getElementById('count-files').textContent = \`\${rows.length} of \${DATA.files.length}\`;
      document.querySelector('#t-files tbody').innerHTML = rows.length ? rows.map(r => \`
        <tr><td><span class="mono">\${esc(r.rel)}</span>
        \${r.dead ? '<span class="pill bad">unreached</span>' : ''}\${r.god ? '<span class="pill warn">god</span>' : ''}</td>
        <td class=num>\${r.loc}</td><td class=num>\${r.defs}</td><td class=num>\${r.imports}</td><td class=num>\${r.importedBy}</td></tr>
      \`).join('') : '<tr><td colspan=5 class=empty>No matches.</td></tr>';
    };

    const renderDead = () => {
      document.getElementById('count-dead').textContent = \`\${DATA.dead.length} unreachable · \${DATA.stats.deadLoc} LOC\`;
      document.querySelector('#t-dead tbody').innerHTML = DATA.dead.length ? DATA.dead.map(r => \`
        <tr><td><span class="mono">\${esc(r.rel)}</span></td><td class=num>\${r.loc}</td></tr>
      \`).join('') : '<tr><td colspan=2 class=empty>Nothing unreachable.</td></tr>';
    };

    const uSort = {k:'count', asc:false};
    const renderDupes = () => {
      const q = document.getElementById('q-dupes').value.toLowerCase();
      const rows = DATA.dupes.filter(r => !q || r.name.toLowerCase().includes(q));
      sortRows(rows, uSort);
      document.getElementById('count-dupes').textContent = \`\${rows.length} of \${DATA.dupes.length}\`;
      document.querySelector('#t-dupes tbody').innerHTML = rows.length ? rows.map(r => \`
        <tr><td><span class="mono">\${esc(r.name)}</span></td><td class=num>\${r.count}</td>
        <td><span class="where">\${esc(r.files.join('  ·  '))}</span></td></tr>
      \`).join('') : '<tr><td colspan=3 class=empty>No matches.</td></tr>';
    };

    const pSort = {k:'total', asc:false};
    const renderPatterns = () => {
      const or = document.getElementById('only-regressions').checked;
      const rows = DATA.patterns.filter(r => !or || (r.status === 'extracted' && r.total > 0));
      sortRows(rows, pSort);
      document.getElementById('count-patterns').textContent = \`\${rows.length} of \${DATA.patterns.length}\`;
      document.querySelector('#t-patterns tbody').innerHTML = rows.length ? rows.map(r => {
        const cls = r.status === 'extracted' ? (r.total > 0 ? 'bad' : 'ok') : r.status === 'declined' ? (r.total > DATA.revisitThreshold ? 'warn' : 'dim') : 'dim';
        const where = r.files.length ? \`<div class="where">\${r.files.map(f => \`\${esc(f.file)} (\${f.n})\`).join('  ·  ')}</div>\` : '';
        return \`<tr><td><span class="pill \${cls}">\${r.status}</span></td>
        <td><span class="mono">\${esc(r.name)}</span>\${r.notes ? \`<div class="where">\${esc(r.notes)}</div>\` : ''}\${where}</td>
        <td class=num>\${r.total}</td><td>\${esc(r.helper)}</td></tr>\`;
      }).join('') : '<tr><td colspan=4 class=empty>No patterns matched.</td></tr>';
    };

    document.getElementById('q-files').addEventListener('input', renderFiles);
    document.getElementById('only-god').addEventListener('change', renderFiles);
    document.getElementById('q-dupes').addEventListener('input', renderDupes);
    document.getElementById('only-regressions').addEventListener('change', renderPatterns);

    wireSort('t-files', fSort, renderFiles);
    wireSort('t-dupes', uSort, renderDupes);
    wireSort('t-patterns', pSort, renderPatterns);

    renderFiles(); renderDead(); renderDupes(); renderPatterns();
  </script>
</body>
</html>`;

fs.writeFileSync(OUT, HTML, 'utf8');

/* ── Console Output & Probes ─────────────────────────────────────────────── */
console.log('\n  📊 Stats:');
console.log(`    Files scanned:     ${data.stats.files} (${data.stats.loc} LOC)`);
console.log(`    Unreachable:       ${data.stats.deadModules} (${data.stats.deadLoc} LOC)`);
console.log(`    Duplicate symbols: ${data.stats.dupSymbols}`);
console.log(`    God-objects:       ${data.stats.godObjects}`);

console.log('\n  🎯 Patterns:');
patterns.forEach(p => {
  const glyph = p.status === 'extracted' ? (p.total > 0 ? '❌' : '✅') : p.status === 'declined' ? (p.total > REVISIT_THRESHOLD ? '⚠️' : '•') : ' ';
  console.log(`    ${glyph} ${p.status.padEnd(9)} ${String(p.total).padStart(4, ' ')} hits  ${p.name}`);
});

console.log(`\n  📄 Report saved to: ${OUT}`);

/* ── Runtime Probes Logic ────────────────────────────────────────────────── */
if (INJECT_PROBES && dead.length > 0) {
  console.log(`\n💉 Injecting runtime probes into ${dead.length} unreachable files...`);
  dead.forEach(f => {
    const probe = `\nconsole.warn("🧟 ZOMBIE MODULE LOADED: ${f.rel}");\n`;
    const content = fs.readFileSync(f.full, 'utf8');
    if (!content.includes('ZOMBIE MODULE LOADED')) {
      fs.writeFileSync(f.full, probe + content, 'utf8');
    }
  });
  console.log('   Probes injected. Run your app and check the browser console.');
}

/* ── CI/CD Gate ──────────────────────────────────────────────────────────── */
if (regressions > 0) {
  console.error(`\n❌ CI/CD Gate Failed: Found ${regressions} active regressions.`);
  process.exit(1);
} else {
  console.log('\n✅ CI/CD Gate Passed: No extracted patterns violated.');
  process.exit(0);
}
