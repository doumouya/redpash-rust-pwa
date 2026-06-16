#!/usr/bin/env node
/* Purpose: class-count lint — enforce ≤1 framework class + 1 id per atom (state→aria, variants→context/data-variant).
 * Doc: docs/internal/code/tools/audit-suite/class-count-audit.md (pending in lean; tracked under docs/REDMAP.md). */
/* ── RedPash class-count-audit ──────────────────────────────────────────────
   Em's coherence rule (CAS_37B2E1BF): a MAXIMUM of ONE framework class
   (rp-) + ONE id per element. Class-stacking is the dedup target —
   `rp-chip rp-settings-tag` (identity-stack) and `rp-btn-icon rp-btn-icon--accent`
   (modifier-stack) both violate it. The locked rule: a variant that follows a
   container → ancestor CSS; a container-independent variant → a `data-variant`
   attr; state → `aria-*`. So an atom carries one framework class plus only
   data-attrs, aria-attrs, a `bi bi-…` vendor icon, and one id — nothing else.

   Lean note: the namespace is `rp-*`; the legacy `rt-/ds-/ws-` prefixes are
   retired in this tree, so the framework matcher is `rp-` only. (Older trees
   stacked four prefixes during the dedup campaign.)

   This lint scans every static `class="…"` literal in the FE source and flags:
     • multi_framework_class (HIGH) — ≥2 framework tokens on one element → collapse
       to one atom; move the extra to context / a data-variant. This count is the
       COHERENCE BURNDOWN metric for the campaign.
     • legacy_state_class (advisory) — `is-`/`has-`/bare state words → move to aria-*.

   Scans STATIC class="…" literals (the bulk of markup stacking); dynamic
   className=/classList toggles (mostly state) are the aria migration, not linted
   here. Read-only, regex-based (no Acorn needed). exit 0 — ci-audit gates via
   audit.run_diff like the rest of the suite.

   Lean FE layout: source lives under frontend/framework/<component>/ and
   frontend/apps/<app>/<page>/ (the prerelease frontend/scripts + frontend/partials
   split is retired), plus the shell frontend/index.html.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var FE = path.join(ROOT, 'frontend');
var OUT = path.join(__dirname, 'audit.json');

var FW = /^rp-/;                                            // framework atom prefix (lean: rp- only)
var BARE_STATES = { active: 1, open: 1, selected: 1, busy: 1, dirty: 1, clean: 1, done: 1, editing: 1, dragging: 1, current: 1 };
function isState(t) { return /^(is|has)-/.test(t) || BARE_STATES[t] === 1; }
function isVendor(t) { return t === 'bi' || /^bi-/.test(t); }

function walk(dir, out) {
  var ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(d.name)) out.push(p);
  });
  return out;
}

var files = walk(path.join(FE, 'framework'), []).concat(walk(path.join(FE, 'apps'), []));
if (fs.existsSync(path.join(FE, 'index.html'))) files.push(path.join(FE, 'index.html'));
// the sandbox is a demo harness (not shipped) — exclude it from the live-coherence metric.
files = files.filter(function (f) { return !/framework-sandbox\.html$/.test(f); });

var CLASS_RE = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
var findings = [], multi = 0, stateN = 0, attrs = 0;

files.forEach(function (f) {
  var src;
  try { src = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
  var rel = path.relative(ROOT, f);
  var m;
  while ((m = CLASS_RE.exec(src))) {
    var val = (m[1] != null ? m[1] : m[2]) || '';
    // strip quote/backtick noise from dynamic-concat captures (class="rp-x' + ...) so
    // tokens read clean; non-class operators (+, ?, :) simply never match FW/state.
    var toks = val.split(/\s+/).map(function (t) { return t.replace(/['"`]/g, ''); }).filter(Boolean);
    var fw = toks.filter(function (t) { return FW.test(t) && !isVendor(t); });
    var st = toks.filter(isState);
    attrs++;
    var line = src.slice(0, m.index).split('\n').length;
    if (fw.length > 1) {
      multi++;
      findings.push({ kind: 'multi_framework_class', severity: 'high', file: rel, line: line, classes: fw,
        detail: '>1 framework class on one element — collapse to one atom; variant → context / data-variant' });
    }
    if (st.length) {
      stateN++;
      findings.push({ kind: 'legacy_state_class', severity: 'low', file: rel, line: line, classes: st,
        detail: 'state class should be an aria-* attribute (is-active → aria-pressed/selected/current)' });
    }
  }
});

var summary = {
  tool: 'class-count',
  filesScanned: files.length,
  classAttrs: attrs,
  multiFrameworkClass: multi,
  legacyStateClass: stateN,
};
var stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT, JSON.stringify({ tool: 'class-count', generatedAt: stamp, summary: summary, findings: findings }, null, 2) + '\n');

console.log('class-count-audit  (≤1 framework class + 1 id per atom)');
console.log('─────────────────────────────────────────────────────');
console.log('  files scanned:          ' + summary.filesScanned);
console.log('  static class= literals: ' + summary.classAttrs);
console.log('  multi-framework-class:  ' + summary.multiFrameworkClass + (multi ? '   ← the coherence burndown (collapse to one atom)' : '   ✓ none'));
console.log('  legacy state classes:   ' + summary.legacyStateClass + '   (→ aria-*; advisory)');
if (multi) {
  console.log('\n  top offenders:');
  findings.filter(function (f) { return f.kind === 'multi_framework_class'; }).slice(0, 15).forEach(function (f) {
    console.log('    ' + f.file + ':' + f.line + '   ' + f.classes.join(' + '));
  });
}
console.log('\n  report: tools/class-count-audit/audit.json');
process.exit(0);   // advisory; ci-audit gates new violations via audit.run_diff
