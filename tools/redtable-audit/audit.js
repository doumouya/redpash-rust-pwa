#!/usr/bin/env node
/* Purpose: redtable class-name canonical enforcement (lean: rp-redtable / rp-pager / rp-gtb).
 * Doc: docs/internal/code/tools/audit-suite/redtable-audit.md (pending in lean; tracked under docs/REDMAP.md). */
/* ── RedPash redtable audit ──────────────────────────────────────────────────
   The redtable is the most-used UI primitive in RedPash. Every drift in its
   class naming has cost real time — Em 2026-05-25: "we can work for 5 hours
   straight and because of css bullshit we git force reset to an old version".
   This audit encodes the rules so they're enforced by tooling, not memory.

   ── Adapted from prerelease for the lean tree ──────────────────────────────
   The namespace INVERTED. Prerelease's canonical primitive was `.rt-table*`
   and the anti-patterns were the page-prefixed `rp-table` / `rp-list-pager`
   names. In the lean tree the dedup campaign landed: `rp-*` is the ONE
   framework namespace and the `rt-/ds-/ws-` prefixes are RETIRED. So the
   canonical/anti-pattern roles flip — this audit enforces the lean canon and
   flags any surviving `rt-*` table/pager class as the retired namespace.

   Canonical primitives (lean, per the live component CSS):
     - .rp-redtable          — the table component root (flex-fill, owns scroll)
     - .rp-redtable-scroll   — the scroll body inside the root
     - .rp-redtable table    — the <table> element lives inside the root
     - .rp-redtable-* (-th-sort, -sort, -rownum, -num, -null, -foot,
                       -check, -check-cell, -editor, …) — table atoms
     - .rp-pager / .rp-pager-pages / .rp-pager-btn — the pager component
     - .rp-gtb*              — the grid-toolbar component (toolbar atoms)
   Interaction modes are STATE CLASSES on the root (.is-select / .is-edit /
   .is-delete), not separate components or disabled stub buttons.

   Anti-patterns this audit flags (lean roles):
     R-2  <table> carrying a RETIRED table class (rt-table, rp-table,
          rp-mon-table) — rename to the canonical rp-redtable.
     R-3  Retired wrap/pager class names referenced anywhere (rt-table-wrap,
          rt-pager, rt-pages, rt-rows-info, rt-pg, rt-pg-gap, rp-list-pager).
     R-4  CSS rules whose SUBJECT is .rp-redtable* / .rp-pager* but live
          OUTSIDE the canonical owner files (redtable.css, pager.css,
          grid-toolbar.css, atoms.css) without an #id-scope or a state-class
          scope (.is-*, .has-*, .in-*). Page-specific overrides MUST scope via
          #id; state variants via .is-foo. Unscoped overrides drift silently
          and cost rebuild time. (ui-fork-audit R4 sibling: sole-owner CSS.)
     R-5  modes: true (boolean) in a grid/toolbar spec — the retired shape
          that rendered disabled visual stub buttons. Per
          [[unify-behavior-not-names]] the modes are state classes now; drop
          the key or use the object form { select: true, … } so only wired
          modes show. (Finds nothing in lean today; guards the regression.)
     R-6  Any element classed `*pager*` that isn't `rp-pager`.

   We intentionally DO NOT flag <table> elements with custom (non-canonical)
   classes — grid-view ships .rp-gridview-table, a legitimately specialised
   minitable. A "table with no class" is also ambiguous (docs sections,
   content tables); not flagged.

   Each finding records file path + 1-based line number so the user can jump
   straight to the offending site. Writes tools/redtable-audit/audit.json
   ({ findings: [...] }) for the ci-audit ratchet (audit.run_diff stand-in) and
   exits 0 — advisory; ci-audit gates new violations against the baseline,
   matching the rest of the lean suite.

   Lean FE layout: source lives under frontend/framework/<component>/ and
   frontend/apps/<app>/<page>/ (the prerelease frontend/scripts + frontend/partials
   split is retired), plus the shell frontend/index.html and frontend/styles/.

   Usage:  node tools/redtable-audit/audit.js [frontendDir]
   Read-only — analyses files in place; writes only its own audit.json report.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'frontend');
const OUT = path.join(__dirname, 'audit.json');

/* Source roots the lean tree authors by hand. We scan the framework
   components + the per-page apps + the hand-written stylesheets + the shell.
   Build artefacts (wasm/wasm-src/vendor), test fixtures, and node_modules are
   excluded — they're not hand-authored UI surfaces. */
const SOURCE_DIRS = [
  path.join(FRONTEND_DIR, 'framework'),
  path.join(FRONTEND_DIR, 'apps'),
  path.join(FRONTEND_DIR, 'styles'),
];
// directory names anywhere in the walk that are never hand-authored UI source.
const EXCLUDE_DIRS = new Set(['node_modules', 'vendor', 'wasm', 'wasm-src', 'tests', 'target']);

/* CSS files allowed to author `.rp-redtable*` / `.rp-pager*` rules without an
   #id scope. Anything else that targets those subjects is a page-specific
   override not anchored to an id — the exact pattern that bites on rebuilds.
   These are the sole-owner component sheets (matches each file's own header
   "sole owner of …" note). */
const CANONICAL_TABLE_CSS = new Set([
  'redtable.css',     // owns .rp-redtable + every .rp-redtable-* atom
  'pager.css',        // owns .rp-pager, .rp-pager-pages, .rp-pager-btn
  'grid-toolbar.css', // owns .rp-gtb* (the toolbar above the grid)
  'atoms.css',        // owns the .rp-btn / .rp-input base the others compose
]);

/* ── file discovery ─────────────────────────────────────────────────── */
function walk(dir, ext, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), ext, acc);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/* Convert a byte offset within `text` to a 1-based line number. */
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/* ── findings collector ─────────────────────────────────────────────── */
const findings = []; // { code, severity, file, line, msg }
function flag(code, severity, file, line, msg) {
  findings.push({ code, severity, file: path.relative(ROOT, file), line, msg });
}

/* Retired table classes a <table> must never carry (rename → rp-redtable). */
const RETIRED_TABLE_CLASSES = ['rt-table', 'rp-table', 'rp-mon-table'];

/* ── R-2, R-6 — retired class names on table + pager elements ────────── */
/* Scans HTML + JS for `<table ...>` openings and pager-class declarations
   inside class="..." literals (the renderers emit class="..." strings).
   Only flags the named anti-patterns — tables with custom (non-retired)
   classes are trusted (grid-view's .rp-gridview-table, etc.). */
function scanForTableAndPagerClasses(file, text) {
  // <table ...class="..."...>   — captures the class attribute value.
  const tableRe = /<table\b([^>]*)>/g;
  let m;
  while ((m = tableRe.exec(text)) !== null) {
    const attrs = m[1];
    const classMatch = /\bclass\s*=\s*(["'`])([^"'`]*)\1/.exec(attrs);
    if (!classMatch) continue;
    const classes = classMatch[2].split(/\s+/).filter(Boolean);
    const hit = RETIRED_TABLE_CLASSES.find((c) => classes.includes(c));
    if (hit) {
      const line = lineOf(text, m.index);
      flag('R-2', 'err', file, line,
        `<table class="${classes.join(' ')}"> — retired "${hit}"; rename to "rp-redtable" (lean canonical)`);
    }
  }

  // Any element whose class list mentions "pager" (case-insensitive) but
  // ISN'T `rp-pager` — a page-prefixed / retired pager that should consolidate.
  const classAttrRe = /\bclass\s*=\s*(["'`])([^"'`]*)\1/g;
  while ((m = classAttrRe.exec(text)) !== null) {
    const classList = m[2].split(/\s+/).filter(Boolean);
    if (classList.length === 0) continue;
    const pagerTok = classList.find((c) => /pager$/i.test(c));
    if (!pagerTok) continue;
    if (classList.includes('rp-pager')) continue;
    const line = lineOf(text, m.index);
    flag('R-6', 'err', file, line,
      `class="${classList.join(' ')}" — pager-shaped class "${pagerTok}" should be "rp-pager"`);
  }
}

/* ── R-3 — retired table-wrap / pager class names referenced anywhere ── */
/* The lean canon has no separate wrap class (the root .rp-redtable owns the
   scroll), and the pager primitives are .rp-pager*. These retired names —
   prerelease's rt-* family and the older rp-list-pager — must not survive.
   The simple <table>/pager cases are already caught above; this catches the
   bare-identifier references (in JS string concats, CSS selectors, etc.). */
/* Longest-first so a longer retired name (rt-table-wrap, rt-pg-gap) claims its
   span before the shorter prefix (rt-table, rt-pg) — `-` is a word boundary,
   so `\brt-table\b` would otherwise also match inside `rt-table-wrap` and
   double-count one site. We record claimed [start,end) spans and skip a
   shorter match contained within an already-claimed one. */
const RETIRED_CLASSES = [
  'rt-table-wrap', 'rt-rows-info', 'rt-pg-gap', 'rt-pages', 'rt-pager',
  'rt-table', 'rt-pg', 'rp-list-pager',
];
function scanForRetiredClasses(file, text) {
  const claimed = []; // [start, end) spans already attributed to a longer name
  const overlaps = (s, e) => claimed.some(([cs, ce]) => s < ce && e > cs);
  for (const cls of RETIRED_CLASSES) {
    const re = new RegExp('\\b' + cls.replace(/-/g, '\\-') + '\\b', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index, end = m.index + cls.length;
      if (overlaps(start, end)) continue; // already flagged as part of a longer name
      claimed.push([start, end]);
      const line = lineOf(text, start);
      flag('R-3', 'err', file, line,
        `retired class "${cls}" still in use — replace with the rp-* canonical (rp-redtable / rp-pager)`);
    }
  }
}

/* ── R-4 — CSS rules whose SUBJECT is a canonical rp-redtable/rp-pager outside owners ──
   The "subject" of a CSS rule is the rightmost compound selector — the
   element it actually styles. A rule like `.rp-redtable td .rp-mono-pill`
   has `.rp-mono-pill` as its subject, not `.rp-redtable`, so it's NOT an
   override of the redtable; it's a rule for content INSIDE it. We flag only
   rules where the SUBJECT is a canonical redtable/pager class.

   Allowed scopes (don't flag even when subject is canonical):
     - `#id` ancestor — page-specific override anchored to a known scope
     - `.is-*` / `.has-*` / `.in-*` state class — state variant, intentional
   Anything else with a canonical subject outside the owner files is a
   silently-drifting override that costs rebuild time. */
const STATE_CLASS_RE = /\.(is|has|in)-[a-zA-Z][\w-]*/;
const CANON_SUBJECT_RE = /^\.rp-(?:redtable(?:-[\w-]+)?|pager(?:-[\w-]+)?)\b/;

function selectorSubject(sel) {
  // Returns the rightmost compound selector. CSS combinators (>, +, ~) and
  // whitespace separate compounds; split on those and take the last.
  return sel
    .replace(/\s*[>+~]\s*/g, ' ')   // normalize combinators to spaces
    .trim()
    .split(/\s+/)
    .pop() || '';
}

function scanCssOverrides(file, text) {
  const base = path.basename(file);
  if (CANONICAL_TABLE_CSS.has(base)) return;

  // Crude CSS rule scanner — splits on `{` and reads the selector list.
  // Comments are blanked out by stripCssComments() before this runs.
  const ruleRe = /([^{}]+)\{/g;
  let m;
  while ((m = ruleRe.exec(text)) !== null) {
    const fullSel = m[1].trim();
    if (!fullSel) continue;
    // Skip at-rules; they wrap nested blocks, not rules.
    if (/^\s*@(media|supports|keyframes|layer|font-face|page|container)\b/.test(fullSel)) continue;

    // A comma-separated selector list — check each independently so one good
    // selector doesn't mask a bad sibling.
    const selectors = fullSel.split(',').map((s) => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      const subject = selectorSubject(sel);
      if (!CANON_SUBJECT_RE.test(subject)) continue; // subject isn't canonical
      if (/#[a-zA-Z][\w-]*/.test(sel)) continue;     // scoped via id — allowed
      if (STATE_CLASS_RE.test(sel)) continue;        // scoped via state — allowed
      const line = lineOf(text, m.index);
      flag('R-4', 'warn', file, line,
        `.rp-redtable*/.rp-pager* override outside owner files — scope via #id or .is-*. Selector: "${sel}"`);
    }
  }
}

// Blank out CSS block comments while keeping line breaks so line numbers stay
// accurate when we report.
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/* ── R-5 — disabled-stub mode buttons (legacy toolbar telltale) ──────── */
/* The prerelease list-page toolbar rendered mode buttons as disabled visual
   stubs when `modes: true` (boolean) was passed. The lean redtable wires the
   modes as state classes (.is-select / .is-edit / .is-delete on the root), so
   the boolean stub shape should never reappear in a grid/toolbar spec. Scan
   the per-page app specs + framework toolbar/redtable callers for the legacy
   boolean `modes: true`. (No live hits in lean; this guards the regression.) */
function scanForStubModes(file, text) {
  const re = /\bmodes\s*:\s*true\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = lineOf(text, m.index);
    flag('R-5', 'warn', file, line,
      'modes: true (boolean) is the retired disabled-stub shape — modes are state classes now (.is-select/.is-edit/.is-delete); drop the key, or use { select: true, … } for the wired ones');
  }
}

/* ── runner ─────────────────────────────────────────────────────────── */
const htmlFiles = [];
const jsFiles   = [];
const cssFiles  = [];
for (const dir of SOURCE_DIRS) {
  walk(dir, '.html', htmlFiles);
  walk(dir, '.js', jsFiles);
  walk(dir, '.css', cssFiles);
}
// the shell index.html lives at the frontend root, not under a source dir.
const shell = path.join(FRONTEND_DIR, 'index.html');
if (fs.existsSync(shell)) htmlFiles.push(shell);
// the sandbox is a demo harness (not shipped) — exclude it.
const notSandbox = (f) => !/framework-sandbox\.html$/.test(f);

for (const f of htmlFiles.filter(notSandbox)) {
  const t = fs.readFileSync(f, 'utf8');
  scanForTableAndPagerClasses(f, t);
  scanForRetiredClasses(f, t);
}
for (const f of jsFiles) {
  const t = fs.readFileSync(f, 'utf8');
  scanForTableAndPagerClasses(f, t);
  scanForRetiredClasses(f, t);
  scanForStubModes(f, t);
}
for (const f of cssFiles) {
  const raw = fs.readFileSync(f, 'utf8');
  const t = stripCssComments(raw);
  scanCssOverrides(f, t);
  scanForRetiredClasses(f, t);
}

/* ── report ─────────────────────────────────────────────────────────── */
const byCode = findings.reduce((acc, f) => {
  (acc[f.code] = acc[f.code] || []).push(f); return acc;
}, {});

const CODES = ['R-2', 'R-3', 'R-4', 'R-5', 'R-6'];
const TITLES = {
  'R-2': 'Retired table class on <table> (rt-table / rp-table / rp-mon-table)',
  'R-3': 'Retired wrap/pager classes still referenced',
  'R-4': '.rp-redtable*/.rp-pager* override outside owner files (scope via #id or .is-*)',
  'R-5': 'modes: true stub — retired disabled visual-only buttons',
  'R-6': "Pager-shaped class that isn't rp-pager",
};

let errors = 0, warns = 0;
console.log('\n  RedPash redtable audit  (lean: rp-redtable / rp-pager canonical)');
console.log('  ' + '─'.repeat(64));
for (const code of CODES) {
  const list = byCode[code] || [];
  const title = TITLES[code];
  if (list.length === 0) {
    console.log(`  ✓  ${code}  ${title}`);
    continue;
  }
  const sev = list[0].severity;
  const mark = sev === 'err' ? '✗' : '⚠';
  if (sev === 'err') errors += list.length; else warns += list.length;
  console.log(`  ${mark}  ${code}  ${title}  (${list.length})`);
  for (const f of list) {
    console.log(`        ${f.file}:${f.line}  ${f.msg}`);
  }
}
console.log('  ' + '─'.repeat(64));
console.log(`  ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`);

const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT, JSON.stringify({
  tool: 'redtable',
  generatedAt: stamp,
  summary: { tool: 'redtable', filesScanned: htmlFiles.length + jsFiles.length + cssFiles.length, errors, warnings: warns },
  findings,
}, null, 2) + '\n');
console.log('\n  report: tools/redtable-audit/audit.json\n');

// Advisory: exit 0 so ci-audit's ratchet gates new violations via the baseline
// diff (audit.run_diff stand-in), matching the rest of the lean suite.
process.exit(0);
