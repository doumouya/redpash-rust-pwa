#!/usr/bin/env node
/* Purpose: page-prefixed CSS class references outside their owner JS.
 * Doc: docs/internal/code/tools/audit-suite/css-cross-page-audit.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash CSS cross-page class-leak audit
   ---------------------------------------------------------------------------
   Detects `.rp-<pageA>-*` class references in JS files OTHER than
   `pages/<pageA>.js`. The cleanest fix to such a leak is to promote the
   class into the `rt-*` atom layer — the leak itself is the evidence that
   the class wasn't actually page-specific.

   Catches what css-parallel doesn't: that audit measures `.rp-* ↔ .rt-*`
   similarity, this one measures `.rp-<a>-* used outside pages/<a>.js`.
   They're complementary axes — both feed [[feedback-compose-atoms-dont-parallel]]
   and [[feedback-naming-consistency]].

   The trigger case (2026-05-25): `.rp-mon-method` (monitoring's HTTP-method
   badge atom) reused 20+ times in pages/home.js as a monospace ID/handle
   display, with the comment `// .rp-mon-method base + .rp-mon-err-* for
   tone` confirming the borrow was deliberate, not accidental. css-parallel
   missed it because the class isn't being paralleled — it's being borrowed.

   The OWNERS map below is hand-maintained: prefix → owning page file. Add
   a row as new pages land. Unmapped prefixes are skipped (informational
   count only).

   CSS files in `frontend/styles/` are always allowed to reference the
   class — that's where the rule lives. Same for the owning page file.

   Usage:  node tools/css-cross-page-audit/audit.js [projectRoot]
   Output: ./audit.html + console summary; exit code 1 if any leaks found.
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT        = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
var SCRIPTS_DIR = path.join(ROOT, 'frontend', 'scripts');
var STYLES_DIR  = path.join(ROOT, 'frontend', 'styles');

// page-prefix → owning page file (relative to repo root). Add a row when a
// new page lands. The prefix must include its trailing `-` so `rp-cases-`
// doesn't accidentally match `rp-cases__` (which wouldn't follow the
// convention anyway, but defense-in-depth).
var OWNERS = {
  'rp-home-':      'frontend/scripts/pages/home.js',
  'rp-mon-':       'frontend/scripts/pages/monitoring.js',
  'rp-ws-':        'frontend/scripts/pages/workspace.js',
  'rp-workspace-': 'frontend/scripts/pages/workspace.js',
  'rp-cases-':     'frontend/scripts/pages/cases.js',
  'rp-profile-':   'frontend/scripts/pages/profile.js',
  'rp-settings-':  'frontend/scripts/pages/settings.js',
  'rp-login-':     'frontend/scripts/pages/login.js',
  'rp-doc-':       'frontend/scripts/pages/docs.js',
  'rp-docs-':      'frontend/scripts/pages/docs.js',
};

// ── walk ────────────────────────────────────────────────────────────────
function walk(dir, ext, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, ext, out);
    else if (d.name.endsWith(ext)) out.push(p);
  });
  return out;
}

var SCRIPT_FILES = walk(SCRIPTS_DIR, '.js');
var STYLE_FILES  = walk(STYLES_DIR,  '.css');

// Match `rp-<token>-...` class names. The class layer convention is kebab-
// case + BEM-ish (`__` for elements, `--` for modifiers). The regex stops
// at chars that are clearly not part of a class name.
var CLASS_RX = /\brp-[a-z][a-z0-9_-]*\b/g;

// Skip matches that fall inside a line/block comment. Heuristic but
// catches the common forms (JS `//`, JSDoc `*`, block `/*`). Misses
// trailing inline comments (`foo; // .rp-bar`) — acceptable for v1 since
// trailing comments on class-name lines are rare in this codebase.
function isCommentMatch(text, matchIndex) {
  var lineStart = text.lastIndexOf('\n', matchIndex - 1) + 1;
  while (lineStart < text.length && (text[lineStart] === ' ' || text[lineStart] === '\t')) {
    lineStart++;
  }
  var c0 = text[lineStart], c1 = text[lineStart + 1];
  return (c0 === '/' && (c1 === '/' || c1 === '*')) || c0 === '*';
}

// className -> { file -> count }
var refs = Object.create(null);
function record(file) {
  var text = fs.readFileSync(file, 'utf8');
  var m;
  while ((m = CLASS_RX.exec(text))) {
    if (isCommentMatch(text, m.index)) continue;
    var cls = m[0];
    if (!refs[cls]) refs[cls] = Object.create(null);
    refs[cls][file] = (refs[cls][file] || 0) + 1;
  }
}
SCRIPT_FILES.forEach(record);
STYLE_FILES.forEach(record);

function resolveOwner(cls) {
  // Longest-prefix wins so `rp-workspace-` beats `rp-ws-` for both shapes.
  var hit = null;
  Object.keys(OWNERS).forEach(function (prefix) {
    if (cls.indexOf(prefix) === 0 && (!hit || prefix.length > hit.prefix.length)) {
      hit = { prefix: prefix, owner: OWNERS[prefix] };
    }
  });
  return hit;
}

// Classify each class reference.
var leaks = [];     // [{ cls, owner, foreign:[{file,count}] }]
var unowned = {};   // prefix -> count (informational)

Object.keys(refs).forEach(function (cls) {
  var meta = resolveOwner(cls);
  if (!meta) {
    // Track the unmapped prefix-ish chunk for the informational tail.
    var stem = cls.split('-').slice(0, 2).join('-') + '-';
    unowned[stem] = (unowned[stem] || 0) + 1;
    return;
  }
  var ownerAbs  = path.join(ROOT, meta.owner);
  var foreign   = [];
  var fmap      = refs[cls];
  Object.keys(fmap).forEach(function (file) {
    if (file === ownerAbs) return;                 // owner allowed
    if (file.indexOf(STYLES_DIR) === 0) return;    // CSS def allowed
    foreign.push({ file: path.relative(ROOT, file), count: fmap[file] });
  });
  if (foreign.length) {
    leaks.push({ cls: cls, owner: meta.owner, foreign: foreign });
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
  '<title>RedPash · CSS cross-page class-leak audit</title>',
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
  '<h1>RedPash · CSS cross-page class-leak audit</h1>',
  '<p class="sub">Each row is a <code>.rp-&lt;page&gt;-*</code> class referenced outside its owning <code>pages/&lt;page&gt;.js</code>. ' +
  'A leak means either the class should be promoted to the <code>.rt-*</code> atom layer, or the consumer is reaching across a boundary it shouldn\'t. ' +
  '<small>Complements <code>css-parallel</code>: that one flags <code>.rp-* ↔ .rt-*</code> shape similarity; this one flags borrowed page classes.</small></p>',
  '<div class="stats">',
  '  <span class="chip">' + Object.keys(refs).length + ' rp-* classes seen</span>',
  '  <span class="chip">' + Object.keys(OWNERS).length + ' page prefixes mapped</span>',
  '  <span class="chip"><b>' + leaks.length + '</b> classes leaked</span>',
  '  <span class="chip"><b>' + totalLeakCount + '</b> foreign references</span>',
  '</div>',
];

if (!leaks.length) {
  html.push('<div class="empty">✓ no cross-page class leaks</div>');
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
console.log('  RedPash CSS cross-page class-leak audit');
console.log('  ────────────────────────────────────────────────────────────');
console.log('  scanned: ' + SCRIPT_FILES.length + ' JS files, ' + STYLE_FILES.length + ' CSS files');
console.log('  ' + Object.keys(refs).length + ' rp-* classes seen; ' + Object.keys(OWNERS).length + ' page prefixes mapped');
console.log('');
if (!leaks.length) {
  console.log('  ✓ no cross-page class leaks');
} else {
  console.log('  ✗ ' + leaks.length + ' classes leaked across ' + totalLeakCount + ' foreign references:');
  leaks.slice(0, 15).forEach(function (L) {
    var total = L.foreign.reduce(function (s, f) { return s + f.count; }, 0);
    console.log('    .' + L.cls.padEnd(28) + ' owner: ' + L.owner.padEnd(36) + ' ' + total + 'x foreign');
  });
  if (leaks.length > 15) console.log('    … ' + (leaks.length - 15) + ' more (see report)');
}
console.log('');
console.log('  report -> ' + path.relative(ROOT, path.join(__dirname, 'audit.html')));

process.exit(leaks.length ? 1 : 0);
