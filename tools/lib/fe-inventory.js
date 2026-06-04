#!/usr/bin/env node
/* Purpose: front-end component inventory — enumerate EVERY UI component group from
 * CSS + HTML + JS (the completeness denominator for the doc catalog + coverage audit).
 * Doc: docs/internal/code/tools/lib/fe-inventory.md */
/* ──────────────────────────────────────────────────────────────────────────
   RedPash fe-inventory — the component enumerator (one lib, many consumers).

   WHY: a hand-curated component list is the closed-enum trap — it silently misses
   whatever the author forgot (the Cases-comments view, modals, the omnisearch
   dropdown, …). Completeness has to be MECHANICAL: enumerate every component that
   exists IN THE CODE, so nothing can be silently dropped. This lib is the single
   source of that enumeration; both the doc generator (tools/doc-gen, kind=component)
   and the coverage audit (tools/ui-doc-audit) consume it — same shape as how
   tools/lib/rust-routes.js serves the route lane.

   THREE SOURCES (union → truly complete):
     1. CSS class-families  (frontend/styles)         — the strongest signal; anchors components
     2. HTML usage          (frontend/partials, index.html)
     3. JS-rendered widgets (frontend/scripts, recursive .js) — the BLIND SPOT of a
        static scan (modals, comments list, pickers are injected by JS, not partials)

   GROUPING (flat / maximal granularity — Em: "lay down the maximal granular view to
   remove duplicates"): every class folds to its BLOCK ROOT = climb to the top defined
   CSS class reached by repeatedly jumping to the longest defined PROPER ancestor
   (gap-skipping). So `rp-cases-detail-side-attachments-head` → `rp-cases-detail`
   (climbs through defined ancestors) but `rp-cases-board` stays its own block
   (`rp-cases` is not a class). Distinct blocks stay distinct; elements fold into their
   real block. `--modifier` / `__element` separators are stripped by the token regex.
   The dedup detector (ui-doc-audit) is what flags parallel blocks
   (`rp-cases-detail-head` vs `rp-shell-head`) — grouping keeps them separate so the
   parallelism stays visible.

   COMPONENTS vs HOOKS: a group anchored by a CSS-defined class is a COMPONENT (styled,
   structural — a catalog doc). A class used only in HTML/JS with no CSS rule and no
   defined ancestor is a dynamic HOOK (a one-off id-like handle) — reported separately,
   never silently dropped, but not its own catalog doc.

   Read-only. No deps (vanilla Node, like the shell audits).
   CLI (inspection):  node tools/lib/fe-inventory.js [--json] [--hooks]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var FE = path.join(ROOT, 'frontend');

/* Class tokens use rt-/rp-/ds-/ws- prefixes. The trailing `(?:-[a-z0-9]+)*` requires a
   [a-z0-9] after every dash, so `rt-toolbar--data` captures `rt-toolbar` and
   `rp-list-composite__stats` captures `rp-list-composite` — BEM modifier/element
   separators are stripped, leaving the kebab base. */
var CLASS_TOK = /\b(?:rt|rp|ds|ws)-[a-z0-9]+(?:-[a-z0-9]+)*/g;
var CSS_DEF   = /\.((?:rt|rp|ds|ws)-[a-z0-9]+(?:-[a-z0-9]+)*)/g;   // a class as a selector subject
/* render-root DEFINITIONS only (not calls): `function mountX` / `const renderX =`. */
var RENDER_FN = /(?:function\s+|(?:const|let|var)\s+)((?:mount|render|create|open|build)[A-Z][A-Za-z0-9_]*)\s*(?:=|\()/g;

/* ── recursive file walk ──────────────────────────────────────────────────── */
function walk(dir, exts, out) {
  out = out || [];
  var ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'vendor' || e.name.charAt(0) === '.') return;
      walk(p, exts, out);
    } else if (exts.some(function (x) { return e.name.endsWith(x); })) {
      out.push(p);
    }
  });
  return out;
}
function rel(p) { return path.relative(ROOT, p); }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function pushUniq(arr, v) { if (arr.indexOf(v) < 0) arr.push(v); }

/* ── scan the three sources ───────────────────────────────────────────────── */
function scan() {
  var cssFiles = walk(path.join(FE, 'styles'), ['.css']);
  var htmlFiles = walk(path.join(FE, 'partials'), ['.html']).concat(
    fs.existsSync(path.join(FE, 'index.html')) ? [path.join(FE, 'index.html')] : []);
  var jsFiles = walk(path.join(FE, 'scripts'), ['.js']);

  var defined = Object.create(null);   // class → [css files] (defined as a selector)
  var cssCtx = Object.create(null);     // class → [css files] (any occurrence — divergence seed)
  var htmlUse = Object.create(null);    // class → [html files]
  var jsUse = Object.create(null);      // class → [js files]
  var renderByFile = Object.create(null); // js file → [render-root fn names]

  function add(map, cls, file) { (map[cls] || (map[cls] = [])); pushUniq(map[cls], file); }

  cssFiles.forEach(function (f) {
    var txt = read(f), r = rel(f), m;
    CSS_DEF.lastIndex = 0;
    while ((m = CSS_DEF.exec(txt))) add(defined, m[1], r);
    CLASS_TOK.lastIndex = 0;
    while ((m = CLASS_TOK.exec(txt))) add(cssCtx, m[0], r);
  });
  htmlFiles.forEach(function (f) {
    var txt = read(f), r = rel(f), m;
    CLASS_TOK.lastIndex = 0;
    while ((m = CLASS_TOK.exec(txt))) add(htmlUse, m[0], r);
  });
  jsFiles.forEach(function (f) {
    var txt = read(f), r = rel(f), m;
    CLASS_TOK.lastIndex = 0;
    while ((m = CLASS_TOK.exec(txt))) add(jsUse, m[0], r);
    var fns = [];
    RENDER_FN.lastIndex = 0;
    while ((m = RENDER_FN.exec(txt))) pushUniq(fns, m[1]);
    if (fns.length) renderByFile[r] = fns.sort();
  });

  return { defined: defined, cssCtx: cssCtx, htmlUse: htmlUse, jsUse: jsUse, renderByFile: renderByFile,
           counts: { css: cssFiles.length, html: htmlFiles.length, js: jsFiles.length } };
}

/* ── block-root folding (the grouping rule) ───────────────────────────────── */
function blockRoot(cls, defined) {
  var cur = cls, guard = 0;
  while (guard++ < 40) {
    var parts = cur.split('-');
    var next = null;
    for (var n = parts.length - 1; n >= 2; n--) {       // longest defined PROPER ancestor
      var anc = parts.slice(0, n).join('-');
      if (defined[anc]) { next = anc; break; }
    }
    if (next) { cur = next; continue; }                 // climb (gap-skipping)
    return cur;
  }
  return cur;
}
function label(key) {
  return key.replace(/^(rt|rp|ds|ws)-/, '')
            .split('-').map(function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; })
            .join(' ');
}

/* ── the public API ───────────────────────────────────────────────────────── */
function inventory() {
  var s = scan();
  var allClasses = Object.create(null);
  [s.defined, s.htmlUse, s.jsUse].forEach(function (map) {
    Object.keys(map).forEach(function (c) { allClasses[c] = true; });
  });

  var groups = Object.create(null);
  function group(key) {
    if (!groups[key]) {
      groups[key] = { key: key, label: label(key), prefix: key.split('-')[0],
                      classes: [], cssFiles: {}, partials: {}, jsFiles: {}, renderFns: {},
                      jsRendered: false, cssDefined: false };
    }
    return groups[key];
  }

  Object.keys(allClasses).sort().forEach(function (cls) {
    var key = blockRoot(cls, s.defined);
    var g = group(key);
    g.classes.push(cls);
    (s.defined[cls] || []).forEach(function (f) { g.cssFiles[f] = true; g.cssDefined = true; });
    (s.cssCtx[cls] || []).forEach(function (f) { g.cssFiles[f] = true; });
    (s.htmlUse[cls] || []).forEach(function (f) { g.partials[f] = true; });
    (s.jsUse[cls] || []).forEach(function (f) {
      g.jsFiles[f] = true;
      (s.renderByFile[f] || []).forEach(function (fn) { g.renderFns[fn] = true; });
    });
  });

  var comps = [], hooks = [];
  Object.keys(groups).sort().forEach(function (key) {
    var g = groups[key];
    g.classes = g.classes.sort();
    g.cssFiles = Object.keys(g.cssFiles).sort();
    g.partials = Object.keys(g.partials).sort();
    g.jsFiles = Object.keys(g.jsFiles).sort();
    g.renderFns = Object.keys(g.renderFns).sort();
    g.jsRendered = g.jsFiles.length > 0;
    if (g.cssDefined) comps.push(g);            // styled, structural → a catalog component
    else hooks.push(g);                          // un-styled dynamic class → a hook (reported, not a doc)
  });

  return {
    generatedFrom: '3-source scan (css+html+js)',
    counts: { components: comps.length, hooks: hooks.length, classes: Object.keys(allClasses).length,
              css: s.counts.css, html: s.counts.html, js: s.counts.js },
    components: comps,
    hooks: hooks,
  };
}

/* ── CSS selector index (class → the selector contexts it appears in) ──────────
   The raw material for the divergence detector: a class styled under multiple
   ancestor contexts (e.g. `.rp-chip-row` plus `.rp-cases-chip-row .rp-chip-row`)
   is "contextually overridden" — same name, divergent behavior. Light scan (selector
   strings only, no declaration parse); innermost `selector { … }` rules. */
function cssSelectorIndex() {
  var cssFiles = walk(path.join(FE, 'styles'), ['.css']);
  var idx = Object.create(null);   // class → [{ file, selector }]
  cssFiles.forEach(function (f) {
    var txt = read(f).replace(/\/\*[\s\S]*?\*\//g, '');   // strip block comments
    var r = rel(f), re = /([^{}]+)\{[^{}]*\}/g, m;
    while ((m = re.exec(txt))) {
      m[1].split(',').forEach(function (sel) {
        sel = sel.replace(/\s+/g, ' ').trim();
        if (!sel || sel.charAt(0) === '@') return;        // skip @media/@supports wrappers
        var seen = Object.create(null), mm;
        CLASS_TOK.lastIndex = 0;
        while ((mm = CLASS_TOK.exec(sel))) {
          var c = mm[0];
          if (seen[c]) continue; seen[c] = true;
          (idx[c] || (idx[c] = [])).push({ file: r, selector: sel });
        }
      });
    }
  });
  return idx;
}

/* ── dedup analysis (consumed by both gen.js and ui-doc-audit) ────────────────
   Two smells the flat catalog exists to expose (Em):
     • divergence: one class styled under ≥2 ancestor contexts → same name, divergent
       behavior (`.rp-chip-row` own + `.rp-cases-* .rp-chip-row`) → unify.
     • parallel:   many classes share a structural-role suffix across different blocks
       (`-head`: rp-shell-head, rp-cases-detail-head, rp-modal-head…) → compose one atom. */
var ROLE_SUFFIXES = {};
('head header title body foot footer count label value item row cell close icon caret name input '
 + 'wrap inner list dot badge pill toggle empty state error hint menu bar').split(' ')
  .forEach(function (s) { ROLE_SUFFIXES[s] = true; });

function lastSeg(cls) { var i = cls.lastIndexOf('-'); return i >= 0 ? cls.slice(i + 1) : cls; }

function ancestorContext(selector, cls) {
  var compounds = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  var idx = -1;
  for (var i = 0; i < compounds.length; i++) {
    if (new RegExp('\\.' + cls + '(?![\\w-])').test(compounds[i])) { idx = i; break; }
  }
  if (idx <= 0) return '';                  // cls is the anchoring (first) compound → own context
  return compounds.slice(0, idx).join(' ');
}
function divergences(selIndex) {
  var out = [];
  Object.keys(selIndex || cssSelectorIndex()).sort().forEach(function (cls) {
    var ctxs = {};
    selIndex[cls].forEach(function (e) { var c = ancestorContext(e.selector, cls); ctxs[c] = true; });
    var keys = Object.keys(ctxs), contextual = keys.filter(function (k) { return k !== ''; });
    if (contextual.length && (ctxs[''] || contextual.length >= 2)) {
      out.push({ cls: cls, contexts: keys.map(function (k) { return k === '' ? '(own)' : k; }) });
    }
  });
  return out;
}
function parallels(components, hooks) {
  var bySuffix = {};
  components.concat(hooks || []).forEach(function (g) {
    g.classes.forEach(function (cls) {
      var suf = lastSeg(cls);
      if (!ROLE_SUFFIXES[suf]) return;
      (bySuffix[suf] || (bySuffix[suf] = [])).push({ cls: cls, root: g.key });
    });
  });
  var out = [];
  Object.keys(bySuffix).forEach(function (suf) {
    var members = bySuffix[suf], roots = {};
    members.forEach(function (m) { roots[m.root] = true; });
    if (members.length >= 2 && Object.keys(roots).length >= 2) {
      out.push({ suffix: suf, count: members.length, blocks: Object.keys(roots).length,
                 members: members.map(function (m) { return m.cls; }).sort() });
    }
  });
  return out.sort(function (a, b) { return b.count - a.count; });
}

/* one-shot: inventory + selector index + both dedup analyses (the parity baseline). */
function analyze() {
  var i = inventory(), sel = cssSelectorIndex();
  return { counts: i.counts, components: i.components, hooks: i.hooks,
           divergences: divergences(sel), parallels: parallels(i.components, i.hooks) };
}

module.exports = { inventory: inventory, blockRoot: blockRoot, cssSelectorIndex: cssSelectorIndex,
                   divergences: divergences, parallels: parallels, analyze: analyze, _scan: scan };

/* ── CLI (inspection only) ────────────────────────────────────────────────── */
if (require.main === module) {
  var inv = inventory();
  if (process.argv.indexOf('--json') >= 0) {
    process.stdout.write(JSON.stringify(inv, null, 2) + '\n');
  } else {
    var showHooks = process.argv.indexOf('--hooks') >= 0;
    console.log('fe-inventory — ' + inv.counts.components + ' components + ' + inv.counts.hooks
      + ' hooks from ' + inv.counts.classes + ' classes ('
      + inv.counts.css + ' css, ' + inv.counts.html + ' html, ' + inv.counts.js + ' js)');
    console.log('────────────────────────────────────────────────────────────');
    (showHooks ? inv.hooks : inv.components).forEach(function (g) {
      var tags = [];
      if (g.jsRendered) tags.push('JS:' + g.renderFns.slice(0, 3).join(','));
      console.log('  ' + pad(g.key, 34) + ' ' + String(g.classes.length).padStart(2) + ' cls  '
        + (tags.length ? tags.join(' ') : ''));
    });
  }
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
