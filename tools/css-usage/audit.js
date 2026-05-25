#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash CSS-usage audit
   ---------------------------------------------------------------------------
   Maps every CSS class and ID across the project to where it's defined
   (which .css file) and where it's used (which .html partial + .js
   module). Em 2026-05-25: "I want a report of all classes and ids in
   the css and the pages where they are used."

   Inputs:
     • frontend/styles/*.css            — every selector parsed
     • frontend/partials/*.html         — class=/id= attributes
     • frontend/scripts (recursive .js)  — class=/id= inside template
                                           strings + querySelector args

   Outputs (next to this script):
     • usage.json  — full mapping payload (script-friendly)
     • usage.html  — sortable + filterable table for browsing
                     (open in a browser; no server needed)

   Three statuses each selector lands in:
     • used     — defined in CSS + referenced in at least one HTML / JS
     • orphan   — defined in CSS, no references anywhere (candidate for
                  removal — but verify state-modifier base classes like
                  .is-active before deleting)
     • undefined— referenced in HTML/JS but never defined in CSS (often
                  intentional: ids JS uses for `getElementById` without
                  CSS targeting; library-provided classes; or a typo bug)

   Usage:  node tools/css-usage/audit.js [projectRoot]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
var FRONTEND   = path.join(ROOT, 'frontend');
var STYLES_DIR = path.join(FRONTEND, 'styles');
var PARTIALS   = path.join(FRONTEND, 'partials');
var SCRIPTS    = path.join(FRONTEND, 'scripts');

// ── walk ────────────────────────────────────────────────────────────────
function walk(dir, ext, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    var p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, ext, out);
    else if (d.isFile() && p.endsWith(ext)) out.push(p);
  });
  return out;
}

var cssFiles  = walk(STYLES_DIR, '.css');
var htmlFiles = walk(PARTIALS,   '.html');
var jsFiles   = walk(SCRIPTS,    '.js');

function rel(p) { return path.relative(ROOT, p); }

// ── CSS extraction ──────────────────────────────────────────────────────
// Strip /* … */ comments first so a commented-out selector doesn't count
// as a definition. Then walk every selector list (the part before `{`)
// and collect class + id tokens. Pseudo-classes / pseudo-elements /
// attribute selectors / combinators are stripped before tokenizing so
// `.foo:hover[data-x] > .bar::before` yields ["foo", "bar"].
//
// `selectors duplicated 2+ places` is the same selector text appearing
// in multiple files — captured here as `defs.length > 1` per name.
var CLASS_DEFS = new Map();   // name → [{ file, line, selector }]
var ID_DEFS    = new Map();
function pushDef(map, name, file, line, selector) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push({ file: rel(file), line: line, selector: selector });
}
cssFiles.forEach(function (file) {
  var src = fs.readFileSync(file, 'utf8');
  // Drop block comments (preserves line numbers via newline retention).
  var stripped = src.replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, '');
  });
  // Walk line-by-line: any line containing `{` may carry one or more
  // selectors before it. Join continuations from prior lines that
  // didn't have `{` (multi-line selector lists).
  var lines = stripped.split('\n');
  var pending = '';
  var pendingLine = 0;
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i];
    if (L.indexOf('{') === -1) {
      // potential continuation: skip pure whitespace, capture selector parts
      if (L.trim() && pending === '') pendingLine = i + 1;
      pending += (pending ? ' ' : '') + L.trim();
      continue;
    }
    // selector list = everything before the `{` (incl. accumulated pending)
    var selectorText = (pending ? pending + ' ' : '') + L.slice(0, L.indexOf('{'));
    var startLine    = pending ? pendingLine : (i + 1);
    pending = ''; pendingLine = 0;

    // Skip at-rules: @media, @keyframes, etc.
    if (/^\s*@/.test(selectorText)) continue;

    // Split on commas (selector list), then extract class + id tokens.
    selectorText.split(',').forEach(function (sel) {
      var s = sel.trim();
      if (!s) return;
      // Drop pseudo-classes / pseudo-elements / attribute selectors
      // before tokenizing — we want the BASE class/id names.
      // Strip url(...) values first so `url(/foo/bar.svg)` doesn't
      // give a spurious `.svg` class match. Then drop pseudo-classes,
      // pseudo-elements, attribute selectors before tokenizing.
      var bare = s
        .replace(/url\([^)]*\)/g, '')
        .replace(/::[\w-]+/g, '')
        .replace(/:[\w-]+(\([^)]*\))?/g, '')
        .replace(/\[[^\]]+\]/g, '');
      var classMatches = bare.match(/\.[A-Za-z_][\w-]*/g) || [];
      var idMatches    = bare.match(/#[A-Za-z_][\w-]*/g) || [];
      classMatches.forEach(function (m) { pushDef(CLASS_DEFS, m.slice(1), file, startLine, s); });
      idMatches   .forEach(function (m) { pushDef(ID_DEFS,    m.slice(1), file, startLine, s); });
    });
  }
});

// ── HTML extraction ─────────────────────────────────────────────────────
// class="foo bar baz" → ["foo","bar","baz"]
// id="qux"            → ["qux"]
// Also handles single-quoted values + DOM-like attribute splitting on
// any whitespace (including   / hard space — unusual but possible).
var CLASS_USES_HTML = new Map();  // name → [{ file, line }]
var ID_USES_HTML    = new Map();
function pushUse(map, name, file, line) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push({ file: rel(file), line: line });
}
function scanAttrUses(text, file, classMap, idMap) {
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i];
    // class="..."   class='...'
    var clsRe = /class\s*=\s*(["'])([^"']*)\1/g;
    var m;
    while ((m = clsRe.exec(L)) !== null) {
      m[2].split(/\s+/).forEach(function (cn) {
        cn = cn.trim();
        if (cn) pushUse(classMap, cn, file, i + 1);
      });
    }
    // id="..."
    var idRe = /\bid\s*=\s*(["'])([^"']+)\1/g;
    while ((m = idRe.exec(L)) !== null) {
      var id = m[2].trim();
      if (id) pushUse(idMap, id, file, i + 1);
    }
  }
}
htmlFiles.forEach(function (file) {
  var src = fs.readFileSync(file, 'utf8');
  scanAttrUses(src, file, CLASS_USES_HTML, ID_USES_HTML);
});

// ── JS extraction ───────────────────────────────────────────────────────
// Two flavors of reference:
//   1. Inline HTML in template strings — `class="foo"` / `id="bar"`
//      (the bulk of our JS-rendered DOM lives this way; the audit's
//      `inline-HTML string concat` declined pattern is exactly this).
//   2. querySelector / querySelectorAll / closest / classList calls —
//      `".foo"`, `"#bar"`, `".foo.bar"` extracted, classList args
//      `add("foo")` / `toggle("bar")` / `remove("baz")`.
//
// Imperfect but high-coverage; tagged as JS use either way.
var CLASS_USES_JS = new Map();
var ID_USES_JS    = new Map();
jsFiles.forEach(function (file) {
  var src = fs.readFileSync(file, 'utf8');
  // (1) attribute-style — same regex as HTML scanner.
  scanAttrUses(src, file, CLASS_USES_JS, ID_USES_JS);
  // (2) selector strings + classList args, line by line.
  var lines = src.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i];
    // querySelector("…") / closest("…") / matches("…") / getElementById("…")
    var selRe = /(?:querySelector(?:All)?|closest|matches)\s*\(\s*(["'`])([^"'`]+)\1/g;
    var m;
    while ((m = selRe.exec(L)) !== null) {
      var sel = m[2];
      (sel.match(/\.[A-Za-z_][\w-]*/g) || []).forEach(function (cn) {
        pushUse(CLASS_USES_JS, cn.slice(1), file, i + 1);
      });
      (sel.match(/#[A-Za-z_][\w-]*/g) || []).forEach(function (id) {
        pushUse(ID_USES_JS, id.slice(1), file, i + 1);
      });
    }
    var byId = /getElementById\s*\(\s*(["'`])([^"'`]+)\1/g;
    while ((m = byId.exec(L)) !== null) {
      pushUse(ID_USES_JS, m[2], file, i + 1);
    }
    // classList.add/remove/toggle/contains("name")
    var clsListRe = /classList\.(?:add|remove|toggle|contains|replace)\s*\(\s*(["'`])([^"'`]+)\1/g;
    while ((m = clsListRe.exec(L)) !== null) {
      pushUse(CLASS_USES_JS, m[2], file, i + 1);
    }
  }
});

// ── second-pass JS scan: literal class names anywhere in source ─────────
// The structured scan above misses inline-HTML string concat — the
// `'<div class="rp-foo' + bar + '">'` pattern (the js-audit "inline-HTML
// string concat" declined pattern, 78 live hits in cases.js etc.). For
// each class defined in CSS, grep the JS source for the literal name as
// a word boundary token; if found, count as a JS use. Conservative:
// a literal that matches a class name is almost always a class ref in
// our codebase (no method or var uses kebab-case dashes).
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
var jsSourceByFile = new Map();
jsFiles.forEach(function (f) { jsSourceByFile.set(f, fs.readFileSync(f, 'utf8')); });
function recordJsUse(name, file) {
  if (!CLASS_USES_JS.has(name)) CLASS_USES_JS.set(name, []);
  if (!CLASS_USES_JS.get(name).some(function (u) { return u.file === rel(file); })) {
    CLASS_USES_JS.get(name).push({ file: file, line: 0 });
  }
}
CLASS_DEFS.forEach(function (_defs, name) {
  // Only kebab-cased names (containing a `-`) are pattern-safe to grep
  // as bareword. Pure-word classes like `chip` could match anything.
  if (!/-/.test(name)) return;
  var re = new RegExp('(["\'`\\s])' + escapeRe(name) + '(?=["\'`\\s])', 'g');
  jsSourceByFile.forEach(function (src, file) {
    if (re.test(src)) recordJsUse(name, file);
    re.lastIndex = 0;
  });
});

// Dynamic-modifier detection: for any class with `--` (BEM modifier
// pattern), check if its base prefix appears in JS as a string
// followed by concat (`'rp-cases-user-avatar--' + size`). When yes,
// the modifier class is dynamically constructed and shouldn't count
// as orphan — JS picks the suffix at runtime.
CLASS_DEFS.forEach(function (_defs, name) {
  var doubleDash = name.lastIndexOf('--');
  if (doubleDash < 0) return;
  var base = name.slice(0, doubleDash + 2);  // include the trailing `--`
  // Look for the base as a quoted string in JS — `"prefix--"` or
  // `'prefix--'` or `` `prefix--` ``. If found, the modifier is
  // dynamic; record a JS use.
  // Allow a quote OR whitespace before the base prefix — covers both
  // `'rp-foo--'+x` (quote-then-base) and `'<div class="rp-foo rp-foo--'+x`
  // (the latter has whitespace inside the string before the prefix).
  var re = new RegExp('["\'`\\s]' + escapeRe(base), 'g');
  jsSourceByFile.forEach(function (src, file) {
    if (re.test(src)) recordJsUse(name, file);
    re.lastIndex = 0;
  });
});

// ── merge into a single payload ─────────────────────────────────────────
function uniqFiles(uses) {
  if (!uses) return [];
  var set = new Map();
  uses.forEach(function (u) {
    if (!set.has(u.file)) set.set(u.file, 0);
    set.set(u.file, set.get(u.file) + 1);
  });
  return Array.from(set.entries())
    .map(function (e) { return { file: e[0], count: e[1] }; })
    .sort(function (a, b) { return a.file.localeCompare(b.file); });
}

// Keep-list for orphan classes (per Em 2026-05-25):
//   • the 8 component atoms — anything starting with `rt-` (workspace
//     redtable family: rt-btn, rt-table, rt-toolbar, rt-nav (rail),
//     rt-pager, rt-panel, rt-chart, plus topbar / surface / search
//     helpers under the same prefix)
//   • state-modifier classes (.is-*, .has-*) — typically combined
//     with other classes via JS .classList.add("is-active"),
//     can read as orphan when the JS uses a class never matched
//   • selectors that include an id (#wsXxx, #home, etc.) —
//     page-bound surfaces stay, page-prefixed (.rp-foo-*) orphans go
function keepDecision(row) {
  if (row.status !== 'orphan') return { keep: true, reason: row.status };
  if (row.kind === 'id')       return { keep: true, reason: 'id (rarely orphan)' };
  // 8-atom family: rt-* prefix
  if (/^rt-/.test(row.name))   return { keep: true, reason: '8-component atom (rt-*)' };
  // state-modifiers
  if (/^(is-|has-)/.test(row.name)) return { keep: true, reason: 'state modifier' };
  // id-scoped: any definition selector includes a `#`
  var idScoped = row.defined_in.some(function (d) {
    return d.selectors && d.selectors.some(function (s) { return s.indexOf('#') >= 0; });
  });
  if (idScoped) return { keep: true, reason: 'id-scoped' };
  return { keep: false, reason: 'orphan, not protected' };
}

function buildRow(name, kind, defs, htmlUses, jsUses) {
  var def     = defs.get(name) || [];
  var inHtml  = htmlUses.get(name) || [];
  var inJs    = jsUses.get(name) || [];
  var used    = inHtml.length + inJs.length > 0;
  var defined = def.length > 0;
  // Group def file→[{line,selector}] so the keep-decision can see
  // the full selector text for the id-scoped check.
  var defByFile = new Map();
  def.forEach(function (d) {
    if (!defByFile.has(d.file)) defByFile.set(d.file, []);
    defByFile.get(d.file).push({ line: d.line, selector: d.selector });
  });
  var defined_in = Array.from(defByFile.entries()).map(function (e) {
    return {
      file: e[0],
      count: e[1].length,
      selectors: e[1].map(function (x) { return x.selector; }),
      lines:     e[1].map(function (x) { return x.line; }),
    };
  }).sort(function (a, b) { return a.file.localeCompare(b.file); });
  var row = {
    name:       name,
    kind:       kind,
    defined_in: defined_in,
    used_html:  uniqFiles(inHtml),
    used_js:    uniqFiles(inJs),
    status:     !defined ? 'undefined'
              : !used    ? 'orphan'
              :           'used',
  };
  var decision = keepDecision(row);
  row.cleanup  = decision.keep ? 'KEEP' : 'CUT';
  row.reason   = decision.reason;
  return row;
}

var allClassNames = new Set([
  ...CLASS_DEFS.keys(),
  ...CLASS_USES_HTML.keys(),
  ...CLASS_USES_JS.keys(),
]);
var allIdNames = new Set([
  ...ID_DEFS.keys(),
  ...ID_USES_HTML.keys(),
  ...ID_USES_JS.keys(),
]);

var classRows = Array.from(allClassNames).sort()
  .map(function (n) { return buildRow(n, 'class', CLASS_DEFS, CLASS_USES_HTML, CLASS_USES_JS); });
var idRows = Array.from(allIdNames).sort()
  .map(function (n) { return buildRow(n, 'id', ID_DEFS, ID_USES_HTML, ID_USES_JS); });

var rows = classRows.concat(idRows);

// ── summary stats ───────────────────────────────────────────────────────
function tally(rows) {
  var t = { total: rows.length, used: 0, orphan: 0, undefined: 0 };
  rows.forEach(function (r) { t[r.status]++; });
  return t;
}
var summary = {
  classes: tally(classRows),
  ids:     tally(idRows),
  files: {
    css:  cssFiles.length,
    html: htmlFiles.length,
    js:   jsFiles.length,
  },
  generated_at: new Date().toISOString(),
};

// ── write JSON + HTML ───────────────────────────────────────────────────
var OUT_DIR  = __dirname;
var JSON_OUT = path.join(OUT_DIR, 'usage.json');
var HTML_OUT = path.join(OUT_DIR, 'usage.html');

fs.writeFileSync(JSON_OUT, JSON.stringify({ summary: summary, rows: rows }, null, 2));

// Render the HTML report. Single self-contained file; embeds the rows
// as JSON in a <script> tag and renders the table client-side so
// filtering + sorting work without a server.
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return c === '&' ? '&amp;'
         : c === '<' ? '&lt;'
         : c === '>' ? '&gt;'
         : c === '"' ? '&quot;' : '&#39;';
  });
}
var html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<title>RedPash · CSS usage audit</title>',
  '<style>',
  '  :root { --bg:#1e1e2e; --surface:#313244; --border:#45475a; --text:#cdd6f4; --mute:#a6adc8; --accent:#89b4fa; --ok:#a6e3a1; --warn:#f9e2af; --err:#f38ba8; }',
  '  body { background:var(--bg); color:var(--text); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; margin:0; padding:1.5rem; }',
  '  h1 { margin:0 0 0.5rem; font-size:1.25rem; }',
  '  .sub { color:var(--mute); margin-bottom:1.5rem; }',
  '  .controls { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-bottom:1rem; }',
  '  input, select { background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:0.375rem 0.625rem; font:inherit; }',
  '  input[type="search"] { min-width:18rem; }',
  '  .chip { display:inline-flex; align-items:center; gap:0.375rem; padding:0.25rem 0.625rem; border-radius:999rem; background:var(--surface); border:1px solid var(--border); font-size:0.75rem; }',
  '  .chip-used    { color:var(--ok);   border-color:var(--ok); }',
  '  .chip-orphan  { color:var(--warn); border-color:var(--warn); }',
  '  .chip-undef   { color:var(--err);  border-color:var(--err); }',
  '  .stats { display:flex; gap:0.75rem; margin-bottom:1rem; flex-wrap:wrap; }',
  '  table { width:100%; border-collapse:collapse; }',
  '  th, td { text-align:left; padding:0.375rem 0.625rem; border-bottom:1px solid var(--border); vertical-align:top; }',
  '  th { position:sticky; top:0; background:var(--bg); color:var(--mute); font-weight:600; font-size:0.7rem; text-transform:uppercase; letter-spacing:0.04em; cursor:pointer; user-select:none; z-index:1; }',
  '  th:hover { color:var(--text); }',
  '  td.name { font-weight:600; color:var(--accent); white-space:nowrap; }',
  '  td.name .kind { color:var(--mute); font-weight:400; margin-right:0.25rem; }',
  '  td.files { font-size:0.7rem; color:var(--mute); }',
  '  td.files a { color:var(--mute); text-decoration:none; }',
  '  td.files a:hover { color:var(--text); }',
  '  td.files .file { display:block; }',
  '  td.files .count { color:var(--accent); margin-left:0.25rem; }',
  '  .status-used     td.status { color:var(--ok); }',
  '  .status-orphan   td.status { color:var(--warn); }',
  '  .status-undefined td.status { color:var(--err); }',
  '</style>',
  '</head><body>',
  '<h1>RedPash · CSS usage audit</h1>',
  '<p class="sub">Every class + id in the project, mapped from CSS definition to HTML / JS usage. Generated ' + escHtml(summary.generated_at) + '.</p>',
  '<div class="stats">',
  '  <span class="chip">' + cssFiles.length + ' CSS files</span>',
  '  <span class="chip">' + htmlFiles.length + ' HTML partials</span>',
  '  <span class="chip">' + jsFiles.length + ' JS files</span>',
  '  <span class="chip chip-used">classes — used ' + summary.classes.used + '</span>',
  '  <span class="chip chip-orphan">orphan ' + summary.classes.orphan + '</span>',
  '  <span class="chip chip-undef">undefined ' + summary.classes.undefined + '</span>',
  '  <span class="chip chip-used">ids — used ' + summary.ids.used + '</span>',
  '  <span class="chip chip-orphan">orphan ' + summary.ids.orphan + '</span>',
  '  <span class="chip chip-undef">undefined ' + summary.ids.undefined + '</span>',
  '</div>',
  '<div class="controls">',
  '  <input type="search" id="q" placeholder="filter by name… (regex ok, e.g. ^rp-cases)" />',
  '  <select id="kind"><option value="">all kinds</option><option value="class">classes</option><option value="id">ids</option></select>',
  '  <select id="status"><option value="">all statuses</option><option value="used">used</option><option value="orphan">orphan</option><option value="undefined">undefined</option></select>',
  '  <span id="count" style="color:var(--mute)"></span>',
  '</div>',
  '<table id="t">',
  '  <thead><tr>',
  '    <th data-sort="name">Name</th>',
  '    <th data-sort="status">Status</th>',
  '    <th>Defined in (CSS)</th>',
  '    <th>Used in (HTML)</th>',
  '    <th>Used in (JS)</th>',
  '  </tr></thead>',
  '  <tbody id="tbody"></tbody>',
  '</table>',
  '<script>',
  'var ROWS = ' + JSON.stringify(rows) + ';',
  'var sort = { key: "name", dir: 1 };',
  'function fileList(arr) {',
  '  if (!arr.length) return "<span style=\\"color:var(--mute)\\">—</span>";',
  '  return arr.map(function (f) {',
  '    return \'<span class="file">\' + f.file + (f.count > 1 ? \' <span class="count">×\' + f.count + \'</span>\' : \'\') + \'</span>\';',
  '  }).join("");',
  '}',
  'function render() {',
  '  var q       = document.getElementById("q").value.trim();',
  '  var kind    = document.getElementById("kind").value;',
  '  var status  = document.getElementById("status").value;',
  '  var re      = null;',
  '  if (q) { try { re = new RegExp(q, "i"); } catch (e) { re = null; } }',
  '  var rows = ROWS.filter(function (r) {',
  '    if (kind   && r.kind   !== kind)   return false;',
  '    if (status && r.status !== status) return false;',
  '    if (re     && !re.test(r.name))    return false;',
  '    return true;',
  '  }).sort(function (a, b) {',
  '    var av = a[sort.key], bv = b[sort.key];',
  '    if (av < bv) return -sort.dir;',
  '    if (av > bv) return  sort.dir;',
  '    return 0;',
  '  });',
  '  document.getElementById("count").textContent = rows.length + " row" + (rows.length === 1 ? "" : "s");',
  '  document.getElementById("tbody").innerHTML = rows.map(function (r) {',
  '    return \'<tr class="status-\' + r.status + \'">\'',
  '      + \'<td class="name"><span class="kind">\' + (r.kind === "id" ? "#" : ".") + \'</span>\' + r.name + \'</td>\'',
  '      + \'<td class="status">\' + r.status + \'</td>\'',
  '      + \'<td class="files">\' + fileList(r.defined_in) + \'</td>\'',
  '      + \'<td class="files">\' + fileList(r.used_html)  + \'</td>\'',
  '      + \'<td class="files">\' + fileList(r.used_js)    + \'</td>\'',
  '      + \'</tr>\';',
  '  }).join("");',
  '}',
  'document.querySelectorAll("th[data-sort]").forEach(function (th) {',
  '  th.addEventListener("click", function () {',
  '    var k = th.dataset.sort;',
  '    if (sort.key === k) sort.dir = -sort.dir; else { sort.key = k; sort.dir = 1; }',
  '    render();',
  '  });',
  '});',
  '["q","kind","status"].forEach(function (id) { document.getElementById(id).addEventListener("input", render); });',
  'render();',
  '</script>',
  '</body></html>',
].join('\n');

fs.writeFileSync(HTML_OUT, html);

// ── cleanup audit ───────────────────────────────────────────────────────
// Cuts only target ORPHAN classes that aren't protected by the keep-list
// (8-component prefix, state modifier, or id-scoped selector). Each cut
// row is grouped by its source file so we can preview the deletion scope
// per sheet.
var cuts = rows.filter(function (r) { return r.cleanup === 'CUT'; });
var cutsByFile = new Map();
cuts.forEach(function (r) {
  r.defined_in.forEach(function (d) {
    if (!cutsByFile.has(d.file)) cutsByFile.set(d.file, []);
    d.selectors.forEach(function (sel, i) {
      cutsByFile.get(d.file).push({ name: r.name, selector: sel, line: d.lines[i] });
    });
  });
});

// ── stdout summary ──────────────────────────────────────────────────────
console.log('RedPash CSS-usage audit');
console.log('');
console.log('  scanned ' + cssFiles.length + ' CSS, ' + htmlFiles.length + ' HTML, ' + jsFiles.length + ' JS');
console.log('');
console.log('  classes total      ' + summary.classes.total);
console.log('    used             ' + summary.classes.used);
console.log('    orphan           ' + summary.classes.orphan + '   (defined, never referenced)');
console.log('    undefined        ' + summary.classes.undefined + '   (referenced, never defined)');
console.log('');
console.log('  ids total          ' + summary.ids.total);
console.log('    used             ' + summary.ids.used);
console.log('    orphan           ' + summary.ids.orphan);
console.log('    undefined        ' + summary.ids.undefined);
console.log('');
console.log('');
console.log('  cleanup proposal (orphans not protected by keep-list):');
console.log('    cut classes      ' + cuts.length);
console.log('    by sheet:');
Array.from(cutsByFile.entries())
  .sort(function (a, b) { return b[1].length - a[1].length; })
  .forEach(function (e) {
    console.log('      ' + (e[0] + ':').padEnd(36) + e[1].length + ' selector' + (e[1].length === 1 ? '' : 's'));
  });
console.log('');
console.log('  report -> ' + path.relative(ROOT, HTML_OUT));
console.log('  payload -> ' + path.relative(ROOT, JSON_OUT));
