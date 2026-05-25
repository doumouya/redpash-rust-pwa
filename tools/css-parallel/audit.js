#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash CSS-parallel audit
   ---------------------------------------------------------------------------
   Detects page-prefixed classes (`.rp-foo`) that look like parallel
   implementations of foundation atoms (`.rt-bar`). Surfacing the leak
   per [[feedback-compose-atoms-dont-parallel]]: every parallel-class
   is a CSS leak waiting to compound into the orphan rules that
   later cleanups chase.

   Em (2026-05-25): "rt-table-wrap is the atomic part you should have
   used if you just wanted to put lists on the page without toolbar.
   but you created rp-mon-panel. and just this created a leak on the css."

   The audit scores property-set similarity:
     • parses every CSS rule (selector + declarations) under styles/
     • indexes rules by selector type:
         - foundation atoms: bare `.rt-*` rules (no descendants)
         - page-prefixed:    bare `.rp-*` rules (no descendants)
     • for each page-prefixed rule, finds the best-match foundation
       atom by Jaccard on property names + exact-value overlap
     • flags pairs whose similarity score crosses a threshold

   Output:
     • parallels.json  — full payload of candidate pairs, sorted by score
     • parallels.html  — sortable + filterable browser report

   v1 is intentionally conservative: only BARE single-class selectors
   (`.rp-foo { … }`) are compared. Descendant rules like
   `.rp-foo .bar` don't surface — they're often page-positional, not
   visual primitives. We'd rather have a few false negatives than
   noisy false positives. False-positive pairs the user can dismiss
   per row; false negatives mean we still walk past leaks.

   Usage:  node tools/css-parallel/audit.js [projectRoot]
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs   = require('fs');
var path = require('path');

var ROOT       = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
var STYLES_DIR = path.join(ROOT, 'frontend', 'styles');

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
function rel(p) { return path.relative(ROOT, p); }

var cssFiles = walk(STYLES_DIR, '.css').sort();

// ── parse CSS rules ─────────────────────────────────────────────────────
// Single-pass character walker: track depth via `{` and `}`. At depth 0,
// accumulate the selector until `{`. At depth 1, accumulate declarations
// until `}`. Inside a string (single/double quote), pass-through. Comments
// are stripped first to keep the depth tracker simple.
//
// Each "rule" is one of:
//   • a plain { selector, decls, file, line }
//   • an at-rule (@media, @supports, …) — its body's rules are emitted
//     with their parent's media context recorded, so a `.rp-foo`
//     inside @media doesn't accidentally match a top-level `.rt-bar`
//     across context boundaries.
//
// Only at-rule type and selector text are retained; we don't track
// specificity / source order — those are the css-audit tool's domain.
//
// Returns an array of rules across all files.
function parseRules() {
  var rules = [];
  cssFiles.forEach(function (file) {
    var src = fs.readFileSync(file, 'utf8');
    // strip block comments, preserving newlines for line accuracy
    src = src.replace(/\/\*[\s\S]*?\*\//g, function (m) {
      return m.replace(/[^\n]/g, '');
    });
    var i = 0, n = src.length, line = 1;
    var depth = 0;
    var atCtx = '';                    // @media query stack
    var selBuf = '', selStart = 1;
    var declBuf = '';
    var ruleSelector = null, ruleStart = 1;
    while (i < n) {
      var c = src[i];
      if (c === '\n') line++;
      // strings — skip until matching quote, line-aware
      if (c === '"' || c === "'") {
        var q = c;
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === '\\') i++;
          if (src[i] === '\n') line++;
          i++;
        }
        if (depth === 0) selBuf += q + 'STR' + q;
        else if (depth >= 1) declBuf += q + 'STR' + q;
        i++;
        continue;
      }
      if (c === '{') {
        if (depth === 0) {
          // selector buffer is complete; could be an at-rule or a real selector
          var t = selBuf.trim();
          if (t.charAt(0) === '@') {
            atCtx = t;
            selBuf = '';
            depth++;
            i++;
            continue;
          }
          ruleSelector = t;
          ruleStart    = selStart;
          declBuf      = '';
          depth++;
          i++;
          selBuf = '';
          continue;
        }
        // shouldn't nest inside a rule body (no native CSS nesting in our
        // sheets); treat as text.
        declBuf += c;
        depth++;
        i++;
        continue;
      }
      if (c === '}') {
        depth--;
        if (depth === 0) {
          // we're closing either a rule body or an at-rule body
          if (ruleSelector !== null) {
            // finished a normal rule
            rules.push({
              file: rel(file),
              line: ruleStart,
              selector: ruleSelector,
              decls: parseDecls(declBuf),
              media: atCtx,
            });
            ruleSelector = null;
            declBuf = '';
          } else {
            // closed an @media context
            atCtx = '';
          }
        } else {
          declBuf += c;
        }
        i++;
        continue;
      }
      if (depth === 0) {
        if (selBuf === '' && /\s/.test(c)) { i++; continue; }
        if (selBuf === '') selStart = line;
        selBuf += c;
      } else {
        declBuf += c;
      }
      i++;
    }
  });
  return rules;
}

// Parse a declaration block into a Map<prop, value>. Values are
// normalised: whitespace collapsed, trailing `;` stripped.
function parseDecls(text) {
  var out = new Map();
  text.split(';').forEach(function (chunk) {
    var idx = chunk.indexOf(':');
    if (idx < 0) return;
    var prop = chunk.slice(0, idx).trim();
    var val  = chunk.slice(idx + 1).trim().replace(/\s+/g, ' ');
    if (!prop || !val) return;
    out.set(prop, val);
  });
  return out;
}

var allRules = parseRules();

// ── filter to bare single-class rules ───────────────────────────────────
// `.foo { … }` only — not `.foo:hover`, not `.foo .bar`, not `.foo.bar`.
// Multi-selector rules like `.foo, .bar` are expanded into one entry per
// class so a shared rule still contributes to both classes' property set.
function bareClassFrom(selector) {
  var t = selector.trim();
  // must start with a class and be just one class token
  if (!/^\.[A-Za-z_][\w-]*$/.test(t)) return null;
  return t.slice(1);
}
function tryExpandSelectorList(selector) {
  // split on commas if EVERY split is a bare class; else null
  var parts = selector.split(',').map(function (s) { return s.trim(); });
  if (parts.length < 2) return null;
  var classes = [];
  for (var i = 0; i < parts.length; i++) {
    var c = bareClassFrom(parts[i]);
    if (!c) return null;
    classes.push(c);
  }
  return classes;
}

// Build index: className → merged Map<prop, value> (across all bare-class
// rules in the same media context, last write wins per property).
var ATOMS  = new Map();   // .rt-foo  → { decls, sources: [{file, line}] }
var PAGES  = new Map();   // .rp-foo  → { decls, sources: [{file, line}] }
function addEntry(map, name, decls, src) {
  var e = map.get(name);
  if (!e) { e = { decls: new Map(), sources: [] }; map.set(name, e); }
  decls.forEach(function (v, k) { e.decls.set(k, v); });
  e.sources.push(src);
}
allRules.forEach(function (r) {
  // We only compare rules outside @media for v1 — keeps the surface
  // small + parallel comparisons honest.
  if (r.media) return;
  var src = { file: r.file, line: r.line, selector: r.selector };
  var bare = bareClassFrom(r.selector);
  if (bare) {
    if (bare.indexOf('rt-') === 0) addEntry(ATOMS, bare, r.decls, src);
    else if (bare.indexOf('rp-') === 0) addEntry(PAGES, bare, r.decls, src);
    return;
  }
  var expanded = tryExpandSelectorList(r.selector);
  if (expanded) {
    expanded.forEach(function (c) {
      if (c.indexOf('rt-') === 0) addEntry(ATOMS, c, r.decls, src);
      else if (c.indexOf('rp-') === 0) addEntry(PAGES, c, r.decls, src);
    });
  }
});

// ── similarity scoring ──────────────────────────────────────────────────
// Jaccard on property names + bonus for exact-value matches. A page rule
// that re-implements an atom rule typically copies most of its property
// set; values may differ (e.g. own border-radius, own padding) but
// structural overlap stays high.
//
//   union  = |keys(A) ∪ keys(B)|
//   shared = |keys(A) ∩ keys(B)|
//   exact  = count of p in shared where A[p] === B[p]
//   score  = (shared / union) * 0.7  +  (exact / max(|A|,|B|)) * 0.3
//
// Score range [0, 1]. We flag pairs with score >= SCORE_THRESHOLD AND
// shared >= MIN_SHARED_PROPS, so a tiny 2-property rule doesn't trigger
// against every other tiny rule.
var SCORE_THRESHOLD  = 0.50;
var MIN_SHARED_PROPS = 4;

function score(a, b) {
  var aKeys = Array.from(a.decls.keys());
  var bKeys = Array.from(b.decls.keys());
  var aSet  = new Set(aKeys);
  var bSet  = new Set(bKeys);
  var sharedKeys = aKeys.filter(function (k) { return bSet.has(k); });
  var union = aSet.size + bSet.size - sharedKeys.length;
  if (union === 0) return { score: 0, shared: [], exact: [], divergent: [] };
  var exactKeys = sharedKeys.filter(function (k) {
    return a.decls.get(k) === b.decls.get(k);
  });
  var jaccard   = sharedKeys.length / union;
  var exactRate = exactKeys.length / Math.max(aKeys.length, bKeys.length);
  return {
    score:     (jaccard * 0.7) + (exactRate * 0.3),
    shared:    sharedKeys,
    exact:     exactKeys,
    divergent: sharedKeys.filter(function (k) {
      return a.decls.get(k) !== b.decls.get(k);
    }),
    pageOnly:  aKeys.filter(function (k) { return !bSet.has(k); }),
    atomOnly:  bKeys.filter(function (k) { return !aSet.has(k); }),
  };
}

// ── pair every page-class against every atom; keep top match per page ──
var pairs = [];
PAGES.forEach(function (pEntry, pName) {
  var best = null;
  ATOMS.forEach(function (aEntry, aName) {
    var s = score(pEntry, aEntry);
    if (s.shared.length < MIN_SHARED_PROPS) return;
    if (s.score < SCORE_THRESHOLD) return;
    if (!best || s.score > best.score) {
      best = {
        page:      pName,
        atom:      aName,
        score:     s.score,
        shared:    s.shared.length,
        exact:     s.exact.length,
        divergent: s.divergent,
        pageOnly:  s.pageOnly,
        atomOnly:  s.atomOnly,
        page_sources: pEntry.sources,
        atom_sources: aEntry.sources,
        page_decls:   Object.fromEntries(pEntry.decls),
        atom_decls:   Object.fromEntries(aEntry.decls),
      };
    }
  });
  if (best) pairs.push(best);
});

pairs.sort(function (a, b) { return b.score - a.score; });

// ── write JSON + HTML ───────────────────────────────────────────────────
var summary = {
  atoms_total: ATOMS.size,
  pages_total: PAGES.size,
  candidates:  pairs.length,
  threshold:   SCORE_THRESHOLD,
  min_shared:  MIN_SHARED_PROPS,
  generated_at: new Date().toISOString(),
};
var OUT_DIR  = __dirname;
fs.writeFileSync(path.join(OUT_DIR, 'parallels.json'),
  JSON.stringify({ summary: summary, pairs: pairs }, null, 2));

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
  '<title>RedPash · CSS parallel-class audit</title>',
  '<style>',
  '  :root { --bg:#1e1e2e; --surface:#313244; --border:#45475a; --text:#cdd6f4; --mute:#a6adc8; --accent:#89b4fa; --ok:#a6e3a1; --warn:#f9e2af; --err:#f38ba8; }',
  '  body { background:var(--bg); color:var(--text); font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; margin:0; padding:1.5rem; }',
  '  h1 { margin:0 0 0.5rem; font-size:1.25rem; }',
  '  .sub { color:var(--mute); margin-bottom:1.5rem; max-width:60rem; }',
  '  .controls { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-bottom:1rem; }',
  '  input, select { background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:4px; padding:0.375rem 0.625rem; font:inherit; }',
  '  input[type="search"] { min-width:18rem; }',
  '  .chip { display:inline-flex; align-items:center; gap:0.375rem; padding:0.25rem 0.625rem; border-radius:999rem; background:var(--surface); border:1px solid var(--border); font-size:0.75rem; }',
  '  .stats { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; }',
  '  table { width:100%; border-collapse:collapse; }',
  '  th, td { text-align:left; padding:0.5rem 0.625rem; border-bottom:1px solid var(--border); vertical-align:top; }',
  '  th { position:sticky; top:0; background:var(--bg); color:var(--mute); font-weight:600; font-size:0.7rem; text-transform:uppercase; letter-spacing:0.04em; cursor:pointer; user-select:none; }',
  '  td.name { font-weight:600; white-space:nowrap; }',
  '  td.name.page { color:var(--err); }',
  '  td.name.atom { color:var(--ok); }',
  '  td.score { font-variant-numeric:tabular-nums; }',
  '  td.score b { color:var(--warn); }',
  '  td.props { font-size:0.7rem; color:var(--mute); }',
  '  td.props .grp { display:block; margin-bottom:0.25rem; }',
  '  td.props .label { color:var(--mute); margin-right:0.25rem; }',
  '  details summary { cursor:pointer; color:var(--mute); }',
  '  details summary:hover { color:var(--text); }',
  '  details[open] summary { color:var(--text); margin-bottom:0.375rem; }',
  '  pre { margin:0; font-family:inherit; font-size:0.7rem; color:var(--text); background:var(--surface); padding:0.5rem; border-radius:0.375rem; overflow-x:auto; }',
  '  pre .diff-page { color:var(--err); }',
  '  pre .diff-atom { color:var(--ok); }',
  '  pre .diff-shared-same { color:var(--mute); }',
  '</style>',
  '</head><body>',
  '<h1>RedPash · CSS parallel-class audit</h1>',
  '<p class="sub">Page-prefixed classes (<code>.rp-*</code>) that look like parallel implementations of foundation atoms (<code>.rt-*</code>). Each candidate is scored by Jaccard property overlap + exact-value match rate. ' +
  '<b>Score ≥ ' + SCORE_THRESHOLD + '</b> with at least <b>' + MIN_SHARED_PROPS + '</b> shared properties is flagged. ' +
  'High score ≠ certain leak; <b>each pair needs a human call</b> — but the report tells you where to look.<br>',
  '<small>Per <code>feedback-compose-atoms-dont-parallel</code>: parallel-classes are the CSS leak that produces orphan rules later cleanups chase.</small></p>',
  '<div class="stats">',
  '  <span class="chip">' + summary.atoms_total + ' rt-* atoms</span>',
  '  <span class="chip">' + summary.pages_total + ' rp-* page classes</span>',
  '  <span class="chip">' + summary.candidates  + ' candidates flagged</span>',
  '</div>',
  '<div class="controls">',
  '  <input type="search" id="q" placeholder="filter by name… (regex ok)" />',
  '  <span id="count" style="color:var(--mute)"></span>',
  '</div>',
  '<table id="t">',
  '  <thead><tr>',
  '    <th data-sort="page">Page class (.rp-)</th>',
  '    <th data-sort="atom">Closest atom (.rt-)</th>',
  '    <th data-sort="score">Score</th>',
  '    <th>Shared / exact</th>',
  '    <th>Diff (page → atom)</th>',
  '  </tr></thead>',
  '  <tbody id="tbody"></tbody>',
  '</table>',
  '<script>',
  'var PAIRS = ' + JSON.stringify(pairs) + ';',
  'var sort = { key: "score", dir: -1 };',
  'function diffBlock(p) {',
  '  var lines = [];',
  '  p.divergent.forEach(function (k) {',
  '    lines.push(\'<span class="diff-page">.\' + p.page + \' { \' + k + \': \' + p.page_decls[k] + \' }</span>\');',
  '    lines.push(\'<span class="diff-atom">.\' + p.atom + \' { \' + k + \': \' + p.atom_decls[k] + \' }</span>\');',
  '  });',
  '  p.pageOnly.forEach(function (k) {',
  '    lines.push(\'<span class="diff-page">only .\' + p.page + \': \' + k + \': \' + p.page_decls[k] + \'</span>\');',
  '  });',
  '  p.atomOnly.forEach(function (k) {',
  '    lines.push(\'<span class="diff-atom">only .\' + p.atom + \': \' + k + \': \' + p.atom_decls[k] + \'</span>\');',
  '  });',
  '  return \'<pre>\' + (lines.join(String.fromCharCode(10)) || \'(no diff — full overlap)\') + \'</pre>\';',
  '}',
  'function render() {',
  '  var q = document.getElementById("q").value.trim();',
  '  var re = null;',
  '  if (q) { try { re = new RegExp(q, "i"); } catch (e) {} }',
  '  var rows = PAIRS.filter(function (p) {',
  '    return !re || re.test(p.page) || re.test(p.atom);',
  '  }).sort(function (a, b) {',
  '    var av = a[sort.key], bv = b[sort.key];',
  '    if (av < bv) return -sort.dir;',
  '    if (av > bv) return  sort.dir;',
  '    return 0;',
  '  });',
  '  document.getElementById("count").textContent = rows.length + " candidate" + (rows.length === 1 ? "" : "s");',
  '  document.getElementById("tbody").innerHTML = rows.map(function (p) {',
  '    var s = p.score.toFixed(2);',
  '    var src = p.page_sources[0];',
  '    return \'<tr>\'',
  '      + \'<td class="name page">.\' + p.page + \'<br><small style="color:var(--mute);font-weight:400">\' + src.file + \':\' + src.line + \'</small></td>\'',
  '      + \'<td class="name atom">.\' + p.atom + \'</td>\'',
  '      + \'<td class="score"><b>\' + s + \'</b></td>\'',
  '      + \'<td class="props"><span class="grp"><span class="label">shared</span>\' + p.shared + \'</span><span class="grp"><span class="label">exact</span>\' + p.exact + \'</span></td>\'',
  '      + \'<td><details><summary>\' + p.divergent.length + \' diverge · \' + p.pageOnly.length + \' page-only · \' + p.atomOnly.length + \' atom-only</summary>\' + diffBlock(p) + \'</details></td>\'',
  '      + \'</tr>\';',
  '  }).join("");',
  '}',
  'document.querySelectorAll("th[data-sort]").forEach(function (th) {',
  '  th.addEventListener("click", function () {',
  '    var k = th.dataset.sort;',
  '    if (sort.key === k) sort.dir = -sort.dir; else { sort.key = k; sort.dir = (k === "score" ? -1 : 1); }',
  '    render();',
  '  });',
  '});',
  'document.getElementById("q").addEventListener("input", render);',
  'render();',
  '</script>',
  '</body></html>',
].join('\n');
fs.writeFileSync(path.join(OUT_DIR, 'parallels.html'), html);

// ── stdout summary ──────────────────────────────────────────────────────
console.log('RedPash CSS parallel-class audit');
console.log('');
console.log('  scanned ' + cssFiles.length + ' CSS files');
console.log('    rt-* foundation atoms: ' + ATOMS.size);
console.log('    rp-* page classes:     ' + PAGES.size);
console.log('');
console.log('  candidates flagged: ' + pairs.length);
console.log('    threshold: score >= ' + SCORE_THRESHOLD + ' AND shared >= ' + MIN_SHARED_PROPS + ' props');
console.log('');
if (pairs.length) {
  console.log('  top matches:');
  pairs.slice(0, 10).forEach(function (p) {
    console.log('    ' + p.score.toFixed(2) + '  .' + p.page.padEnd(34) + ' ↔ .' + p.atom);
  });
  if (pairs.length > 10) console.log('    … ' + (pairs.length - 10) + ' more');
  console.log('');
}
console.log('  report -> ' + path.relative(ROOT, path.join(OUT_DIR, 'parallels.html')));
console.log('  payload -> ' + path.relative(ROOT, path.join(OUT_DIR, 'parallels.json')));
