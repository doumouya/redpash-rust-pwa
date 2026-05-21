#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash CSS conflict audit
   ---------------------------------------------------------------------------
   Parses every .css file under a styles dir and produces an interactive HTML
   datatable to spot competing rules that style identical classes differently.

   Two views:
     1. Selector conflicts — the SAME selector (+ same @media/@supports context)
        declared in 2+ places, with per-property value diffs.
     2. Class index       — every class name, every file/selector that targets
        it, plus property-level divergence across all of them.

   No cascade resolution: flat cross-file listing. Specificity, !important,
   load-group and source order are shown as columns so you judge the winner.

   Usage:  node audit.js [stylesDir]
   Output: ./report.html  (next to this script)
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var STYLES_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : '/home/mansa/redpash-app/frontend/styles';
var OUT = path.join(__dirname, 'report.html');

/* Component sheets @import-ed by main.css — these load globally for every
   page, unlike the other components/ sheets which are pulled per-page. */
var GLOBAL_COMPONENTS = [
  'glass-btn.css', 'modals-sandbox.css', 'buttons.css', 'topbar.css',
  'toast.css', 'modal.css', 'filters.css', 'forms.css'
];

/* ── file discovery ──────────────────────────────────────────────────────── */
function walk(dir, acc) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && /\.css$/i.test(e.name)) acc.push(full);
  });
  return acc;
}

function groupOf(rel) {
  if (rel.indexOf('base/') === 0 || rel === 'main.css' && false) return 'base';
  if (rel === 'main.css') return 'main';
  if (rel.indexOf('base/') === 0) return 'base';
  if (rel.indexOf('pages/') === 0) return 'page';
  if (rel.indexOf('components/') === 0) {
    var base = rel.split('/').pop();
    if (GLOBAL_COMPONENTS.indexOf(base) !== -1) return 'component-global';
    return 'component';
  }
  return 'other';
}

/* ── CSS tokenizer ───────────────────────────────────────────────────────── */
function parseInto(rules, text, file) {
  // Strip comments but keep newlines so line numbers stay accurate.
  text = text.replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ');
  });

  var lineStarts = [0];
  for (var k = 0; k < text.length; k++) {
    if (text[k] === '\n') lineStarts.push(k + 1);
  }
  function lineOf(idx) {
    var lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  var i = 0;
  var order = { n: 0 };

  function skipString(quote) {
    i++; // past opening quote
    while (i < text.length) {
      var c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { i++; return; }
      i++;
    }
  }
  function skipWs() {
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  // Reads until a top-level '{', ';' or '}' — respecting strings + paren depth
  // (so ';' inside a data: URI or value function isn't a false terminator).
  function readUntil() {
    var buf = '', depth = 0;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '"' || ch === "'") {
        var s = i; skipString(ch); buf += text.slice(s, i); continue;
      }
      if (ch === '(') { depth++; buf += ch; i++; continue; }
      if (ch === ')') { if (depth > 0) depth--; buf += ch; i++; continue; }
      if (depth === 0 && (ch === '{' || ch === ';' || ch === '}')) break;
      buf += ch; i++;
    }
    return buf;
  }

  function joinCtx(ctx, atSel) {
    var clean = atSel.replace(/\s+/g, ' ').trim();
    return ctx ? ctx + ' › ' + clean : clean;
  }

  function parseDecls(atContext) {
    var decls = [];
    while (i < text.length) {
      skipWs();
      if (i >= text.length || text[i] === '}') break;
      var start = i;
      var buf = readUntil();
      var term = text[i];
      if (term === '{') {
        // native CSS nesting — record nested rule, best-effort
        i++;
        var nested = parseDecls(atContext);
        if (text[i] === '}') i++;
        splitSelectors(buf.trim()).forEach(function (s) {
          s = s.trim();
          if (s) rules.push(makeRule(file, lineOf(start), atContext, s, buf.trim(), nested, order));
        });
        continue;
      }
      if (term === ';') i++;
      var dt = buf.trim();
      if (dt) {
        var ci = dt.indexOf(':');
        if (ci > 0) {
          var prop = dt.slice(0, ci).trim().toLowerCase();
          var value = dt.slice(ci + 1).trim();
          if (prop && value) {
            decls.push({
              prop: prop,
              value: value,
              important: /!\s*important/i.test(value),
              line: lineOf(start)
            });
          }
        }
      }
      if (term === '}') break;
    }
    return decls;
  }

  function parseNodeList(atContext) {
    while (i < text.length) {
      skipWs();
      if (i >= text.length || text[i] === '}') return;
      var start = i;
      var prelude = readUntil();
      if (i >= text.length) return;
      var term = text[i];
      if (term === ';') { i++; continue; }   // at-statement: @import / @charset
      if (term === '}') return;              // stray close
      i++;                                   // consume '{'
      var sel = prelude.trim();
      var line = lineOf(start);

      if (sel.charAt(0) === '@') {
        var low = sel.toLowerCase();
        // conditional groups contain nested rules; others (keyframes,
        // font-face, page, property) contain decls or % blocks — recurse
        // generically, their non-class selectors get filtered out later.
        parseNodeList(/^@(media|supports|layer|container|scope|document|-moz-document)\b/.test(low)
          ? joinCtx(atContext, sel)
          : atContext);
        skipWs();
        if (text[i] === '}') i++;
        continue;
      }

      var decls = parseDecls(atContext);
      if (text[i] === '}') i++;
      splitSelectors(sel).forEach(function (s) {
        s = s.trim();
        if (s) rules.push(makeRule(file, line, atContext, s, sel, decls, order));
      });
    }
  }

  parseNodeList('');
}

function makeRule(file, line, atContext, selector, selectorList, decls, order) {
  return {
    file: file,
    line: line,
    atContext: atContext,
    selector: normalizeSelector(selector),
    selectorRaw: selector,
    selectorList: selectorList.replace(/\s+/g, ' ').trim(),
    decls: decls,
    order: order.n++
  };
}

/* Split a selector list on top-level commas (not commas inside :not(), [], strings). */
function splitSelectors(list) {
  var out = [], buf = '', depth = 0, bracket = 0, inStr = '';
  for (var j = 0; j < list.length; j++) {
    var c = list[j];
    if (inStr) { buf += c; if (c === inStr) inStr = ''; continue; }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === '(') depth++;
    if (c === ')' && depth > 0) depth--;
    if (c === '[') bracket++;
    if (c === ']' && bracket > 0) bracket--;
    if (c === ',' && depth === 0 && bracket === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function normalizeSelector(s) {
  return s.replace(/\s*([>+~])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim();
}

/* Approximate specificity [a,b,c]. Good enough for an informational column. */
function specificity(sel) {
  var a = 0, b = 0, c = 0;
  var s = ' ' + sel + ' ';
  s = s.replace(/\[[^\]]*\]/g, function () { b++; return ' '; });          // attrs
  s = s.replace(/#[-_a-zA-Z0-9\\]+/g, function () { a++; return ' '; });    // ids
  s = s.replace(/\.[-_a-zA-Z0-9\\]+/g, function () { b++; return ' '; });   // classes
  s = s.replace(/::[-a-zA-Z]+/g, function () { c++; return ' '; });         // pseudo-elements
  s = s.replace(/:where\([^)]*\)/g, ' ');                                   // :where -> 0
  s = s.replace(/:[-a-zA-Z]+(\([^)]*\))?/g, function () { b++; return ' '; }); // pseudo-classes
  s = s.replace(/[a-zA-Z][-_a-zA-Z0-9]*/g, function () { c++; return ' '; });  // elements
  return [a, b, c];
}
function specCmp(x, y) {
  for (var d = 0; d < 3; d++) { if (x[d] !== y[d]) return x[d] - y[d]; }
  return 0;
}

/* normalize a declaration value for equality comparison */
function normVal(v) {
  return v.toLowerCase().replace(/\s*!\s*important/i, '').replace(/\s+/g, ' ').trim();
}

/* extract class tokens from a normalized selector */
function classesIn(sel) {
  var out = [], m;
  var re = /\.(-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*)/g;
  while ((m = re.exec(sel))) out.push(m[1]);
  return out;
}

/* ── run ─────────────────────────────────────────────────────────────────── */
console.log('Scanning ' + STYLES_DIR + ' …');
var files = walk(STYLES_DIR, []).sort();
if (!files.length) { console.error('No .css files found.'); process.exit(1); }

var rules = [];
var fileMeta = [];
files.forEach(function (full) {
  var rel = path.relative(STYLES_DIR, full).split(path.sep).join('/');
  var text = fs.readFileSync(full, 'utf8');
  var before = rules.length;
  parseInto(rules, text, rel);
  fileMeta.push({
    path: rel,
    group: groupOf(rel),
    lines: text.split('\n').length,
    rules: rules.length - before
  });
});

/* attach group + specificity to every rule */
var groupByFile = {};
fileMeta.forEach(function (f) { groupByFile[f.path] = f.group; });
rules.forEach(function (r) {
  r.group = groupByFile[r.file];
  r.spec = specificity(r.selector);
});

/* skip non-class structural selectors for the class index (keyframe % / from / to) */
function isKeyframeStep(sel) {
  return /^(from|to|\d+%)$/.test(sel.trim());
}

/* ── view 1: selector conflicts ──────────────────────────────────────────── */
var bySelector = {};
rules.forEach(function (r) {
  if (isKeyframeStep(r.selector)) return;
  var key = (r.atContext || '') + ' ||| ' + r.selector;
  (bySelector[key] || (bySelector[key] = [])).push(r);
});

var selectorConflicts = [];
Object.keys(bySelector).forEach(function (key) {
  var insts = bySelector[key];
  if (insts.length < 2) return; // declared once — nothing competes
  var sample = insts[0];

  // gather per-property value entries across all instances
  var propMap = {};
  insts.forEach(function (r) {
    r.decls.forEach(function (d) {
      (propMap[d.prop] || (propMap[d.prop] = [])).push({
        value: d.value,
        norm: normVal(d.value),
        important: d.important,
        file: r.file,
        line: d.line,
        group: r.group
      });
    });
  });

  var props = Object.keys(propMap).sort().map(function (p) {
    var entries = propMap[p];
    var distinct = {};
    entries.forEach(function (e) { distinct[e.norm + (e.important ? ' !' : '')] = 1; });
    var nDistinct = Object.keys(distinct).length;
    return {
      prop: p,
      entries: entries,
      conflicting: nDistinct >= 2,
      duplicate: nDistinct === 1 && entries.length >= 2
    };
  });

  var fileSet = {};
  insts.forEach(function (r) { fileSet[r.file] = 1; });

  selectorConflicts.push({
    selector: sample.selector,
    atContext: sample.atContext || '',
    instances: insts.map(function (r) {
      return {
        file: r.file, line: r.line, group: r.group,
        decls: r.decls.length, order: r.order,
        spec: r.spec.join('/'),
        selectorList: r.selectorList
      };
    }).sort(function (x, y) { return x.order - y.order; }),
    props: props,
    fileCount: Object.keys(fileSet).length,
    instanceCount: insts.length,
    conflictCount: props.filter(function (p) { return p.conflicting; }).length,
    duplicateCount: props.filter(function (p) { return p.duplicate; }).length,
    sameFileDup: insts.length > Object.keys(fileSet).length
  });
});
selectorConflicts.sort(function (a, b) {
  return (b.conflictCount - a.conflictCount)
      || (b.duplicateCount - a.duplicateCount)
      || (b.fileCount - a.fileCount)
      || a.selector.localeCompare(b.selector);
});

/* ── view 2: class index ─────────────────────────────────────────────────── */
var byClass = {};
rules.forEach(function (r) {
  if (isKeyframeStep(r.selector)) return;
  var seen = {};
  classesIn(r.selector).forEach(function (cls) {
    if (seen[cls]) return;
    seen[cls] = 1;
    (byClass[cls] || (byClass[cls] = [])).push(r);
  });
});

var classIndex = Object.keys(byClass).sort().map(function (cls) {
  var rs = byClass[cls];
  var fileCounts = {};
  rs.forEach(function (r) { fileCounts[r.file] = (fileCounts[r.file] || 0) + 1; });

  // property divergence: same property set to >=2 distinct values across ALL
  // rules that target this class, regardless of the rest of the selector.
  var propMap = {};
  rs.forEach(function (r) {
    r.decls.forEach(function (d) {
      (propMap[d.prop] || (propMap[d.prop] = [])).push({
        value: d.value, norm: normVal(d.value), important: d.important,
        file: r.file, line: d.line, selector: r.selector, atContext: r.atContext || ''
      });
    });
  });
  var divergent = [];
  Object.keys(propMap).sort().forEach(function (p) {
    var entries = propMap[p];
    var distinct = {};
    entries.forEach(function (e) { distinct[e.norm] = 1; });
    if (Object.keys(distinct).length >= 2) divergent.push({ prop: p, entries: entries });
  });

  return {
    cls: cls,
    fileCount: Object.keys(fileCounts).length,
    ruleCount: rs.length,
    selectorCount: (function () {
      var s = {}; rs.forEach(function (r) { s[r.atContext + '|' + r.selector] = 1; });
      return Object.keys(s).length;
    })(),
    files: Object.keys(fileCounts).sort().map(function (f) {
      return { file: f, count: fileCounts[f], group: groupByFile[f] };
    }),
    selectors: (function () {
      var seen = {}, out = [];
      rs.forEach(function (r) {
        var k = r.atContext + '|' + r.selector + '|' + r.file;
        if (seen[k]) return;
        seen[k] = 1;
        out.push({
          selector: r.selector, file: r.file, line: r.line,
          atContext: r.atContext || '', group: r.group,
          spec: r.spec.join('/'), decls: r.decls.length
        });
      });
      return out.sort(function (x, y) {
        return x.selector.localeCompare(y.selector) || x.file.localeCompare(y.file);
      });
    })(),
    divergent: divergent,
    divergentCount: divergent.length
  };
});
classIndex.sort(function (a, b) {
  return (b.divergentCount - a.divergentCount)
      || (b.fileCount - a.fileCount)
      || (b.ruleCount - a.ruleCount)
      || a.cls.localeCompare(b.cls);
});

/* ── stats ───────────────────────────────────────────────────────────────── */
var data = {
  generatedAt: new Date().toISOString(),
  stylesDir: STYLES_DIR,
  files: fileMeta,
  stats: {
    files: fileMeta.length,
    rules: rules.length,
    declarations: rules.reduce(function (n, r) { return n + r.decls.length; }, 0),
    classes: classIndex.length,
    multiFileClasses: classIndex.filter(function (c) { return c.fileCount >= 2; }).length,
    conflictSelectors: selectorConflicts.filter(function (s) { return s.conflictCount > 0; }).length,
    dupSelectors: selectorConflicts.length,
    conflictProps: selectorConflicts.reduce(function (n, s) { return n + s.conflictCount; }, 0),
    divergentClasses: classIndex.filter(function (c) { return c.divergentCount > 0; }).length
  },
  selectorConflicts: selectorConflicts,
  classIndex: classIndex
};

/* ── HTML report ─────────────────────────────────────────────────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
'<!doctype html>',
'<html lang="en"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>RedPash CSS conflict audit</title>',
'<style>' + CSS + '</style>',
'</head><body>',
'<header>',
'  <h1>CSS conflict audit <span class="muted">· redpash-app</span></h1>',
'  <div class="sub" id="sub"></div>',
'</header>',
'<section class="cards" id="cards"></section>',
'<nav class="tabs">',
'  <button class="tab active" data-tab="sel">Selector conflicts</button>',
'  <button class="tab" data-tab="cls">Class index</button>',
'</nav>',
'<div class="panel" id="panel-sel">',
'  <div class="toolbar">',
'    <input id="q-sel" placeholder="Filter selectors…" autocomplete="off">',
'    <label class="chk"><input type="checkbox" id="only-conflict" checked> only value conflicts</label>',
'    <span class="count" id="count-sel"></span>',
'  </div>',
'  <table id="t-sel"><thead><tr>',
'    <th data-k="selector">Selector</th>',
'    <th data-k="conflictCount" class="num">⚠ Conflicts</th>',
'    <th data-k="duplicateCount" class="num">⧉ Dupes</th>',
'    <th data-k="fileCount" class="num">Files</th>',
'    <th data-k="instanceCount" class="num">Rules</th>',
'  </tr></thead><tbody></tbody></table>',
'</div>',
'<div class="panel hidden" id="panel-cls">',
'  <div class="toolbar">',
'    <input id="q-cls" placeholder="Filter class names…" autocomplete="off">',
'    <label class="chk"><input type="checkbox" id="only-multi"> only 2+ files</label>',
'    <label class="chk"><input type="checkbox" id="only-div"> only property divergence</label>',
'    <span class="count" id="count-cls"></span>',
'  </div>',
'  <table id="t-cls"><thead><tr>',
'    <th data-k="cls">Class</th>',
'    <th data-k="divergentCount" class="num">⚠ Divergent props</th>',
'    <th data-k="fileCount" class="num">Files</th>',
'    <th data-k="ruleCount" class="num">Rules</th>',
'    <th data-k="selectorCount" class="num">Selectors</th>',
'  </tr></thead><tbody></tbody></table>',
'</div>',
'<script>var DATA=' + json + ';</script>',
'<script>' + JS + '</script>',
'</body></html>'
  ].join('\n');
}

/* ── report stylesheet ───────────────────────────────────────────────────── */
var CSS = `
:root{
  --bg:#0d1117; --panel:#11161f; --panel2:#161c28; --line:#222b3a;
  --text:#d6dbe5; --muted:#7c8699; --accent:#b3001b; --accent2:#5b8cff;
  --bad:#ff5d6c; --warn:#e0a64b; --ok:#3fb56b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
header{padding:22px 26px 14px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.muted{color:var(--muted);font-weight:400}
.sub{margin-top:4px;color:var(--muted);font-size:12px}
.cards{display:flex;flex-wrap:wrap;gap:10px;padding:16px 26px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:10px 14px;min-width:118px}
.card .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.card .l{font-size:11px;color:var(--muted);margin-top:2px}
.card.bad .n{color:var(--bad)} .card.warn .n{color:var(--warn)}
.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--line)}
.tab{background:none;border:0;color:var(--muted);padding:10px 14px;cursor:pointer;
  font-size:13px;border-bottom:2px solid transparent}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.panel{padding:14px 26px 80px}
.panel.hidden{display:none}
.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:10px;flex-wrap:wrap}
.toolbar input[type=text],#q-sel,#q-cls{background:var(--panel2);
  border:1px solid var(--line);color:var(--text);border-radius:8px;
  padding:7px 11px;width:300px;font-size:13px}
.chk{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:5px;
  cursor:pointer;user-select:none}
.count{color:var(--muted);font-size:12px;margin-left:auto}
table{width:100%;border-collapse:collapse}
thead th{position:sticky;top:0;background:var(--panel);text-align:left;z-index:2;
  font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  padding:9px 10px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;
  white-space:nowrap}
th.num{text-align:right}
th.sorted{color:var(--text)}
th.sorted::after{content:" ▾";color:var(--accent2)}
th.sorted.asc::after{content:" ▴"}
tbody tr.row{border-bottom:1px solid var(--line);cursor:pointer}
tbody tr.row:hover{background:var(--panel)}
tbody td{padding:7px 10px;vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.sel{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;
  color:#e6ebf2;word-break:break-all}
.ctx{color:var(--muted);font-size:11px;
  font-family:ui-monospace,Menlo,Consolas,monospace}
.pill{display:inline-block;padding:1px 6px;border-radius:6px;font-size:10px;
  font-weight:600;vertical-align:middle}
.pill.bad{background:rgba(255,93,108,.15);color:var(--bad)}
.pill.warn{background:rgba(224,166,75,.16);color:var(--warn)}
.pill.zero{background:none;color:var(--muted);font-weight:400}
.g{display:inline-block;padding:1px 5px;border-radius:5px;font-size:10px;
  font-weight:600}
.g-base{background:#16271a;color:#8fd19e}
.g-main{background:#271a27;color:#d99ed1}
.g-component-global{background:#172033;color:#9ab4ff}
.g-component{background:#1d2433;color:#9aa8c0}
.g-page{background:#2e2517;color:#e0bd8a}
.g-other{background:#222b3a;color:#9aa8c0}
.detail td{background:var(--panel2);padding:14px 18px}
.dsec{margin-bottom:14px}
.dsec:last-child{margin-bottom:0}
.dh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;
  color:var(--muted);margin-bottom:6px}
.lrow{font-size:12px;padding:2px 0;display:flex;gap:7px;flex-wrap:wrap;
  align-items:baseline}
.props{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:8px}
.prop{background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:8px 10px}
.prop.pconflict{border-left:3px solid var(--bad)}
.prop.pdup{border-left:3px solid var(--warn)}
.pname{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;
  font-weight:600;margin-bottom:5px;color:#e6ebf2}
.ent{font-size:12px;padding:2px 0;border-top:1px dotted var(--line)}
.ent:first-of-type{border-top:0}
.pv{font-family:ui-monospace,Menlo,Consolas,monospace;color:#cbd3e1}
a{color:var(--accent2);text-decoration:none}
.empty{padding:40px;text-align:center;color:var(--muted)}
`;

/* ── report client script (browser; no template literals / no \${) ───────── */
var JS = [
"(function(){",
"'use strict';",
"var D=DATA;",
"function esc(s){return String(s).replace(/[&<>\\\"]/g,function(c){",
"  return({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;'})[c];});}",
"function g(grp){return '<span class=\\\"g g-'+grp+'\\\">'+grp+'</span>';}",
"function pill(n,kind){return n?'<span class=\\\"pill '+kind+'\\\">'+n+'</span>'",
"  :'<span class=\\\"pill zero\\\">0</span>';}",
"",
"document.getElementById('sub').textContent=",
"  D.stylesDir+'  —  generated '+new Date(D.generatedAt).toLocaleString();",
"var cards=[['Files',D.stats.files,''],['Rules',D.stats.rules,''],",
"  ['Declarations',D.stats.declarations,''],",
"  ['Conflict selectors',D.stats.conflictSelectors,'bad'],",
"  ['Conflicting props',D.stats.conflictProps,'bad'],",
"  ['Duplicated selectors',D.stats.dupSelectors,'warn'],",
"  ['Classes',D.stats.classes,''],",
"  ['Classes in 2+ files',D.stats.multiFileClasses,'warn'],",
"  ['Classes w/ divergence',D.stats.divergentClasses,'bad']];",
"document.getElementById('cards').innerHTML=cards.map(function(c){",
"  return '<div class=\\\"card '+c[2]+'\\\"><div class=\\\"n\\\">'+c[1]+",
"    '</div><div class=\\\"l\\\">'+c[0]+'</div></div>';}).join('');",
"",
"var tabs=document.querySelectorAll('.tab');",
"for(var ti=0;ti<tabs.length;ti++){tabs[ti].addEventListener('click',function(){",
"  for(var j=0;j<tabs.length;j++)tabs[j].classList.remove('active');",
"  this.classList.add('active');var t=this.getAttribute('data-tab');",
"  document.getElementById('panel-sel').classList.toggle('hidden',t!=='sel');",
"  document.getElementById('panel-cls').classList.toggle('hidden',t!=='cls');});}",
"",
"function sortRows(rows,st){rows.sort(function(a,b){var k=st.k,d;",
"  if(typeof a[k]==='string')d=a[k].localeCompare(b[k]);else d=a[k]-b[k];",
"  return st.asc?d:-d;});return rows;}",
"function wireSort(tableId,st,rerender){",
"  var ths=document.querySelectorAll('#'+tableId+' thead th');",
"  function paint(){for(var i=0;i<ths.length;i++){ths[i].classList.remove('sorted','asc');",
"    if(ths[i].getAttribute('data-k')===st.k){ths[i].classList.add('sorted');",
"      if(st.asc)ths[i].classList.add('asc');}}}",
"  for(var i=0;i<ths.length;i++){(function(th){th.addEventListener('click',function(){",
"    var k=th.getAttribute('data-k');",
"    if(st.k===k)st.asc=!st.asc;else{st.k=k;st.asc=(k==='selector'||k==='cls');}",
"    paint();rerender();});})(ths[i]);}",
"  paint();}",
"function expandable(tr,det){tr.addEventListener('click',function(){",
"  det.style.display=det.style.display==='none'?'':'none';});}",
"",
"/* selector conflicts */",
"var selSort={k:'conflictCount',asc:false};",
"function selDetail(r){",
"  var rules=r.instances.map(function(i){",
"    var sl=(i.selectorList&&i.selectorList!==r.selector)?",
"      ' <span class=\\\"ctx\\\">list: '+esc(i.selectorList)+'</span>':'';",
"    return '<div class=\\\"lrow\\\">'+g(i.group)+'<span class=\\\"ctx\\\">'+",
"      esc(i.file)+':'+i.line+'</span><span class=\\\"ctx\\\">spec '+i.spec+",
"      ' · '+i.decls+' decls</span>'+sl+'</div>';}).join('');",
"  var props=r.props.map(function(p){",
"    var cls=p.conflicting?'pconflict':(p.duplicate?'pdup':'');",
"    var tag=p.conflicting?' <span class=\\\"pill bad\\\">conflict</span>':",
"      (p.duplicate?' <span class=\\\"pill warn\\\">dup</span>':'');",
"    var ent=p.entries.map(function(e){",
"      return '<div class=\\\"ent\\\"><span class=\\\"pv\\\">'+esc(e.value)+'</span>'+",
"        (e.important?' <span class=\\\"pill bad\\\">!</span>':'')+",
"        ' <span class=\\\"ctx\\\">'+esc(e.file)+':'+e.line+'</span></div>';}).join('');",
"    return '<div class=\\\"prop '+cls+'\\\"><div class=\\\"pname\\\">'+esc(p.prop)+",
"      tag+'</div>'+ent+'</div>';}).join('');",
"  return '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">Declared in '+",
"    r.instances.length+' rules</div>'+rules+'</div>'+",
"    '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">Properties ('+r.props.length+",
"    ')</div><div class=\\\"props\\\">'+props+'</div></div>';}",
"function renderSel(){",
"  var q=document.getElementById('q-sel').value.toLowerCase().trim();",
"  var onlyC=document.getElementById('only-conflict').checked;",
"  var rows=D.selectorConflicts.filter(function(r){",
"    if(onlyC&&r.conflictCount===0)return false;",
"    if(q&&(r.selector+' '+r.atContext).toLowerCase().indexOf(q)<0)return false;",
"    return true;});",
"  sortRows(rows,selSort);",
"  document.getElementById('count-sel').textContent=rows.length+' of '+",
"    D.selectorConflicts.length+' shown';",
"  var tb=document.querySelector('#t-sel tbody');tb.innerHTML='';",
"  if(!rows.length){tb.innerHTML='<tr><td colspan=5 class=empty>No matches.</td></tr>';return;}",
"  rows.forEach(function(r){",
"    var tr=document.createElement('tr');tr.className='row';",
"    var dup=r.sameFileDup?' <span class=\\\"pill warn\\\">same-file dup</span>':'';",
"    tr.innerHTML='<td><span class=\\\"sel\\\">'+esc(r.selector)+'</span>'+dup+",
"      (r.atContext?'<div class=\\\"ctx\\\">'+esc(r.atContext)+'</div>':'')+'</td>'+",
"      '<td class=num>'+pill(r.conflictCount,'bad')+'</td>'+",
"      '<td class=num>'+pill(r.duplicateCount,'warn')+'</td>'+",
"      '<td class=num>'+r.fileCount+'</td>'+",
"      '<td class=num>'+r.instanceCount+'</td>';",
"    var det=document.createElement('tr');det.className='detail';",
"    det.style.display='none';",
"    det.innerHTML='<td colspan=5>'+selDetail(r)+'</td>';",
"    expandable(tr,det);tb.appendChild(tr);tb.appendChild(det);});}",
"",
"/* class index */",
"var clsSort={k:'divergentCount',asc:false};",
"function clsDetail(r){",
"  var files=r.files.map(function(f){",
"    return '<div class=\\\"lrow\\\">'+g(f.group)+'<span>'+esc(f.file)+'</span>'+",
"      '<span class=\\\"ctx\\\">'+f.count+' rule'+(f.count>1?'s':'')+'</span></div>';",
"  }).join('');",
"  var sels=r.selectors.map(function(s){",
"    return '<div class=\\\"lrow\\\">'+g(s.group)+'<span class=\\\"sel\\\">'+",
"      esc(s.selector)+'</span>'+(s.atContext?'<span class=\\\"ctx\\\">@ '+",
"      esc(s.atContext)+'</span>':'')+'<span class=\\\"ctx\\\">'+esc(s.file)+':'+",
"      s.line+' · spec '+s.spec+'</span></div>';}).join('');",
"  var div=r.divergent.length?r.divergent.map(function(p){",
"    var ent=p.entries.map(function(e){",
"      return '<div class=\\\"ent\\\"><span class=\\\"pv\\\">'+esc(e.value)+'</span>'+",
"        (e.important?' <span class=\\\"pill bad\\\">!</span>':'')+",
"        ' <span class=\\\"ctx\\\">'+esc(e.selector)+' — '+esc(e.file)+':'+e.line+",
"        '</span></div>';}).join('');",
"    return '<div class=\\\"prop pconflict\\\"><div class=\\\"pname\\\">'+",
"      esc(p.prop)+'</div>'+ent+'</div>';}).join(''):",
"    '<div class=\\\"ctx\\\">No single property is set to conflicting values "
+ "across these rules.</div>';",
"  return '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">'+r.fileCount+",
"    ' files</div>'+files+'</div>'+",
"    '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">'+r.selectorCount+",
"    ' distinct selectors</div>'+sels+'</div>'+",
"    '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">Property divergence ('+",
"    r.divergentCount+')</div><div class=\\\"props\\\">'+div+'</div></div>';}",
"function renderCls(){",
"  var q=document.getElementById('q-cls').value.toLowerCase().trim();",
"  var onlyM=document.getElementById('only-multi').checked;",
"  var onlyD=document.getElementById('only-div').checked;",
"  var rows=D.classIndex.filter(function(r){",
"    if(onlyM&&r.fileCount<2)return false;",
"    if(onlyD&&r.divergentCount===0)return false;",
"    if(q&&r.cls.toLowerCase().indexOf(q)<0)return false;",
"    return true;});",
"  sortRows(rows,clsSort);",
"  document.getElementById('count-cls').textContent=rows.length+' of '+",
"    D.classIndex.length+' shown';",
"  var tb=document.querySelector('#t-cls tbody');tb.innerHTML='';",
"  if(!rows.length){tb.innerHTML='<tr><td colspan=5 class=empty>No matches.</td></tr>';return;}",
"  rows.forEach(function(r){",
"    var tr=document.createElement('tr');tr.className='row';",
"    tr.innerHTML='<td><span class=\\\"sel\\\">.'+esc(r.cls)+'</span></td>'+",
"      '<td class=num>'+pill(r.divergentCount,'bad')+'</td>'+",
"      '<td class=num>'+r.fileCount+'</td>'+",
"      '<td class=num>'+r.ruleCount+'</td>'+",
"      '<td class=num>'+r.selectorCount+'</td>';",
"    var det=document.createElement('tr');det.className='detail';",
"    det.style.display='none';",
"    det.innerHTML='<td colspan=5>'+clsDetail(r)+'</td>';",
"    expandable(tr,det);tb.appendChild(tr);tb.appendChild(det);});}",
"",
"document.getElementById('q-sel').addEventListener('input',renderSel);",
"document.getElementById('only-conflict').addEventListener('change',renderSel);",
"document.getElementById('q-cls').addEventListener('input',renderCls);",
"document.getElementById('only-multi').addEventListener('change',renderCls);",
"document.getElementById('only-div').addEventListener('change',renderCls);",
"wireSort('t-sel',selSort,renderSel);",
"wireSort('t-cls',clsSort,renderCls);",
"renderSel();renderCls();",
"})();"
].join("\n");

/* ── emit ────────────────────────────────────────────────────────────────── */
fs.writeFileSync(OUT, renderHtml(data), 'utf8');

console.log('');
console.log('  files scanned         ' + data.stats.files);
console.log('  rules parsed          ' + data.stats.rules);
console.log('  selectors w/ value conflicts   ' + data.stats.conflictSelectors
  + '  (' + data.stats.conflictProps + ' conflicting properties)');
console.log('  selectors duplicated 2+ places ' + data.stats.dupSelectors);
console.log('  classes total         ' + data.stats.classes
  + '  (' + data.stats.multiFileClasses + ' span 2+ files, '
  + data.stats.divergentClasses + ' with property divergence)');
console.log('');
console.log('  report -> ' + OUT);
