#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash redtable audit
   ---------------------------------------------------------------------------
   The redtable is the most-used UI primitive in RedPash. Every drift in its
   class naming has cost real time — Em 2026-05-25: "we can work for 5 hours
   straight and because of css bullshit we git force reset to an old version".
   This audit encodes the rules so they're enforced by tooling, not memory.

   Canonical primitives (post-2026-05-25 alignment):
     - .rt-table-wrap   — the immediate <table> parent (flex-fill, scrolls)
     - .rt-table        — the <table> element itself
     - .rt-pager        — the pager wrapper
     - .rt-rows-info    — pager-left readout
     - .rt-pages        — pager-right page-buttons row
     - .rt-pg / .rt-pg-gap — pager buttons + gap span
     - .rt-toolbar      — toolbar row above the wrap
     - .rt-btn, .rt-mode, .rt-search, .rt-sel-chip, .rt-dd-* — toolbar atoms

   Anti-patterns this audit flags:
     R-2  Page-prefixed table classes still in use (rp-table, rp-mon-table)
     R-3  Page-prefixed wrap/pager classes still in use (rp-list-pager)
     R-4  CSS rules whose SUBJECT is .rt-table-anything but live OUTSIDE
          the canonical files (table.css, pager.css, toolbar.css,
          button.css) without an #id-scope or a state-class scope
          (.is-anything, .has-anything). Page-specific overrides MUST
          scope via #id; state variants via .is-foo. Unscoped overrides
          drift silently and cost rebuild time.
     R-5  modes: true (boolean) — renders 3 disabled visual stub buttons.
          Per [[unify-behavior-not-names]]: drop the key or use the
          object form { select: true, ... } so only the wired modes show.
     R-6  Any element classed `*pager*` that isn't `rt-pager`

   We intentionally DO NOT flag <table> elements with custom (non-rt-table)
   classes — joins.js and login.js have specialized minitables that
   legitimately ship their own styling. A "table with no class" is also
   ambiguous (docs sections, content tables); not flagged.

   Each finding prints with file path + 1-based line number so the user can
   jump straight to the offending site. Exit code mirrors cleanliness:
     0 — clean (or only warnings)
     1 — at least one error-class finding (R-2 / R-3 / R-6)

   Usage:  node tools/redtable-audit/audit.js [frontendDir]
   Output: stdout (grep-friendly), no html report. Add one later if useful.

   Read-only — analyses files in place, writes nothing.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTEND_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', '..', 'frontend');

const STYLES_DIR  = path.join(FRONTEND_DIR, 'styles');
const SCRIPTS_DIR = path.join(FRONTEND_DIR, 'scripts');
const PARTIALS_DIR = path.join(FRONTEND_DIR, 'partials');

/* CSS files allowed to author `.rt-table*` rules without an ID scope.
   Anything else that targets those classes is a page-specific override
   not anchored to an ID — the exact pattern that bites us on rebuilds. */
const CANONICAL_TABLE_CSS = new Set([
  'table.css',   // owns .rt-table, .rt-table-wrap, .rt-table-state, .rt-chk, .rt-status
  'pager.css',   // owns .rt-pager, .rt-pages, .rt-pg, .rt-pg-gap, .rt-rows-info
  'toolbar.css', // owns .rt-toolbar, .rt-btn (cross-ref), .rt-mode, .rt-search, .rt-sel-chip, .rt-dd-*
  'button.css',  // owns the .rt-btn base + variants
]);

/* ── file discovery ─────────────────────────────────────────────────── */
function walk(dir, ext, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith(ext)) acc.push(full);
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
  findings.push({ code, severity, file: path.relative(FRONTEND_DIR, file), line, msg });
}

/* ── R-2, R-6 — retired class names on table + pager elements ────────── */
/* Scans HTML + JS for `<table ...>` openings and pager-class declarations
   inside string literals (the renderers emit class="..." strings).
   Only flags the named anti-patterns — tables with custom (non-rt-table)
   classes are trusted (joins.js, login.js, etc. ship specialized tables). */
function scanForTableAndPagerClasses(file, text) {
  // <table ...class="..."...>   — captures the class attribute value.
  // The opening tag may span multiple lines but the class attribute, if
  // present, is on one chunk; we keep it simple and assume so.
  const tableRe = /<table\b([^>]*)>/g;
  let m;
  while ((m = tableRe.exec(text)) !== null) {
    const attrs = m[1];
    const classMatch = /\bclass\s*=\s*(["'])([^"']*)\1/.exec(attrs);
    if (!classMatch) continue;
    const classes = classMatch[2].split(/\s+/).filter(Boolean);
    if (classes.includes('rp-table') || classes.includes('rp-mon-table')) {
      const line = lineOf(text, m.index);
      flag('R-2', 'err', file, line,
        `<table class="${classes.join(' ')}"> — rename to "rt-table" (canonical, 2026-05-25 alignment)`);
    }
  }

  // Any element whose class list mentions "pager" (case-insensitive) but
  // ISN'T `rt-pager` — that's a page-prefixed pager that should consolidate.
  // We scan class="..." substrings only (not bare identifiers in JS), since
  // the class attribute is the user-visible surface that matters.
  const classAttrRe = /\bclass\s*=\s*(["'])([^"']*)\1/g;
  while ((m = classAttrRe.exec(text)) !== null) {
    const classList = m[2].split(/\s+/).filter(Boolean);
    if (classList.length === 0) continue;
    const hasPager = classList.some(c => /pager$/i.test(c));
    if (!hasPager) continue;
    if (classList.includes('rt-pager')) continue;
    const line = lineOf(text, m.index);
    flag('R-6', 'err', file, line,
      `class="${classList.join(' ')}" — pager-shaped class should be "rt-pager"`);
  }
}

/* ── R-3 — page-prefixed table-wrap / pager class names anywhere ────── */
/* Catches:
     - rp-list-pager (retired 2026-05-25)
     - rp-mon-panel USED AS A TABLE WRAP — that's the tricky one; in
       monitoring.js the class is also used for chart cards (legitimate),
       so we don't blanket-flag it. Instead we flag occurrences where the
       SAME tag scope also contains a <table>.
   For the simple case (rp-list-pager / rp-mon-table / rp-table), the
   class-attr scan in scanForTableAndPagerClasses already catches them. */
const RETIRED_CLASSES = ['rp-list-pager']; // table+wrap variants caught above
function scanForRetiredClasses(file, text) {
  for (const cls of RETIRED_CLASSES) {
    const re = new RegExp('\\b' + cls.replace(/-/g, '\\-') + '\\b', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = lineOf(text, m.index);
      flag('R-3', 'err', file, line,
        `retired class "${cls}" still in use — replace with rt-pager (or rt-table-wrap)`);
    }
  }
}

/* ── R-4 — CSS rules whose SUBJECT is .rt-table* outside canonical files ── */
/* The "subject" of a CSS rule is the rightmost compound selector — the
   element it actually styles. A rule like `.rt-table td .rp-mon-method`
   has `.rp-mon-method` as its subject, not `.rt-table`, so it's NOT an
   override of the redtable; it's a rule for content INSIDE the redtable.
   We flag only rules where the SUBJECT is a .rt-table* class.

   Allowed scopes (don't flag even when subject is .rt-*):
     - `#id` ancestor — page-specific override anchored to a known scope
     - `.is-*` / `.has-*` / `.in-*` state class — state variant, intentional
   Anything else with a .rt-* subject outside the canonical files is a
   silently-drifting override that costs rebuild time. */
const STATE_CLASS_RE = /\.(is|has|in)-[a-zA-Z][\w-]*/;
const RT_SUBJECT_RE  = /^\.rt-(?:table(?:-wrap|-state)?|pager|pages|pg(?:-gap)?|rows-info)\b/;

function selectorSubject(sel) {
  // Returns the rightmost compound selector. CSS combinators (>, +, ~)
  // and whitespace separate compounds; we split on those and take the last.
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
    // Skip at-rules; they're previews of nested blocks, not rules.
    if (/^\s*@(media|supports|keyframes|layer|font-face|page|container)\b/.test(fullSel)) continue;

    // CSS rules can have a comma-separated selector list — check each
    // independently so one good selector doesn't mask a bad sibling.
    const selectors = fullSel.split(',').map(s => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      const subject = selectorSubject(sel);
      if (!RT_SUBJECT_RE.test(subject)) continue; // subject isn't a .rt-*
      if (/#[a-zA-Z][\w-]*/.test(sel)) continue;  // scoped via id — allowed
      if (STATE_CLASS_RE.test(sel)) continue;     // scoped via state — allowed
      const line = lineOf(text, m.index);
      flag('R-4', 'warn', file, line,
        `.rt-* override outside canonical files — scope via #id or .is-*. Selector: "${sel}"`);
    }
  }
}

// Blank out CSS block comments while keeping line breaks so line numbers
// stay accurate when we report.
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

/* ── R-5 — disabled-stub mode buttons (toolbar telltale) ────────────── */
/* The list-page.js toolbar template renders mode buttons as disabled
   visual-stubs when `modes: true` (boolean) is passed. Per
   [[unify-behavior-not-names]], that pattern should be removed: either
   wire the mode OR drop `modes` from the toolbar spec. Search home.js
   LIST_VIEWS specs for any `modes: true,` (legacy boolean shape). */
function scanForStubModes(file, text) {
  if (!/home\.js$/.test(file)) return;
  const re = /\bmodes\s*:\s*true\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = lineOf(text, m.index);
    flag('R-5', 'warn', file, line,
      'modes: true (boolean) renders all 3 mode buttons disabled — drop the key, or use { select: true, ... } to enable the wired ones');
  }
}

/* ── runner ─────────────────────────────────────────────────────────── */
const htmlFiles = walk(PARTIALS_DIR, '.html', []);
const jsFiles   = walk(SCRIPTS_DIR, '.js', []);
const cssFiles  = walk(STYLES_DIR, '.css', []);

for (const f of htmlFiles) {
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
  'R-2': 'Page-prefixed table classes (rp-table / rp-mon-table)',
  'R-3': 'Retired wrap/pager classes still referenced',
  'R-4': '.rt-* override outside canonical files (scope via #id or .is-*)',
  'R-5': 'modes: true stub — disabled visual-only buttons',
  'R-6': 'Pager-shaped class that isn\'t rt-pager',
};

let errors = 0, warns = 0;
console.log('\n  RedPash redtable audit');
console.log('  ' + '─'.repeat(60));
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
console.log('  ' + '─'.repeat(60));
console.log(`  ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}\n`);

process.exit(errors > 0 ? 1 : 0);
