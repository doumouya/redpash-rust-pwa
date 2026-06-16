#!/usr/bin/env node
/* Purpose: fail when frontend JS/HTML emits a class/id on a RETIRED class family (a half-migration: CSS renamed, emitter not).
 * Doc: docs/internal/code/tools/audit-suite/retired-class-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash — retired-class-prefix gate.

   A design-language dedup renames a class family in CSS (e.g. rt-* → rp-*,
   ds-* → rp-dash-*) and deletes the old sheet. If a JS/HTML EMITTER still ships
   the old name, the canonical rule never matches the live DOM — controls
   unstyle, a chart mount loses its height rule → empty preview (the c282646
   chart-designer class of regression; runbook 0017). The CSS-side audits miss
   it because the CSS is already correct — the drift lives in the emitter.

   This gate scans the EMITTERS (frontend JS + HTML), comment-stripped, for any
   class/id reference whose prefix is a RETIRED family, and fails (exit 1).

   In the lean cut the rt-* → rp-* migration is COMPLETE (the lean tree's CSS
   namespace is rp-*), so any live `rt-` emit is drift and `rt-` is gated. `ds-`
   (→ rp-dash-*) is carried from prerelease as a fully-retired family; it does
   not appear in the lean tree but staying in the watch set keeps the gate a
   superset guard at zero cost. Comment-stripping is what keeps these entries
   false-positive-free — a class-like token inside a comment (e.g. a JS doc
   block that names ".rt-table") is not a real emit.

   LEAN ADAPTATION: prerelease scanned the single flat frontend/scripts/**.js +
   frontend/partials/*.html tree (since retired). The lean cut co-locates JS +
   HTML per component/page under frontend/framework/<component>/ and
   frontend/apps/<app>/<page>/, plus the top-level index.html and
   framework-sandbox.html shells; all are scanned and findings reported relative
   to the repo root. frontend/vendor/ (third-party, e.g. bootstrap-icons whose
   CSS contains incidental `rt-`/`ds-` substrings) is NOT scanned. The
   extraction, comment-stripping, reporting, and exit-code contract are
   unchanged from prerelease.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var FE = path.join(ROOT, 'frontend');

// retired family prefix → canonical family prefix (for the fix hint).
// rt-* is the live lean concern (migration to rp-* is done in CSS); ds-* is a
// fully-retired prerelease family kept as a zero-cost superset guard.
var RETIRED = { 'rt-': 'rp-', 'ds-': 'rp-dash-' };

function walk(dir, ext, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, ext, out);
    else if (d.name.endsWith(ext)) out.push(p);
  });
  return out;
}

// Strip comments so a class-like token inside a comment can't trip the gate.
// Blank a comment in place (newlines + column positions preserved) so the
// line numbers we report stay exact — a collapsing replace would shift them.
function blank(m) { return m.replace(/[^\n]/g, ' '); }
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, blank)        // /* block */
          .replace(/(^|[^:])\/\/[^\n]*/g, function (m, p1) { return p1 + blank(m.slice(p1.length)); });
}
function stripHtmlComments(s) { return s.replace(/<!--[\s\S]*?-->/g, blank); }

function retiredOf(name) {
  var keys = Object.keys(RETIRED);
  for (var i = 0; i < keys.length; i++) if (name.indexOf(keys[i]) === 0) return keys[i];
  return null;
}

var findings = []; // { file, line, kind, name, canonical }
function record(name, kind, file, lineNo) {
  var pre = retiredOf(name);
  if (!pre) return;
  findings.push({
    file: path.relative(ROOT, file), line: lineNo, kind: kind,
    name: name, canonical: RETIRED[pre] + name.slice(pre.length),
  });
}

// Extract class/id references from one comment-stripped line.
function scanLine(L, file, lineNo) {
  var m;
  // class="a b" / id="x"  (HTML attrs + JS inline-HTML template strings)
  var attrRe = /\b(class|id)\s*=\s*(["'`])([^"'`]*)\2/g;
  while ((m = attrRe.exec(L)) !== null) {
    var kind = m[1] === 'id' ? 'id' : 'class';
    m[3].split(/\s+/).forEach(function (tok) { if (tok) record(tok, kind, file, lineNo); });
  }
  // querySelector(All) / closest / matches(".x" | "#x" | ".a.b")
  var selRe = /(?:querySelector(?:All)?|closest|matches)\s*\(\s*(["'`])([^"'`]+)\1/g;
  while ((m = selRe.exec(L)) !== null) {
    (m[2].match(/\.[A-Za-z_][\w-]*/g) || []).forEach(function (c) { record(c.slice(1), 'class', file, lineNo); });
    (m[2].match(/#[A-Za-z_][\w-]*/g) || []).forEach(function (id) { record(id.slice(1), 'id', file, lineNo); });
  }
  // getElementById("x")
  var byId = /getElementById\s*\(\s*(["'`])([^"'`]+)\1/g;
  while ((m = byId.exec(L)) !== null) record(m[2], 'id', file, lineNo);
  // classList.add/remove/toggle/contains/replace("x")
  var clsRe = /classList\.(?:add|remove|toggle|contains|replace)\s*\(\s*(["'`])([^"'`]+)\1/g;
  while ((m = clsRe.exec(L)) !== null) record(m[2], 'class', file, lineNo);
  // el.className = "a b"  /  el.id = "x"   (property-assignment emitters — tile-builders build this way)
  var assignRe = /\.(className|id)\s*=\s*(["'`])([^"'`]*)\2/g;
  while ((m = assignRe.exec(L)) !== null) {
    var akind = m[1] === 'id' ? 'id' : 'class';
    m[3].split(/\s+/).forEach(function (tok) { if (tok) record(tok, akind, file, lineNo); });
  }
  // setAttribute("class"|"id", "a b")
  var setAttrRe = /setAttribute\s*\(\s*(["'`])(class|id)\1\s*,\s*(["'`])([^"'`]*)\3/g;
  while ((m = setAttrRe.exec(L)) !== null) {
    var skind = m[2] === 'id' ? 'id' : 'class';
    m[4].split(/\s+/).forEach(function (tok) { if (tok) record(tok, skind, file, lineNo); });
  }
}

function scanFile(file, strip) {
  var lines = strip(fs.readFileSync(file, 'utf8')).split('\n');
  for (var i = 0; i < lines.length; i++) scanLine(lines[i], file, i + 1);
}

// Lean FE emitter homes: JS + HTML co-located per component/page under
// frontend/framework + frontend/apps, plus the top-level shell HTML.
// frontend/vendor is excluded (third-party, incidental rt-/ds- substrings).
var jsFiles = walk(path.join(FE, 'framework'), '.js', [])
  .concat(walk(path.join(FE, 'apps'), '.js', []));
jsFiles.forEach(function (f) { scanFile(f, stripJsComments); });

var htmlFiles = walk(path.join(FE, 'framework'), '.html', [])
  .concat(walk(path.join(FE, 'apps'), '.html', []));
[path.join(FE, 'index.html'), path.join(FE, 'framework-sandbox.html')].forEach(function (p) {
  if (fs.existsSync(p)) htmlFiles.push(p);
});
htmlFiles.forEach(function (f) { scanFile(f, stripHtmlComments); });

// ── report ────────────────────────────────────────────────────────────────
console.log('RedPash retired-class-prefix gate');
console.log('  watching: ' + Object.keys(RETIRED).map(function (p) { return p + '* → ' + RETIRED[p] + '*'; }).join(', '));
console.log('');
if (!findings.length) {
  console.log('  OK — no retired-family class/id emitted by frontend JS/HTML.');
  process.exit(0);
}
console.log('  FAIL — ' + findings.length + ' retired-family reference(s). The CSS for these families was');
console.log('  renamed; the emitter must ship the canonical name (a half-migration regression):');
console.log('');
findings
  .sort(function (a, b) { return a.file.localeCompare(b.file) || a.line - b.line; })
  .forEach(function (f) {
    var mark = f.kind === 'id' ? '#' : '.';
    console.log('      ' + f.file + ':' + f.line + '   ' + mark + f.name + '  →  ' + mark + f.canonical);
  });
console.log('');
console.log('  fix: rename the emitter to the canonical family (runbook 0017). Retired set: '
  + Object.keys(RETIRED).join(', '));
process.exit(1);
