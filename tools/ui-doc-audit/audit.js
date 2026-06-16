#!/usr/bin/env node
/* Purpose: ui-doc-audit — the UI documentation COMPLETENESS check + dedup/divergence
 * detector + framework-namespace gate.
 * Doc: docs/internal/code/frontend/components.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash ui-doc-audit  (LEAN tree)

   Em's requirement: completeness must be GUARANTEED, not curated — a hand list
   silently misses components (a modal, the omnisearch dropdown…). So the
   DENOMINATOR is enumerated from code by tools/lib/fe-inventory.js, and this
   audit reports any enumerated component that is not documented in the lean
   component doc (docs/internal/code/frontend/components.md). Same discipline as
   doc-coverage-audit (files) + api-doc-audit (routes). UI = backend.

   LEAN ADAPTATION (2026-06-16): the predecessor gated on a doc-gen-GENERATED
   catalog index (docs/internal/ui/catalog/index.md) that was complete BY
   CONSTRUCTION, so a stale index could be a HARD fail. The lean cut has no
   doc-gen and no catalog/ tier — its component doc is a single CURATED topic
   doc (docs/internal/code/frontend/components.md, the lean docs spine). A
   curated prose doc is NOT generated-complete, so making per-component coverage
   a CI-wedging hard fail would punish the suite for the docs being curated (the
   same reasoning that made doc-coverage-audit drop the atomic-doc mapping). So:
     • coverage is now ADVISORY (work-items to file), EXCEPT the doc being
       entirely MISSING, which stays a hard error (the doc must exist);
     • the HARD gate is framework-namespace cleanliness — the framework is born
       clean (rp- flat-kebab, no rt-/ds-/ws-/__) so it can't seed fresh dupes.
   The namespace is rp- (+ pg- page-scoped); rt-/ds-/ws- are retired (0 in the
   tree). The framework-born-clean roots are frontend/framework + frontend/styles
   (frontend/scripts/framework and frontend/styles/framework are gone). The
   prerelease cell-editor FW_NS_ALLOW entry is dropped — the lean framework has
   no legacy-namespace refs to allowlist.

   Finding classes:
     • coverage   (advisory; HARD only if the doc is missing) — an enumerated
                   component is not mentioned in the lean component doc → document it.
     • divergence (advisory)     — one class styled under ≥2 ancestor contexts → unify.
     • parallel   (advisory)     — a role-suffix shared across blocks → compose one atom.
     • namespace  (HARD, exit 1) — a NEW rt-/ds-/ws-/__ token under frontend/framework
                                    or frontend/styles → the framework must stay clean.

   Read-only. No deps beyond tools/lib/fe-inventory. Emits audit.json + audit.html.
   Usage:  node tools/ui-doc-audit/audit.js
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');
var inv = require('../lib/fe-inventory');

var ROOT = path.resolve(__dirname, '..', '..');
/* Lean component doc (curated topic doc, docs spine). The predecessor's
   generated catalog index (docs/internal/ui/catalog/index.md) does not exist in
   the lean tree — there is no doc-gen / catalog tier. */
var DOC = path.join(ROOT, 'docs', 'internal', 'code', 'frontend', 'components.md');
var DOC_REL = path.relative(ROOT, DOC);
/* Framework-born-clean roots: the lean cut co-locates the framework under
   frontend/framework (js+css), with foundation sheets in frontend/styles. */
var FW_DIRS = [path.join(ROOT, 'frontend', 'framework'),
               path.join(ROOT, 'frontend', 'styles')];

/* ── namespace lint — the rp--only guardrail (limits dupe CREATION) ───────────
   ONE namespace — rp- (components) + pg- (page-scoped), flat kebab, no __ (BEM
   elements), no rt-/ds-/ws-. Legacy violations across the whole frontend are the
   migration BURNDOWN (advisory metric). NEW violations under frontend/framework
   or frontend/styles are a HARD fail — the framework is born clean. */
function fwWalk(dir, out) {
  out = out || [];
  var ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name.charAt(0) === '.') return; fwWalk(p, out); }
    else if (/\.(js|css|html)$/.test(e.name)) out.push(p);
  });
  return out;
}
function stripComments(txt, file) {   // so prose mentioning rt-/__ doesn't false-fail
  if (/\.css$/.test(file)) return txt.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\.html$/.test(file)) return txt.replace(/<!--[\s\S]*?-->/g, '');
  return txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); // js
}
/* A bad namespace token: a retired-prefix class (rt-/ds-/ws-…) OR a BEM `__`
   element on an rp-/pg- class (the flat-kebab rule bans `__`). */
var BAD_NS = /\b(?:(?:rt|ds|ws)-[a-z0-9]+(?:-[a-z0-9]+)*|(?:rp|pg)-[a-z0-9]+(?:-[a-z0-9]+)*__[a-z0-9]+)/g;
/* Pre-existing framework refs to allowlist (token-scoped). Empty in the lean
   tree — the framework is born clean. Add `'<rel-path>|<token>': 'why'` entries
   only for a TRACKED legacy ref that migrates with its owning slice. */
var FW_NS_ALLOW = {};
function namespaceLint(a) {
  var legacy = {};
  a.components.concat(a.hooks).forEach(function (g) {
    g.classes.forEach(function (c) { if (/^(rt|ds|ws)-/.test(c) || c.indexOf('__') >= 0) legacy[c] = true; });
  });
  var fw = [], fwAllowed = 0;
  FW_DIRS.forEach(function (dir) {
    fwWalk(dir).forEach(function (f) {
      var rel = path.relative(ROOT, f), txt = '';
      try { txt = stripComments(fs.readFileSync(f, 'utf8'), f); } catch (e) {}
      var m; BAD_NS.lastIndex = 0;
      while ((m = BAD_NS.exec(txt))) {
        if (FW_NS_ALLOW[rel + '|' + m[0]]) { fwAllowed++; continue; }   // pre-existing, tracked
        fw.push({ kind: 'namespace', severity: 'error', file: rel, token: m[0],
          detail: 'framework/styles must be rp-/pg- flat-kebab (no rt-/ds-/ws-/__) — found `' + m[0] + '`' });
      }
    });
  });
  return { legacyCount: Object.keys(legacy).length, fw: fw, fwAllowed: fwAllowed };
}

/* ── coverage: every enumerated component should be documented in the lean doc ──
   Advisory in lean (the doc is curated, not generated-complete). HARD only if the
   doc is missing entirely. */
function coverageFindings(components) {
  var text = null;
  try { text = fs.readFileSync(DOC, 'utf8'); } catch (e) { /* missing */ }
  if (text == null) {
    return [{ kind: 'coverage', severity: 'error', component: '(all)',
      detail: DOC_REL + ' is missing — the lean component doc must exist' }];
  }
  var findings = [];
  components.forEach(function (g) {
    // the doc mentions a component by its key/label somewhere in the prose/tables;
    // token presence is enough (advisory — file a work-item to document the gap).
    if (text.indexOf(g.key) < 0) findings.push({ kind: 'coverage', severity: 'warn',
      component: g.key, classes: g.classes.length, jsRendered: g.jsRendered,
      detail: 'component not mentioned in ' + DOC_REL + ' (document it)' });
  });
  return findings;
}

/* ── html report ──────────────────────────────────────────────────────────── */
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function table(headers, rows) {
  return '<table><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) {
      return '<td>' + esc(Array.isArray(c) ? c.join(', ') : (c == null ? '' : c)) + '</td>'; }).join('') + '</tr>'; }).join('') +
    '</table>';
}
function html(summary, cov, div, par, nsFw) {
  var covHard = cov.some(function (f) { return f.severity === 'error'; });
  return '<!doctype html><meta charset=utf8><title>ui-doc-audit</title>' +
    '<style>body{font:14px/1.5 system-ui;margin:2rem;max-width:80rem}h2{margin-top:2rem}' +
    'table{border-collapse:collapse;width:100%;margin:.5rem 0}td,th{border:1px solid #ccc;padding:.3rem .5rem;text-align:left;vertical-align:top}' +
    '.err{color:#b00}.warn{color:#a60}code{background:#f4f4f4;padding:0 .2rem}</style>' +
    '<h1>ui-doc-audit <small>(lean)</small></h1><p>' + esc(JSON.stringify(summary)) + '</p>' +
    '<h2 class=err>framework namespace violations (' + nsFw.length + ') — hard fail</h2>' +
      table(['file', 'token', 'detail'], nsFw.map(function (f) { return [f.file, f.token, f.detail]; })) +
    '<h2 class="' + (covHard ? 'err' : 'warn') + '">coverage gaps (' + cov.length + ') — ' +
      (covHard ? 'doc missing (hard)' : 'advisory') + '</h2>' +
      table(['component', 'classes', 'detail'], cov.map(function (f) { return [f.component, f.classes, f.detail]; })) +
    '<h2 class=warn>divergence (' + div.length + ') — same name, different behavior</h2>' +
      table(['class', 'contexts'], div.map(function (f) { return ['.' + f.cls, f.contexts]; })) +
    '<h2 class=warn>parallel-class clusters (' + par.length + ') — compose, don\'t parallel</h2>' +
      table(['-suffix', 'blocks', 'count', 'members'], par.map(function (f) { return ['-' + f.suffix, f.blocks, f.count, f.members]; }));
}

/* ── main ─────────────────────────────────────────────────────────────────── */
function main() {
  var a = inv.analyze();
  var cov = coverageFindings(a.components);
  var covHard = cov.filter(function (f) { return f.severity === 'error'; }).length;
  var div = a.divergences, par = a.parallels;
  var ns = namespaceLint(a);

  var summary = {
    components: a.counts.components, hooks: a.counts.hooks, classes: a.counts.classes,
    coverageGaps: cov.length, coverageHard: covHard,
    divergences: div.length, parallelClusters: par.length,
    namespaceLegacy: ns.legacyCount, namespaceFwViolations: ns.fw.length, namespaceFwAllowed: ns.fwAllowed,
  };
  var stamp = new Date().toISOString().slice(0, 10);
  var findings = cov
    .concat(div.map(function (d) { return { kind: 'divergence', severity: 'warn', cls: d.cls, contexts: d.contexts,
      detail: '`.' + d.cls + '` styled under ' + d.contexts.length + ' contexts' }; }))
    .concat(par.map(function (p) { return { kind: 'parallel', severity: 'warn', suffix: p.suffix, count: p.count,
      blocks: p.blocks, members: p.members, detail: '`-' + p.suffix + '` in ' + p.count + ' classes across ' + p.blocks + ' blocks' }; }))
    .concat(ns.fw);
  fs.writeFileSync(path.join(__dirname, 'audit.json'),
    JSON.stringify({ tool: 'ui-doc', generatedAt: stamp, summary: summary, findings: findings }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'audit.html'), html(summary, cov, div, par, ns.fw));

  console.log('ui-doc-audit (lean)');
  console.log('───────────────────');
  console.log('components:        ' + summary.components + '  (catalog denominator)');
  console.log('dynamic hooks:     ' + summary.hooks);
  console.log('classes:           ' + summary.classes);
  console.log('coverage gaps:     ' + summary.coverageGaps + (covHard ? '  ← FAIL (component doc missing)' : (summary.coverageGaps ? '  (advisory — document)' : '  ✓ all documented')));
  console.log('divergences:       ' + summary.divergences + '  (same class, ≥2 ancestor contexts)');
  console.log('parallel clusters: ' + summary.parallelClusters + '  (shared role-suffix across blocks)');
  console.log('namespace legacy:  ' + summary.namespaceLegacy + '  (rt-/ds-/ws-/__ classes — migration burndown to 0)');
  console.log('framework ns viol: ' + summary.namespaceFwViolations + (summary.namespaceFwViolations ? '  ← FAIL (framework/styles must be rp-/pg- flat-kebab)' : '  ✓ no NEW framework violations') + (summary.namespaceFwAllowed ? '  (' + summary.namespaceFwAllowed + ' pre-existing allowlisted)' : ''));
  if (par.length) {
    console.log('\ntop parallel-class clusters (compose → atom):');
    par.slice(0, 8).forEach(function (f) { console.log('  -' + f.suffix + '  ×' + f.count + ' across ' + f.blocks + ' blocks'); });
  }
  console.log('\nreport: ' + path.relative(ROOT, path.join(__dirname, 'audit.html')));
  // HARD gate: framework-namespace cleanliness + the component doc existing
  // (per-component coverage is advisory in lean — the doc is curated, not generated).
  process.exit((covHard || ns.fw.length) ? 1 : 0);
}
main();
