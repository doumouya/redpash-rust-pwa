#!/usr/bin/env node
/* Purpose: per-page CSS class diff (same role, different name).
 * Doc: docs/internal/code/frontend/tools/css-tab-compare-audit.md (TODO)
 * Lean port of the prerelease tab-compare audit — see the "Lean port" note
 * at the bottom of this header.
 * ──────────────────────────────────────────────────────────────────────────
   RedPash CSS page-compare audit (lean)
   ---------------------------------------------------------------------------
   Cross-compares the CSS classes used by two APP PAGES. In the lean tree a
   "page" is /apps/<app>/<page>/<page>.{html,js,css}; pages render through the
   generic framework components they import (mountObjectList, assemblePage, …).
   Two pages that both instance the generic object-list (admin:cases vs
   admin:registry) are the lean analogue of the predecessor's "two list-page
   tabs". Surfaces:

     1. Same-role, different-name leaks (cross-prefix candidates)
        Two classes whose normalised suffix matches but whose prefix family
        differs — the [[naming-consistency]] + [[compose-atoms-dont-parallel]]
        hazard, one role two names. In lean this is mostly a `pg-<app>-<page>-`
        family check (page A's `.pg-admin-cases-tile` vs page B's
        `.pg-admin-org-tile`), since `.rp-*` framework atoms are single-owner by
        construction (ui-fork-audit R4).

     2. Page-local inventory (only-A / only-B)
        Classes only one page emits — useful to spot an affordance the other
        page over the same generic component is missing.

   How the inventory is built (lean):
     - the page's own `.html` (class="…") + `.css` (.pg-…/.rp-… selectors)
     - the page `.js` PLUS the framework components it imports, followed
       TRANSITIVELY via Acorn (import declarations resolved against the
       importing file's dir, scoped to frontend/framework + the page dir).
       For every JS file we harvest class literals from the lean idioms:
         el("tag", { class: "rp-…" })   · the dom.js builder (most common)
         class="rp-…"                    · template-literal markup (redtable)
         classList.add/toggle/remove("…")· imperative class writes
         className = "…"
     - the matching component `.css` selectors (the atoms' owners)

   WHAT THE LEAN ARCHITECTURE MAKES OBSOLETE (vs the prerelease tool):
     - "Mixed-prefix violations" (`rt-` + page token): `rt-*` is retired; the
       namespace is `rp-*` (framework) / `pg-*` (page root) / `is-*` (state).
     - "Misnamed shared atoms" (an `rp-<page>-` class emitted for every list
       consumer): in lean `.rp-*` selectors live ONLY in framework/ (no page
       prefix), each owned by exactly one sheet. tools/ui-fork-audit/audit.js
       enforces both mechanically (R2/R4/R8). This tool no longer re-detects
       them; it focuses on the cross-PAGE same-role comparison that remains a
       judgement call.

   Acorn AST is the static-analysis carve-out from the no-frameworks rule
   (see [[feedback-acorn-allowed-for-static-analysis]]).

   Usage:
     node tools/css-tab-compare-audit/audit.js
     node tools/css-tab-compare-audit/audit.js admin:cases admin:registry
     node tools/css-tab-compare-audit/audit.js studio:workspace admin:org

   Output:
     ./audit.json   — full payload (per-pair shared / page-only / cross-prefix)
     ./audit.html   — browser report
     stdout         — human summary (Markdown)
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..', '..');
const FE = path.join(ROOT, 'frontend');
const APPS_DIR = path.join(FE, 'apps');
const FRAMEWORK_DIR = path.join(FE, 'framework');

const OUT_JSON = path.join(__dirname, 'audit.json');
const OUT_HTML = path.join(__dirname, 'audit.html');

// Default pair — two thin instances of the generic object-list (the lean
// analogue of the predecessor's Events-vs-Projects list views). Runs when the
// audit suite invokes with no args.
const DEFAULT_PAIRS = [['admin:cases', 'admin:registry']];

// Known prefix families, longest match first. Lean namespaces only:
//   rp-<component>-  framework atom (single-owner per ui-fork-audit R4)
//   pg-<app>-<page>- page-root scope (apps css is rooted here, R1)
//   is-              state modifier (stacks on any host)
// Tokens before the suffix are stripped to compute a class's "base name".
const KNOWN_PREFIXES = [
  'pg-',
  'rp-',
  'is-',
];

// `class="..."` inside template literals / .html.
const CLASS_ATTR_RX = /class=["']([^"']+)["']/g;
// el("tag", { class: "..." } | { class: `...` }) — the dom.js builder.
const EL_CLASS_RX = /\bclass\s*:\s*["'`]([^"'`]+)["'`]/g;
// classList.add/toggle/remove("a", "b") — capture the whole arg list.
const CLASSLIST_RX = /classList\.(?:add|toggle|remove)\(([^)]*)\)/g;
// className = "..." | `...`
const CLASSNAME_RX = /className\s*=\s*["'`]([^"'`]+)["'`]/g;

// ─── argv ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const pairs = args.length >= 2 ? [[args[0], args[1]]] : DEFAULT_PAIRS;

// ─── helpers ───────────────────────────────────────────────────────────────
function read(p) { return fs.readFileSync(p, 'utf8'); }
function writeJSON(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function writeHTML(p, s) { fs.writeFileSync(p, s); }
function uniq(xs) { return Array.from(new Set(xs)).sort(); }

// Keep only design-system tokens; drop Bootstrap-icon utility classes.
function isAuditableClass(c) {
  if (!c) return false;
  if (c === 'bi' || c.startsWith('bi-')) return false;
  return true;
}

function pushTokens(out, raw) {
  raw.split(/\s+/).filter(Boolean).forEach((c) => {
    if (isAuditableClass(c)) out.push(c);
  });
}

// Harvest every class literal a JS source emits (all lean idioms).
function extractClassesFromJs(src) {
  const out = [];
  let m;
  EL_CLASS_RX.lastIndex = 0;
  while ((m = EL_CLASS_RX.exec(src))) pushTokens(out, m[1]);
  CLASSNAME_RX.lastIndex = 0;
  while ((m = CLASSNAME_RX.exec(src))) pushTokens(out, m[1]);
  CLASS_ATTR_RX.lastIndex = 0;
  while ((m = CLASS_ATTR_RX.exec(src))) pushTokens(out, m[1]);
  CLASSLIST_RX.lastIndex = 0;
  while ((m = CLASSLIST_RX.exec(src))) {
    // arg list is one or more string literals; grab each quoted token.
    const inner = m[1];
    let s;
    const sRx = /["'`]([^"'`]+)["'`]/g;
    while ((s = sRx.exec(inner))) pushTokens(out, s[1]);
  }
  return out;
}

// Harvest class= attributes from .html.
function extractClassesFromHtml(src) {
  const out = [];
  let m;
  CLASS_ATTR_RX.lastIndex = 0;
  while ((m = CLASS_ATTR_RX.exec(src))) pushTokens(out, m[1]);
  return out;
}

// Harvest class names from CSS selectors (.foo .bar:hover → foo, bar).
function extractClassesFromCss(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = [];
  let m;
  const rx = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
  while ((m = rx.exec(noComments))) out.push(m[1]);
  return out;
}

// Strip the longest matching known prefix; return { base, prefix }.
function stripPrefix(cls) {
  for (const p of KNOWN_PREFIXES) {
    if (cls.startsWith(p)) return { base: cls.slice(p.length), prefix: p };
  }
  return { base: cls, prefix: '' };
}

// Collapse BEM `--` to `-` so `row--clickable` matches `row-clickable`.
function normaliseBase(base) {
  return base.replace(/--+/g, '-').toLowerCase();
}

// ─── import-graph resolution (Acorn) ───────────────────────────────────────
// Resolve a page's transitive JS files: the page entry + every framework /
// page-local module reachable through `import … from "…"`. We deliberately
// follow only relative imports landing inside frontend/ (skip bare specifiers).
function resolveImportGraph(entryJs) {
  const seen = new Set();
  const files = [];
  const queue = [entryJs];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    files.push(f);
    const src = read(f);
    let ast;
    try {
      ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module' });
    } catch {
      continue; // tolerate a parse miss; still inventory what we read
    }
    for (const node of ast.body) {
      let spec = null;
      if (node.type === 'ImportDeclaration') spec = node.source.value;
      else if (
        (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
        node.source
      ) spec = node.source.value;
      if (!spec || !spec.startsWith('.')) continue; // only relative, in-tree
      let abs = path.resolve(path.dirname(f), spec);
      if (!abs.endsWith('.js')) abs += '.js';
      // Stay within frontend/ (framework + the page's own dir).
      if (!abs.startsWith(FE)) continue;
      queue.push(abs);
    }
  }
  return files;
}

// ─── page inventory ─────────────────────────────────────────────────────────
function pageDir(app, page) { return path.join(APPS_DIR, app, page); }

function inventoryPage(app, page) {
  const dir = pageDir(app, page);
  const entryJs = path.join(dir, page + '.js');
  if (!fs.existsSync(entryJs)) {
    throw new Error(`page JS not found: ${path.relative(ROOT, entryJs)}`);
  }

  // 1. JS import graph (page entry + transitive framework components).
  const jsFiles = resolveImportGraph(entryJs);
  const jsClasses = [];
  const frameworkComponents = new Set();
  for (const f of jsFiles) {
    extractClassesFromJs(read(f)).forEach((c) => jsClasses.push(c));
    if (f.startsWith(FRAMEWORK_DIR + path.sep)) {
      // record the component dir name for the report
      const rel = path.relative(FRAMEWORK_DIR, f).split(path.sep);
      if (rel[0]) frameworkComponents.add(rel[0]);
    }
  }

  // 2. CSS that styles this page: its own .css + each imported framework
  //    component's co-located .css (sibling of the imported .js).
  const cssClasses = [];
  const cssFiles = new Set();
  for (const f of jsFiles) {
    const css = f.replace(/\.js$/, '.css');
    if (fs.existsSync(css)) cssFiles.add(css);
  }
  // page's own sheet (may not be import-reachable from JS).
  const pageCss = path.join(dir, page + '.css');
  if (fs.existsSync(pageCss)) cssFiles.add(pageCss);
  for (const f of cssFiles) extractClassesFromCss(read(f)).forEach((c) => cssClasses.push(c));

  // 3. The page's own .html.
  const htmlClasses = [];
  const pageHtml = path.join(dir, page + '.html');
  if (fs.existsSync(pageHtml)) {
    extractClassesFromHtml(read(pageHtml)).forEach((c) => htmlClasses.push(c));
  }

  const union = uniq([...jsClasses, ...cssClasses, ...htmlClasses]);
  return {
    app,
    page,
    key: `${app}:${page}`,
    union: { classes: union },
    frameworkComponents: Array.from(frameworkComponents).sort(),
    sources: {
      js: jsFiles.map((f) => path.relative(ROOT, f)),
      css: Array.from(cssFiles).map((f) => path.relative(ROOT, f)).sort(),
    },
  };
}

// ─── comparison ──────────────────────────────────────────────────────────────
function comparePair(invA, invB) {
  const A = new Set(invA.union.classes);
  const B = new Set(invB.union.classes);

  const shared = uniq([...A].filter((c) => B.has(c)));
  const onlyA = uniq([...A].filter((c) => !B.has(c)));
  const onlyB = uniq([...B].filter((c) => !A.has(c)));

  // Cross-prefix candidates: same normalised base, different prefix family.
  const all = uniq([...A, ...B]);
  const buckets = new Map(); // normBase -> [{ class, prefix, side }]
  all.forEach((c) => {
    const { base, prefix } = stripPrefix(c);
    if (!base) return;
    const key = normaliseBase(base);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    if (A.has(c)) buckets.get(key).push({ class: c, prefix: prefix || '(none)', side: 'a' });
    if (B.has(c)) buckets.get(key).push({ class: c, prefix: prefix || '(none)', side: 'b' });
  });

  // Generic single words appear under many legit prefixes (`.rp-card-body`
  // vs `.rp-modal-body` are different containers, not one role). Two-word+
  // bases describe a specific component variant — the real signal. Pure
  // modifiers (`is-active`) stack on any host.
  const GENERIC_SINGLE_WORDS = new Set([
    'body', 'head', 'wrap', 'toolbar', 'title', 'name', 'icon',
    'btn', 'item', 'pill', 'caret', 'mark', 'count', 'sep',
    'main', 'nav', 'surface', 'tab', 'chip', 'group', 'card',
    'value', 'label', 'state', 'empty', 'row', 'cell', 'active',
    'open', 'selected', 'disabled', 'hidden', 'num', 'null',
  ]);
  const crossPrefix = [];
  for (const [base, variants] of buckets) {
    if (GENERIC_SINGLE_WORDS.has(base)) continue;
    if (!base.includes('-') && base.length < 8) continue;
    const prefixes = new Set(variants.map((v) => v.prefix));
    if (prefixes.size < 2) continue;
    // Also require ≥2 distinct class NAMES (a single class on both sides is
    // shared, not a same-role-different-name leak).
    const names = new Set(variants.map((v) => v.class));
    if (names.size < 2) continue;
    const seen = new Set();
    const distinct = [];
    variants.forEach((v) => {
      const k = v.class + '|' + v.side;
      if (seen.has(k)) return;
      seen.add(k);
      distinct.push(v);
    });
    crossPrefix.push({ base, variants: distinct });
  }
  crossPrefix.sort((x, y) => x.base.localeCompare(y.base));

  return { shared, onlyA, onlyB, crossPrefix };
}

// ─── output ──────────────────────────────────────────────────────────────────
function writeMarkdown(invA, invB, cmp) {
  const lines = [];
  const a = invA.key;
  const b = invB.key;
  lines.push(`# ${a}  vs  ${b}`);
  lines.push('');
  lines.push(`shared: ${cmp.shared.length}   only-${a}: ${cmp.onlyA.length}   only-${b}: ${cmp.onlyB.length}   cross-prefix candidates: ${cmp.crossPrefix.length}`);
  lines.push('');

  if (cmp.crossPrefix.length) {
    lines.push('## Cross-prefix candidates (same role, different name)');
    lines.push('');
    lines.push('| base | variants |');
    lines.push('|------|----------|');
    cmp.crossPrefix.forEach(({ base, variants }) => {
      const v = variants.map((x) => `\`.${x.class}\` (${x.side})`).join('  ·  ');
      lines.push(`| \`${base}\` | ${v} |`);
    });
    lines.push('');
  }

  if (cmp.onlyA.length) {
    lines.push(`## Only in ${a}`);
    lines.push('');
    cmp.onlyA.forEach((c) => lines.push(`- \`.${c}\``));
    lines.push('');
  }
  if (cmp.onlyB.length) {
    lines.push(`## Only in ${b}`);
    lines.push('');
    cmp.onlyB.forEach((c) => lines.push(`- \`.${c}\``));
    lines.push('');
  }
  return lines.join('\n');
}

function writeHtmlReport(payload) {
  const css = `body{font:14px ui-sans-serif,system-ui,sans-serif;margin:1.5rem;color:#222;background:#fafafa}h1{margin-bottom:0.25rem}h2{margin-top:1.5rem}.muted{color:#888}.tbl{border-collapse:collapse;width:100%;margin-top:0.5rem}.tbl th,.tbl td{border:1px solid #ddd;padding:0.375rem 0.625rem;text-align:left;vertical-align:top}.tbl th{background:#eef}.cls{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:#f0f0f0;padding:0.0625rem 0.375rem;border-radius:0.25rem}.ok{color:#0a7}.warn{color:#c70}details{margin:0.5rem 0}summary{cursor:pointer;font-weight:600}`;
  const escHtml = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = (c) => `<code class="cls">.${escHtml(c)}</code>`;

  const sections = payload.pairs.map((pair) => {
    const t = `${pair.a}  vs  ${pair.b}`;
    const cp = pair.crossPrefix.map(({ base, variants }) => {
      const vh = variants.map((v) => `${cls(v.class)} <span class="muted">(${escHtml(v.side)})</span>`).join('  ·  ');
      return `<tr><td><code class="cls">${escHtml(base)}</code></td><td>${vh}</td></tr>`;
    }).join('');
    const onlyA = pair.onlyA.map((c) => `<li>${cls(c)}</li>`).join('');
    const onlyB = pair.onlyB.map((c) => `<li>${cls(c)}</li>`).join('');
    return `
      <h2>${escHtml(t)}</h2>
      <p class="muted">shared ${pair.shared.length}  ·  only-${escHtml(pair.a)} ${pair.onlyA.length}  ·  only-${escHtml(pair.b)} ${pair.onlyB.length}  ·  cross-prefix ${pair.crossPrefix.length}</p>

      <h3 class="${pair.crossPrefix.length ? 'warn' : 'ok'}">Cross-prefix candidates (same role, different name)</h3>
      ${pair.crossPrefix.length
        ? `<table class="tbl"><thead><tr><th>base</th><th>variants</th></tr></thead><tbody>${cp}</tbody></table>`
        : '<p class="ok">None.</p>'}

      <details><summary>Only in ${escHtml(pair.a)}  (${pair.onlyA.length})</summary><ul>${onlyA}</ul></details>
      <details><summary>Only in ${escHtml(pair.b)}  (${pair.onlyB.length})</summary><ul>${onlyB}</ul></details>
    `;
  }).join('');

  return `<!doctype html><meta charset="utf-8"><title>css-tab-compare audit</title><style>${css}</style>
<h1>RedPash · CSS page-compare audit</h1>
<p class="muted">Generated ${escHtml(payload.ran_at)}. Two-page cross-comparison surfacing same-role/different-name naming leaks. Lean namespaces: <code>rp-*</code> (framework, single-owner) / <code>pg-*</code> (page root) / <code>is-*</code> (state). Mixed-prefix &amp; misnamed-atom classes are enforced mechanically by <code>tools/ui-fork-audit</code> (R2/R4/R8). See <code>audit.json</code> for the full payload.</p>
${sections}`;
}

// ─── run ──────────────────────────────────────────────────────────────────────
function parsePair(s) {
  const [app, page] = s.split(':');
  if (!app || !page) throw new Error(`malformed pair spec "${s}" — expected app:page`);
  return { app, page };
}

function runOnce(specA, specB) {
  const a = parsePair(specA);
  const b = parsePair(specB);
  const invA = inventoryPage(a.app, a.page);
  const invB = inventoryPage(b.app, b.page);
  const cmp = comparePair(invA, invB);
  return {
    a: invA.key,
    b: invB.key,
    inventory: { a: invA, b: invB },
    shared: cmp.shared,
    onlyA: cmp.onlyA,
    onlyB: cmp.onlyB,
    crossPrefix: cmp.crossPrefix,
  };
}

function main() {
  const results = pairs.map(([a, b]) => runOnce(a, b));
  const payload = {
    tool: 'css-tab-compare',
    ran_at: new Date().toISOString(),
    pairs: results,
  };

  writeJSON(OUT_JSON, payload);
  writeHTML(OUT_HTML, writeHtmlReport(payload));

  results.forEach((r) => {
    process.stdout.write('\n');
    process.stdout.write(writeMarkdown(r.inventory.a, r.inventory.b, r));
    process.stdout.write('\n');
  });

  process.stdout.write(`\n  json -> ${path.relative(ROOT, OUT_JSON)}\n  html -> ${path.relative(ROOT, OUT_HTML)}\n`);
}

main();
