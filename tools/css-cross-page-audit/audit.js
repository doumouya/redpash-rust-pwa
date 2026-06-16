#!/usr/bin/env node
/* Purpose: rp-<component>-* class references outside their owning framework component.
 * Doc: docs/internal/code/tools/audit-suite/css-cross-page-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash CSS cross-component class-leak audit  (lean tree)
   ---------------------------------------------------------------------------
   Detects `.rp-<fam>-*` class references in files OTHER than the framework
   component that OWNS that class family. The cleanest fix to such a leak is
   to promote the class into the shared atom layer (`framework/atoms/`) — the
   leak itself is the evidence that the class wasn't actually component-local,
   or that the consumer is reaching across a component boundary it shouldn't.

   Catches what css-audit / css-parallel don't: those measure shape/role
   similarity; this one measures `.rp-<a>-* used outside framework/<a>/`.
   Complements ui-fork-audit too: R4 there enforces ONE CSS sheet may DECLARE
   a class; this measures who REFERENCES it (the borrow, in js/css/html).

   ── Lean adaptation (vs the prerelease original) ─────────────────────────
   The prerelease layout was `frontend/scripts/pages/<page>.js` with a hand-
   maintained OWNERS map of page-prefixes (`rp-home-`, `rp-cases-`, …). The
   lean cut has NO page-prefixed class families and NO `frontend/scripts/`:
     · components live in `frontend/framework/<component>/` (js + css + html)
     · app pages live in   `frontend/apps/<app>/<page>/` (pages use `.pg-*`,
       not `.rp-*` — see ui-fork-audit R1/R2/R8)
     · shared utility/token classes (rp-sp, rp-text, rp-accent, …) are NOT
       declared as `.rp-*` class selectors in any component, so they fall
       out of ownership automatically.
   So ownership is now AUTO-DERIVED (not a hand-list): the owner of family
   `rp-<fam>` is the single framework component dir that DECLARES `.rp-<fam>`
   as a CSS selector. Families declared by >1 component (e.g. an atom, or a
   genuine fork) are treated as shared/ambiguous and only counted, never
   owned — same spirit as the prerelease "unowned" informational tail. The
   `rt-*` namespace is retired; everything is `rp-*`.

   Usage:  node tools/css-cross-page-audit/audit.js [projectRoot]
   Output: ./audit.html + console summary; exit code 1 if any leaks found.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT          = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
var FRONTEND_DIR  = path.join(ROOT, 'frontend');
var FRAMEWORK_DIR = path.join(FRONTEND_DIR, 'framework');
var APPS_DIR      = path.join(FRONTEND_DIR, 'apps');
var STYLES_DIR    = path.join(FRONTEND_DIR, 'styles');

// Directory names that aren't real code (mirrors ui-fork-audit's SKIP_DIRS).
var SKIP_DIRS = { vendor: 1, wasm: 1, 'wasm-src': 1, dist: 1, node_modules: 1, tests: 1 };

// ── walk ────────────────────────────────────────────────────────────────
function walk(dir, exts, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS[d.name]) walk(p, exts, out);
    } else if (exts.some(function (e) { return d.name.endsWith(e); })) {
      out.push(p);
    }
  });
  return out;
}

// All code that can REFERENCE a class (js/html) + all sheets that DECLARE one.
var CODE_FILES  = walk(FRONTEND_DIR, ['.js', '.html']);
var STYLE_FILES = walk(FRONTEND_DIR, ['.css']);

// Match `rp-<token>-...` class names. The class layer convention is kebab-
// case + BEM-ish (`__` for elements, `--` for modifiers). The regex stops
// at chars that are clearly not part of a class name. `--rp-*` custom-prop
// reads are excluded by the leading word boundary + `family()` filter below.
var CLASS_RX = /\brp-[a-z][a-z0-9_-]*\b/g;

// Family = first segment after `rp-` (`rp-gtb-search` → `gtb`).
function family(cls) {
  var rest = cls.slice(3);            // drop "rp-"
  var dash = rest.indexOf('-');
  return dash === -1 ? rest : rest.slice(0, dash);
}

// The framework component dir a file belongs to ("redtable", "grid-toolbar",
// …) or null if the file is not under framework/<component>/.
function componentOf(file) {
  if (file.indexOf(FRAMEWORK_DIR + path.sep) !== 0) return null;
  var rel = path.relative(FRAMEWORK_DIR, file).split(path.sep);
  return rel[0] || null;
}

// Blank out comments before scanning so class names inside them never count
// (e.g. the R4 explainer comments in filter-panel/joins-wizard/report-builder
// that mention `.rp-select` deliberately). We replace every non-newline char
// of a comment with a space — offsets and line numbers stay valid, but no
// `rp-` token can match inside. Handles `//`, `/* … */` (incl. multi-line),
// and CSS block comments uniformly; string-literal false positives are
// negligible for class-name scanning. Mirrors ui-fork-audit's approach.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/(^|[^:])\/\/[^\n]*/g, function (m, pre) { return pre + m.slice(pre.length).replace(/./g, ' '); });
}

// ── derive ownership from CSS DECLARATIONS ────────────────────────────────
// `.rp-<fam>...` appearing in selector position (preceded by `.`) in a
// framework component sheet means that component DECLARES the family. The
// owner of a family is the component dir that declares it — but only if
// exactly one component does. Multi-declared families are shared/ambiguous
// (a genuine fork that ui-fork-audit R4 will flag) and are not owned here.
// A `--rp-*` var assignment never reaches this — the leading `.` excludes it.
//
// The `framework/atoms/` dir is special: it IS the shared layer. Families it
// declares (`rp-btn`, `rp-input`, `rp-chip`, `rp-badge`, …) are MEANT to be
// referenced everywhere — that's the destination of the "promote the leaked
// class into the atom layer" fix this audit recommends. So atom families are
// allowlisted (never owned, never a leak), exactly like the rp-sp/rp-text
// utility tokens that are declared via CSS vars rather than class selectors.
var ATOMS_COMPONENT = 'atoms';
var DECL_RX = /\.rp-[a-z][a-z0-9_-]*\b/g;
var familyDeclarers = Object.create(null);   // fam -> Set(component dir)

STYLE_FILES.forEach(function (file) {
  var comp = componentOf(file);
  if (!comp) return;                          // only framework sheets declare ownership
  var text = stripComments(fs.readFileSync(file, 'utf8'));
  var m;
  while ((m = DECL_RX.exec(text))) {
    var fam = family(m[0].slice(1));          // drop leading "."
    (familyDeclarers[fam] || (familyDeclarers[fam] = Object.create(null)))[comp] = 1;
  }
});

// fam -> owning component dir (only when declared by exactly one NON-atom
// component). Atom-declared families and multi-declared families are skipped.
var OWNER       = Object.create(null);
var atomFamilies = Object.create(null);        // fam -> 1 (shared atom layer)
var sharedFamilies = Object.create(null);      // fam -> declarer count (informational)
Object.keys(familyDeclarers).forEach(function (fam) {
  var comps = Object.keys(familyDeclarers[fam]);
  if (comps.indexOf(ATOMS_COMPONENT) !== -1) { atomFamilies[fam] = 1; return; }
  if (comps.length === 1) OWNER[fam] = comps[0];
  else sharedFamilies[fam] = comps.length;
});

// ── record every REFERENCE (js/html code + all css) ──────────────────────
// className -> { file -> count }
var refs = Object.create(null);
function record(file) {
  var text = stripComments(fs.readFileSync(file, 'utf8'));
  var m;
  while ((m = CLASS_RX.exec(text))) {
    // exclude `--rp-foo` custom-property reads: the char before the match
    // start is a second `-` only for `--rp-…` (the regex already requires a
    // word boundary, but `--rp` makes `rp` a boundary, so guard explicitly).
    if (m.index >= 2 && text[m.index - 1] === '-' && text[m.index - 2] === '-') continue;
    var cls = m[0];
    if (!refs[cls]) refs[cls] = Object.create(null);
    refs[cls][file] = (refs[cls][file] || 0) + 1;
  }
}
CODE_FILES.forEach(record);
STYLE_FILES.forEach(record);

// ── classify each reference ───────────────────────────────────────────────
var leaks   = [];                 // [{ cls, owner, foreign:[{file,count}] }]
var unowned = Object.create(null); // fam -> ref count (informational)

Object.keys(refs).forEach(function (cls) {
  var fam   = family(cls);
  var owner = OWNER[fam];
  if (!owner) {                   // atom / token / shared / undeclared family
    unowned[fam] = (unowned[fam] || 0) + 1;
    return;
  }
  var foreign  = [];
  var fmap     = refs[cls];
  Object.keys(fmap).forEach(function (file) {
    if (componentOf(file) === owner) return;        // owner component allowed
    if (file.indexOf(STYLES_DIR + path.sep) === 0) return; // global sheets allowed
    foreign.push({ file: path.relative(ROOT, file), count: fmap[file] });
  });
  if (foreign.length) {
    leaks.push({ cls: cls, owner: 'frontend/framework/' + owner + '/', foreign: foreign });
  }
});

// Sort by total foreign references descending.
leaks.sort(function (a, b) {
  function total(L) { return L.foreign.reduce(function (s, f) { return s + f.count; }, 0); }
  return total(b) - total(a);
});

// ── HTML report ─────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
  });
}

var totalLeakCount = leaks.reduce(function (s, L) {
  return s + L.foreign.reduce(function (t, f) { return t + f.count; }, 0);
}, 0);

var html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<title>RedPash · CSS cross-component class-leak audit</title>',
  '<style>',
  '  :root { color-scheme: light dark; --bg:#1e1e2e; --surface:#181825; --text:#cdd6f4; --mute:#7f849c; --err:#f38ba8; --ok:#a6e3a1; --warn:#f9e2af; }',
  '  @media (prefers-color-scheme: light) { :root { --bg:#eff1f5; --surface:#e6e9ef; --text:#4c4f69; --mute:#6c6f85; --err:#d20f39; --ok:#40a02b; --warn:#df8e1d; } }',
  '  body { background:var(--bg); color:var(--text); font:13px/1.5 ui-sans-serif, system-ui, sans-serif; margin:1.5rem; }',
  '  h1 { font-size:1.1rem; margin:0 0 0.25rem 0; }',
  '  .sub { color:var(--mute); margin:0 0 1rem 0; max-width:60rem; }',
  '  .stats { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; }',
  '  .chip { background:var(--surface); padding:0.25rem 0.5rem; border-radius:0.375rem; font-size:0.7rem; color:var(--mute); }',
  '  .chip b { color:var(--err); }',
  '  table { border-collapse:collapse; width:100%; background:var(--surface); border-radius:0.5rem; overflow:hidden; }',
  '  th, td { text-align:left; padding:0.5rem 0.75rem; border-bottom:1px solid color-mix(in srgb, var(--mute) 25%, transparent); vertical-align:top; }',
  '  th { background:var(--bg); color:var(--mute); font-weight:600; font-size:0.7rem; text-transform:uppercase; letter-spacing:0.04em; }',
  '  td.cls { font-weight:600; color:var(--err); white-space:nowrap; }',
  '  td.owner { color:var(--mute); font-size:0.75rem; white-space:nowrap; }',
  '  td.foreign { font-size:0.75rem; }',
  '  td.foreign .row { display:flex; gap:0.5rem; }',
  '  td.foreign .count { color:var(--warn); font-variant-numeric:tabular-nums; min-width:2.5rem; text-align:right; }',
  '  td.foreign .file { color:var(--text); }',
  '  .empty { background:var(--surface); padding:1rem; border-radius:0.5rem; color:var(--ok); }',
  '</style>',
  '</head><body>',
  '<h1>RedPash · CSS cross-component class-leak audit</h1>',
  '<p class="sub">Each row is a <code>.rp-&lt;component&gt;-*</code> class referenced outside its owning <code>frontend/framework/&lt;component&gt;/</code>. ' +
  'A leak means either the class should be promoted to the <code>framework/atoms/</code> layer, or the consumer is reaching across a component boundary it shouldn\'t. ' +
  '<small>Complements <code>ui-fork-audit</code> R4 (which flags multiple sheets <em>declaring</em> a class); this one flags files <em>referencing</em> another component\'s class family.</small></p>',
  '<div class="stats">',
  '  <span class="chip">' + Object.keys(refs).length + ' rp-* classes seen</span>',
  '  <span class="chip">' + Object.keys(OWNER).length + ' component-owned families</span>',
  '  <span class="chip">' + Object.keys(atomFamilies).length + ' atom families (allowed)</span>',
  '  <span class="chip">' + Object.keys(sharedFamilies).length + ' shared/ambiguous families</span>',
  '  <span class="chip"><b>' + leaks.length + '</b> classes leaked</span>',
  '  <span class="chip"><b>' + totalLeakCount + '</b> foreign references</span>',
  '</div>',
];

if (!leaks.length) {
  html.push('<div class="empty">✓ no cross-component class leaks</div>');
} else {
  html.push('<table>');
  html.push('  <thead><tr><th>Leaked class</th><th>Owner</th><th>Foreign references</th></tr></thead>');
  html.push('  <tbody>');
  leaks.forEach(function (L) {
    var rows = L.foreign.map(function (f) {
      return '<div class="row"><span class="count">' + f.count + '×</span><span class="file">' + escapeHtml(f.file) + '</span></div>';
    }).join('');
    html.push('    <tr>'
      + '<td class="cls">.' + escapeHtml(L.cls) + '</td>'
      + '<td class="owner">' + escapeHtml(L.owner) + '</td>'
      + '<td class="foreign">' + rows + '</td>'
      + '</tr>');
  });
  html.push('  </tbody>');
  html.push('</table>');
}

html.push('</body></html>');
fs.writeFileSync(path.join(__dirname, 'audit.html'), html.join('\n'));

// ── stdout summary ──────────────────────────────────────────────────────
console.log('');
console.log('  RedPash CSS cross-component class-leak audit');
console.log('  ────────────────────────────────────────────────────────────');
console.log('  scanned: ' + CODE_FILES.length + ' js/html files, ' + STYLE_FILES.length + ' css files');
console.log('  ' + Object.keys(refs).length + ' rp-* classes seen; '
  + Object.keys(OWNER).length + ' component-owned families, '
  + Object.keys(atomFamilies).length + ' atom families (allowed), '
  + Object.keys(sharedFamilies).length + ' shared/ambiguous');
console.log('');
if (!leaks.length) {
  console.log('  ✓ no cross-component class leaks');
} else {
  console.log('  ✗ ' + leaks.length + ' classes leaked across ' + totalLeakCount + ' foreign references:');
  leaks.slice(0, 15).forEach(function (L) {
    var total = L.foreign.reduce(function (s, f) { return s + f.count; }, 0);
    console.log('    .' + L.cls.padEnd(28) + ' owner: ' + L.owner.padEnd(34) + ' ' + total + 'x foreign');
  });
  if (leaks.length > 15) console.log('    … ' + (leaks.length - 15) + ' more (see report)');
}
console.log('');
console.log('  report -> ' + path.relative(ROOT, path.join(__dirname, 'audit.html')));

process.exit(leaks.length ? 1 : 0);
