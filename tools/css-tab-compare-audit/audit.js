#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash CSS tab-compare audit
   ---------------------------------------------------------------------------
   Cross-compares the CSS classes / IDs used by two list-page tabs (each
   tab is a `LIST_VIEWS[<key>]` entry in a page JS file). Surfaces:

     1. Same-role, different-name leaks
        Two classes whose normalised suffix matches but whose prefix
        family differs (e.g. `.rt-mon-row-clickable` vs
        `.rp-home-row--clickable`). The [[naming-consistency]] +
        [[compose-atoms-dont-parallel]] hazard — one role, two names.

     2. Mixed-prefix violations
        Classes that combine the foundation `rt-` prefix with a
        page-scope token (`.rt-mon-*`, `.rt-home-*`, `.rt-kpi-*`).
        Pick one — foundation or page — never both.

     3. Misnamed shared atoms
        Classes whose `rp-{page}-` prefix lies because the atom is
        emitted from `frontend/scripts/list-page.js` (so every list
        view consumer renders it). `.rp-home-chart-card` rendered on
        Monitoring is an example.

     4. Tab-only inventory
        Classes only one of the two tabs emits — useful to spot a
        page-local affordance that the other tab is missing (e.g.
        Projects has `.rp-home-meta` for muted "—" cells; Events has
        no equivalent).

   Driven by Acorn AST over the page JS's `LIST_VIEWS` literal +
   regex over template strings / helpers / shared atoms / partial.
   Acorn is the static-analysis carve-out from the no-frameworks
   rule (see [[feedback-acorn-allowed-for-static-analysis]]).

   Usage:
     node tools/css-tab-compare-audit/audit.js
     node tools/css-tab-compare-audit/audit.js monitoring:events home:projects
     node tools/css-tab-compare-audit/audit.js home:users home:files

   Output:
     ./audit.json   — full payload (per-pair shared / tab-only / leaks)
     ./audit.html   — sortable browser report
     stdout         — human summary (Markdown table)
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const REPO = path.resolve(__dirname, '../..');
const PAGES_DIR = path.join(REPO, 'frontend/scripts/pages');
const PARTIALS_DIR = path.join(REPO, 'frontend/partials');
const LIST_PAGE_JS = path.join(REPO, 'frontend/scripts/list-page.js');

const OUT_JSON = path.join(__dirname, 'audit.json');
const OUT_HTML = path.join(__dirname, 'audit.html');

// Default pair — the motivating Em ask (Events vs Projects). When the
// audit suite runs with no args this is what executes.
const DEFAULT_PAIRS = [['monitoring:events', 'home:projects']];

// Known prefix families in order of specificity (longest match wins).
// Tokens before the shared-atom suffix are stripped to compute the
// "base name" of a class for cross-prefix comparison.
const KNOWN_PREFIXES = [
  'rt-mon-',     // mixed-prefix leak: rt- + page token
  'rt-home-',    // mixed-prefix leak: rt- + page token
  'rt-list-',    // mixed-prefix (potential)
  'rt-kpi-',     // mixed-prefix (potential)
  'rt-card-',    // foundation-namespaced card subatom
  'rp-shell-',
  'rp-list-',
  'rp-home-',
  'rp-mon-',
  'rp-kpi-',
  'rp-chip-',
  'rp-cases-',
  'rt-nav-',
  'rt-group-',
  'rt-tab-',
  'rt-dd-',
  'rt-mode',     // exact (no trailing hyphen)
  'rt-pg-',
  'rt-pg',
  'rt-toolbar-',
  'rt-pill',
  'rt-search',
  'rt-table-',
  'rt-table',
  'rt-pager',
  'rt-card',
  'rt-empty',
  'rt-btn',
  'rt-icon-btn',
  'rt-sel-chip',
  'rt-main',
  'rt-surface',
  'rt-',
  'rp-kpi',
  'rp-chip',
  'rp-shell',
  'rp-',
  'is-',
];

// Mixed-prefix violation matchers — `.rt-{pagetoken}-…`. `rt-` is
// the foundation namespace; mixing in a page-scope token (`mon`, `home`)
// is the leak Em surfaced 2026-05-25.
const MIXED_PREFIX_RX = /^rt-(mon|home|list|kpi|chip|cases|shell)-/;

// `class="..."` pattern — captures static class attributes inside
// template literals + HTML.
const CLASS_RX = /class=["']([^"']+)["']/g;
// Chip-helper call detector inside `row(...)` bodies — looks for
// `<word>Chip(` calls so the audit can follow them into their
// emitted-classes (e.g. stageChip → emits `.rp-mon-method`).
const CHIP_HELPER_CALL_RX = /\b([a-zA-Z][a-zA-Z0-9]*Chip)\s*\(/g;

// ─── argv ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const pairs = args.length >= 2
  ? [[args[0], args[1]]]
  : DEFAULT_PAIRS;

// ─── helpers ───────────────────────────────────────────────────────────────
function read(p) { return fs.readFileSync(p, 'utf8'); }
function writeJSON(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function writeHTML(p, s) { fs.writeFileSync(p, s); }

function uniq(xs) { return Array.from(new Set(xs)).sort(); }

function extractClassesFromString(src) {
  const out = [];
  let m;
  CLASS_RX.lastIndex = 0;
  while ((m = CLASS_RX.exec(src))) {
    // A single class attribute can carry multiple space-separated
    // tokens — split and keep each. Skip Bootstrap-icon utility
    // classes (`bi`, `bi-…`) — they're not part of the design system.
    m[1].split(/\s+/).filter(Boolean).forEach((c) => {
      if (c.startsWith('bi-') || c === 'bi') return;
      out.push(c);
    });
  }
  return out;
}

function extractIdsFromString(src) {
  const out = [];
  const rx = /id=["']([^"']+)["']/g;
  let m;
  while ((m = rx.exec(src))) out.push(m[1]);
  return out;
}

// Strip the longest matching known prefix from a class name; return
// { base, prefix }. Unknown prefix → empty prefix, base = original.
function stripPrefix(cls) {
  for (const p of KNOWN_PREFIXES) {
    if (cls.startsWith(p)) return { base: cls.slice(p.length), prefix: p };
  }
  return { base: cls, prefix: '' };
}

function normaliseBase(base) {
  // Collapse `--` to `-` so BEM-modifier ("row--clickable") matches
  // the plain-suffix form ("row-clickable").
  return base.replace(/--+/g, '-').toLowerCase();
}

// ─── Acorn — locate a tab's LIST_VIEWS entry ──────────────────────────────
function loadPageAst(pageJsPath) {
  const src = read(pageJsPath);
  const ast = acorn.parse(src, {
    ecmaVersion: 2022, sourceType: 'module', locations: true, ranges: true,
  });
  return { src, ast };
}

// Walk the AST to find a top-level `const LIST_VIEWS = { ... }` (it
// lives inside the page's IIFE; recurse through Program → blocks →
// VariableDeclarations).
function findListViews(node, src) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) {
      if (d.id && d.id.name === 'LIST_VIEWS' && d.init && d.init.type === 'ObjectExpression') {
        return d.init;
      }
    }
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) {
        const r = findListViews(c, src);
        if (r) return r;
      }
    } else if (v && typeof v === 'object' && v.type) {
      const r = findListViews(v, src);
      if (r) return r;
    }
  }
  return null;
}

// Locate `row` property inside a tab spec's ObjectExpression. The
// value is usually an arrow / function expression — return its source.
// Some tabs reference an external helper (`row: requestRowHTML`); in
// that case return both the identifier name and a marker so the
// caller can follow it into the helper's body.
function findRowSource(tabSpec, src) {
  if (!tabSpec || tabSpec.type !== 'ObjectExpression') return { source: '', helperRef: null };
  for (const p of tabSpec.properties) {
    const name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
    if (name !== 'row') continue;
    if (p.value && p.value.type === 'Identifier') {
      return { source: '', helperRef: p.value.name };
    }
    if (p.value && p.value.range) {
      return { source: src.slice(p.value.range[0], p.value.range[1]), helperRef: null };
    }
  }
  return { source: '', helperRef: null };
}

// Same shape but for any property (charts/columns/chipRows source —
// not needed today but the helper is cheap).
function findPropertySource(tabSpec, key, src) {
  if (!tabSpec || tabSpec.type !== 'ObjectExpression') return '';
  for (const p of tabSpec.properties) {
    const name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
    if (name === key && p.value && p.value.range) {
      return src.slice(p.value.range[0], p.value.range[1]);
    }
  }
  return '';
}

// Get the tabSpec for one tab key inside LIST_VIEWS.
function findTabSpec(listViewsAst, tabKey) {
  if (!listViewsAst) return null;
  for (const p of listViewsAst.properties) {
    const name = p.key.type === 'Identifier' ? p.key.name : p.key.value;
    if (name === tabKey && p.value && p.value.type === 'ObjectExpression') {
      return p.value;
    }
  }
  return null;
}

// Find a top-level helper function by name (e.g. stageChip) inside
// the page JS; returns its source range as a string, or ''.
function findHelperSource(ast, src, fnName) {
  function visit(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === fnName) {
      return src.slice(node.range[0], node.range[1]);
    }
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id && d.id.name === fnName && d.init && d.init.range) {
          return src.slice(d.init.range[0], d.init.range[1]);
        }
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) {
          const r = visit(c);
          if (r) return r;
        }
      } else if (v && typeof v === 'object' && v.type) {
        const r = visit(v);
        if (r) return r;
      }
    }
    return '';
  }
  return visit(ast);
}

// ─── shared atoms — every list-page consumer emits these ──────────────────
let _listPageAtoms = null;
function getListPageAtoms() {
  if (_listPageAtoms) return _listPageAtoms;
  const src = read(LIST_PAGE_JS);
  _listPageAtoms = {
    classes: uniq(extractClassesFromString(src)),
    ids: uniq(extractIdsFromString(src)),
  };
  return _listPageAtoms;
}

// Static atoms in the page partial (rail + main shell).
function getPartialAtoms(pageName) {
  const p = path.join(PARTIALS_DIR, pageName + '.html');
  if (!fs.existsSync(p)) return { classes: [], ids: [] };
  const src = read(p);
  return {
    classes: uniq(extractClassesFromString(src)),
    ids: uniq(extractIdsFromString(src)),
  };
}

// ─── tab inventory ─────────────────────────────────────────────────────────
function inventoryTab(pageName, tabKey) {
  const pageJs = path.join(PAGES_DIR, pageName + '.js');
  if (!fs.existsSync(pageJs)) {
    throw new Error(`page JS not found: ${pageJs}`);
  }

  const { src, ast } = loadPageAst(pageJs);
  const listViews = findListViews(ast, src);
  const tabSpec = findTabSpec(listViews, tabKey);
  if (!tabSpec) {
    throw new Error(`tab "${tabKey}" not found in LIST_VIEWS of ${pageName}.js`);
  }

  // 1. Row template's class set. If `row:` references an external
  //    helper (e.g. `row: requestRowHTML`), resolve that helper's
  //    body and treat it as the row template.
  let { source: rowSrc, helperRef } = findRowSource(tabSpec, src);
  if (helperRef) {
    rowSrc = findHelperSource(ast, src, helperRef) || '';
  }
  const rowClasses = extractClassesFromString(rowSrc);

  // 2. Chip / pill helpers called from the row template — follow
  //    each into its body so chips' inner classes (e.g. stageChip's
  //    `.rp-mon-method`) join the inventory. Same routine handles
  //    nested calls (helper-of-helper) by re-scanning their bodies.
  const HELPER_NAME_RX = /\b([a-zA-Z][a-zA-Z0-9]*(?:Chip|HTML|Row|Cell|Body|Header|Pill|Badge|Avatar))\s*\(/g;
  function collectHelperClasses(seedSrc) {
    const seen = new Set();
    const queue = [];
    const collect = (s) => {
      HELPER_NAME_RX.lastIndex = 0;
      let mm;
      while ((mm = HELPER_NAME_RX.exec(s))) queue.push(mm[1]);
    };
    collect(seedSrc);
    const classes = [];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      const body = findHelperSource(ast, src, name);
      if (!body) continue;
      extractClassesFromString(body).forEach((c) => classes.push(c));
      collect(body);   // follow nested helper calls
    }
    return { classes, helpers: Array.from(seen) };
  }
  const { classes: helperClasses, helpers: helperCalls } = collectHelperClasses(rowSrc);

  // 3. Charts ids — composite-strip / charts strip emits one canvas
  //    per spec entry; the chart-card atom itself comes from list-page.
  const chartsSrc = findPropertySource(tabSpec, 'charts', src);
  const chartIds = [];
  if (chartsSrc) {
    const rx = /id:\s*['"]([^'"]+)['"]/g;
    let mm;
    while ((mm = rx.exec(chartsSrc))) chartIds.push(mm[1]);
  }

  // 4. Partial atoms (shell + rail) — same for every tab on the page.
  const partial = getPartialAtoms(pageName);

  // 5. Shared list-page atoms (constant for every consumer).
  const shared = getListPageAtoms();

  // Tab-specific = row template + helpers + chart ids.
  const tabSpecific = {
    classes: uniq([...rowClasses, ...helperClasses]),
    ids: uniq(chartIds),
  };

  // Page-static = partial.
  // Always-shared = list-page.js emissions.
  return {
    page: pageName,
    tab: tabKey,
    tabSpecific,
    pageStatic: partial,
    sharedAtoms: shared,
    // Union for cross-tab compare (every class this tab ends up rendering)
    union: {
      classes: uniq([
        ...tabSpecific.classes,
        ...partial.classes,
        ...shared.classes,
      ]),
      ids: uniq([
        ...tabSpecific.ids,
        ...partial.ids,
        ...shared.ids,
      ]),
    },
    helpersInRow: helperCalls,
  };
}

// ─── comparison ────────────────────────────────────────────────────────────
function comparePair(invA, invB) {
  const A = new Set(invA.union.classes);
  const B = new Set(invB.union.classes);

  const shared = uniq([...A].filter((c) => B.has(c)));
  const onlyA = uniq([...A].filter((c) => !B.has(c)));
  const onlyB = uniq([...B].filter((c) => !A.has(c)));

  // Cross-prefix candidates: same normalised base, different prefix
  // family, present in either inventory.
  const all = uniq([...A, ...B]);
  const buckets = new Map();          // normBase -> [{ class, prefix, side }]
  all.forEach((c) => {
    const { base, prefix } = stripPrefix(c);
    if (!base) return;                  // no remainder = a bare prefix; skip
    const key = normaliseBase(base);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    const sides = [];
    if (A.has(c)) sides.push('a');
    if (B.has(c)) sides.push('b');
    sides.forEach((s) => {
      buckets.get(key).push({ class: c, prefix: prefix || '(none)', side: s });
    });
  });

  // A "candidate" bucket has ≥2 different prefixes among its entries.
  // Filter out single-word bases — "body", "head", "wrap", "toolbar"
  // are generic container names that appear under multiple legit
  // prefixes (`.rt-nav-body` and `.rp-shell-body` are different
  // containers, not the same role). Two-word+ bases like
  // `row-clickable` / `chart-card` are the real signal: compound
  // names that describe a specific component variant. Also exclude
  // pure modifiers like `is-active` / `is-num` which stack on any
  // host.
  const GENERIC_SINGLE_WORDS = new Set([
    'body', 'head', 'wrap', 'toolbar', 'title', 'name', 'icon',
    'btn', 'item', 'pill', 'caret', 'mark', 'count', 'sep',
    'main', 'nav', 'surface', 'tab', 'chip', 'group', 'card',
    'value', 'label', 'state', 'empty', 'row', 'cell',
  ]);
  const crossPrefix = [];
  for (const [base, variants] of buckets) {
    if (GENERIC_SINGLE_WORDS.has(base)) continue;
    if (!base.includes('-') && base.length < 8) continue;
    const prefixes = new Set(variants.map((v) => v.prefix));
    if (prefixes.size < 2) continue;
    // Dedup variants — same class on both sides shouldn't show as 4.
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

  // Mixed-prefix violations.
  const mixed = uniq(all.filter((c) => MIXED_PREFIX_RX.test(c)));

  // Misnamed shared atoms: shared classes whose prefix is `rp-{page}-`
  // (i.e. claims to belong to one page) yet they're emitted by
  // list-page.js → both tabs see them. The list-page.js classes are
  // the authoritative shared set; intersect with the candidate misnomer
  // prefixes (rp-home-, rp-mon-).
  const listPageClasses = new Set(getListPageAtoms().classes);
  const misnamedShared = uniq([...listPageClasses].filter(
    (c) => /^rp-(home|mon|cases|workspace|designer|profile|settings|docs|login)-/.test(c)
  ));

  return { shared, onlyA, onlyB, crossPrefix, mixed, misnamedShared };
}

// ─── output ───────────────────────────────────────────────────────────────
function writeMarkdown(invA, invB, cmp) {
  const lines = [];
  const a = `${invA.page}:${invA.tab}`;
  const b = `${invB.page}:${invB.tab}`;
  lines.push(`# ${a}  vs  ${b}`);
  lines.push('');
  lines.push(`shared atoms: ${cmp.shared.length}   only-${a}: ${cmp.onlyA.length}   only-${b}: ${cmp.onlyB.length}`);
  lines.push(`cross-prefix candidates: ${cmp.crossPrefix.length}   mixed-prefix violations: ${cmp.mixed.length}   misnamed shared atoms: ${cmp.misnamedShared.length}`);
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

  if (cmp.mixed.length) {
    lines.push('## Mixed-prefix violations (rt- + page token)');
    lines.push('');
    cmp.mixed.forEach((c) => lines.push(`- \`.${c}\``));
    lines.push('');
  }

  if (cmp.misnamedShared.length) {
    lines.push('## Misnamed shared atoms (list-page.js emits these for every consumer)');
    lines.push('');
    cmp.misnamedShared.forEach((c) => lines.push(`- \`.${c}\``));
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
  const css = `body{font:14px ui-sans-serif,system-ui,sans-serif;margin:1.5rem;color:#222;background:#fafafa}h1{margin-bottom:0.25rem}h2{margin-top:1.5rem}.muted{color:#888}.tbl{border-collapse:collapse;width:100%;margin-top:0.5rem}.tbl th,.tbl td{border:1px solid #ddd;padding:0.375rem 0.625rem;text-align:left;vertical-align:top}.tbl th{background:#eef}.cls{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:#f0f0f0;padding:0.0625rem 0.375rem;border-radius:0.25rem}.bad{color:#b30}.ok{color:#0a7}.warn{color:#c70}details{margin:0.5rem 0}summary{cursor:pointer;font-weight:600}`;
  const escHtml = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = (c) => `<code class="cls">.${escHtml(c)}</code>`;

  const sections = payload.pairs.map((pair) => {
    const t = `${pair.a}  vs  ${pair.b}`;
    const cp = pair.crossPrefix.map(({ base, variants }) => {
      const vh = variants.map((v) => `${cls(v.class)} <span class="muted">(${escHtml(v.side)})</span>`).join('  ·  ');
      return `<tr><td><code class="cls">${escHtml(base)}</code></td><td>${vh}</td></tr>`;
    }).join('');
    const mixed = pair.mixed.map((c) => `<li>${cls(c)}</li>`).join('');
    const misnamed = pair.misnamedShared.map((c) => `<li>${cls(c)}</li>`).join('');
    const onlyA = pair.onlyA.map((c) => `<li>${cls(c)}</li>`).join('');
    const onlyB = pair.onlyB.map((c) => `<li>${cls(c)}</li>`).join('');
    return `
      <h2>${escHtml(t)}</h2>
      <p class="muted">shared ${pair.shared.length}  ·  only-${escHtml(pair.a)} ${pair.onlyA.length}  ·  only-${escHtml(pair.b)} ${pair.onlyB.length}  ·  cross-prefix ${pair.crossPrefix.length}  ·  mixed-prefix ${pair.mixed.length}  ·  misnamed shared ${pair.misnamedShared.length}</p>

      <h3 class="${pair.crossPrefix.length ? 'warn' : 'ok'}">Cross-prefix candidates (same role, different name)</h3>
      ${pair.crossPrefix.length
        ? `<table class="tbl"><thead><tr><th>base</th><th>variants</th></tr></thead><tbody>${cp}</tbody></table>`
        : '<p class="ok">None.</p>'}

      <h3 class="${pair.mixed.length ? 'bad' : 'ok'}">Mixed-prefix violations (rt- + page token)</h3>
      ${pair.mixed.length ? `<ul>${mixed}</ul>` : '<p class="ok">None.</p>'}

      <h3 class="${pair.misnamedShared.length ? 'warn' : 'ok'}">Misnamed shared atoms</h3>
      <p class="muted">Classes that <code>list-page.js</code> emits for every consumer but whose prefix claims a single page (e.g. <code>rp-home-chart-card</code> shown on /monitoring).</p>
      ${pair.misnamedShared.length ? `<ul>${misnamed}</ul>` : '<p class="ok">None.</p>'}

      <details><summary>Only in ${escHtml(pair.a)}  (${pair.onlyA.length})</summary><ul>${onlyA}</ul></details>
      <details><summary>Only in ${escHtml(pair.b)}  (${pair.onlyB.length})</summary><ul>${onlyB}</ul></details>
    `;
  }).join('');

  return `<!doctype html><meta charset="utf-8"><title>css-tab-compare audit</title><style>${css}</style>
<h1>RedPash · CSS tab-compare audit</h1>
<p class="muted">Generated ${escHtml(payload.ran_at)}. Two-tab cross-comparison surfacing naming leaks across list-page consumers. See <code>audit.json</code> for the full payload.</p>
${sections}`;
}

// ─── run ───────────────────────────────────────────────────────────────────
function parsePair(s) {
  const [page, tab] = s.split(':');
  if (!page || !tab) throw new Error(`malformed pair spec "${s}" — expected page:tab`);
  return { page, tab };
}

function runOnce(specA, specB) {
  const a = parsePair(specA);
  const b = parsePair(specB);
  const invA = inventoryTab(a.page, a.tab);
  const invB = inventoryTab(b.page, b.tab);
  const cmp = comparePair(invA, invB);
  return {
    a: specA,
    b: specB,
    inventory: { a: invA, b: invB },
    shared: cmp.shared,
    onlyA: cmp.onlyA,
    onlyB: cmp.onlyB,
    crossPrefix: cmp.crossPrefix,
    mixed: cmp.mixed,
    misnamedShared: cmp.misnamedShared,
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

  // Stdout summary
  results.forEach((r) => {
    process.stdout.write('\n');
    process.stdout.write(writeMarkdown(r.inventory.a, r.inventory.b, r));
    process.stdout.write('\n');
  });

  process.stdout.write(`\n  json -> ${OUT_JSON}\n  html -> ${OUT_HTML}\n`);
}

main();
