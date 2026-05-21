#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────
   RedPash HTML component-extraction audit
   ---------------------------------------------------------------------------
   Parses every partial under frontend/partials, hashes every element subtree
   three ways, and surfaces reusable-component candidates ranked by how many
   lines extracting them would save.

   Match tiers (strongest first):
     exact    — byte-identical subtree (whitespace-normalised).
     class    — identical tag tree + identical class lists; only ids / text /
                handler attrs vary  -> those become props.
     struct   — identical tag tree; classes/attrs/text vary -> props.
     slotted  — same container (tag + first class) with identical leading +
                trailing children but a variable middle -> the middle is a
                <slot>. This is what unifies the modal shells.

   For every candidate it derives the proposed prop list + slot(s) by diffing
   the occurrences, then emits a component skeleton and one example call-site.

   No framework assumed: output targets the existing static data-include
   loader (a {{prop}} + <slot> extension is sketched per candidate).

   Usage:  node audit.js [partialsDir]
   Output: ./report.html
   ────────────────────────────────────────────────────────────────────────── */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PARTIALS_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : '/home/mansa/redpash-app/frontend/partials';
var OUT = path.join(__dirname, 'report.html');

/* tuning */
var MIN_NODES  = 4;   // element nodes in a candidate (fixed part, for slotted)
var MIN_SAVED  = 5;   // estimated lines saved — drop noise below this
var MIN_CHROME = 2;   // leading+trailing fixed children required for a slot

var VOID = { area:1, base:1, br:1, col:1, embed:1, hr:1, img:1, input:1,
  link:1, meta:1, param:1, source:1, track:1, wbr:1 };
var RAWTEXT = { script:1, style:1, textarea:1, title:1 };
var IMPLIED = { li:1, option:1, tr:1, td:1, th:1, dd:1, dt:1 }; // self-closing peers

function h(s) { return crypto.createHash('md5').update(s).digest('hex').slice(0, 16); }

/* ── file discovery ──────────────────────────────────────────────────────── */
function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && /\.html?$/i.test(e.name)) acc.push(full);
  });
  return acc;
}

/* ── tolerant HTML parser ────────────────────────────────────────────────── */
var NODE_SEQ = 0;

function parseHtml(text, file) {
  var lineStarts = [0];
  for (var k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
  function lineOf(idx) {
    var lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { var m = (lo + hi + 1) >> 1; if (lineStarts[m] <= idx) lo = m; else hi = m - 1; }
    return lo + 1;
  }

  var root = { type: 'root', children: [], parent: null, file: file, line: 1, endLine: 1 };
  var stack = [root];
  function top() { return stack[stack.length - 1]; }
  function add(node) { node.parent = top(); top().children.push(node); }

  var i = 0, n = text.length;
  while (i < n) {
    if (text[i] === '<') {
      // comment
      if (text.substr(i, 4) === '<!--') {
        var ce = text.indexOf('-->', i + 4);
        if (ce < 0) ce = n; else ce += 3;
        add({ type: 'comment', value: text.slice(i, ce), line: lineOf(i),
              endLine: lineOf(ce - 1), children: [] });
        i = ce; continue;
      }
      // doctype / processing
      if (text[i + 1] === '!' || text[i + 1] === '?') {
        var de = text.indexOf('>', i); if (de < 0) de = n; else de += 1;
        i = de; continue;
      }
      // closing tag
      if (text[i + 1] === '/') {
        var gt = text.indexOf('>', i); if (gt < 0) gt = n;
        var cname = text.slice(i + 2, gt).trim().toLowerCase();
        var depth = -1;
        for (var s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tag === cname) { depth = s; break; }
        }
        if (depth >= 1) {
          for (var p = stack.length - 1; p >= depth; p--) stack[p].endLine = lineOf(gt);
          stack.length = depth;
        }
        i = gt + 1; continue;
      }
      // start tag
      var m2 = /^<([a-zA-Z][-a-zA-Z0-9]*)/.exec(text.slice(i));
      if (!m2) { i++; continue; } // stray '<'
      var tag = m2[1].toLowerCase();
      var j = i + m2[0].length;
      var attrs = {};
      var selfClose = false;
      while (j < n) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '>') { j++; break; }
        if (text[j] === '/' && text[j + 1] === '>') { selfClose = true; j += 2; break; }
        if (j >= n) break;
        var an = '';
        while (j < n && !/[\s=>/]/.test(text[j])) { an += text[j]; j++; }
        while (j < n && /\s/.test(text[j])) j++;
        var av = '';
        if (text[j] === '=') {
          j++;
          while (j < n && /\s/.test(text[j])) j++;
          var q = text[j];
          if (q === '"' || q === "'") {
            j++; var vs = j;
            while (j < n && text[j] !== q) j++;
            av = text.slice(vs, j); j++;
          } else {
            var vs2 = j;
            while (j < n && !/[\s>]/.test(text[j])) j++;
            av = text.slice(vs2, j);
          }
        } else { av = ''; }
        if (an) attrs[an.toLowerCase()] = av;
      }
      var el = {
        type: 'element', id: ++NODE_SEQ, tag: tag, attrs: attrs,
        children: [], parent: null, file: file, line: lineOf(i), endLine: lineOf(j - 1)
      };
      // implied close: <li> ... <li>  — close a same-tag peer first
      if (IMPLIED[tag] && top().tag === tag) {
        top().endLine = lineOf(i);
        stack.pop();
      }
      add(el);
      if (VOID[tag] || selfClose) { /* leaf */ }
      else if (RAWTEXT[tag]) {
        var close = new RegExp('</' + tag + '\\s*>', 'i');
        var rest = text.slice(j);
        var mm = close.exec(rest);
        var rawEnd = mm ? j + mm.index + mm[0].length : n;
        if (mm && mm.index > 0) {
          el.children.push({ type: 'text', value: rest.slice(0, mm.index),
            blank: !rest.slice(0, mm.index).trim(), line: lineOf(j),
            endLine: lineOf(j + mm.index), parent: el, children: [] });
        }
        el.endLine = lineOf(rawEnd - 1);
        i = rawEnd; continue;
      } else {
        stack.push(el);
      }
      i = j; continue;
    }
    // text
    var lt = text.indexOf('<', i);
    if (lt < 0) lt = n;
    var raw = text.slice(i, lt);
    add({ type: 'text', value: raw, blank: !raw.trim(),
          line: lineOf(i), endLine: lineOf(lt - 1), children: [] });
    i = lt;
  }
  for (var z = stack.length - 1; z >= 1; z--) stack[z].endLine = lineOf(n - 1);
  return root;
}

/* ── tree helpers + hashing ──────────────────────────────────────────────── */
function elemKids(node) {
  if (node._ek) return node._ek;
  node._ek = node.children.filter(function (c) { return c.type === 'element'; });
  return node._ek;
}
function classesOf(node) {
  var c = node.attrs && node.attrs['class'] ? node.attrs['class'].trim() : '';
  return c ? c.split(/\s+/) : [];
}
function firstClass(node) { var c = classesOf(node); return c.length ? c[0] : ''; }
function directText(node) {
  return node.children.filter(function (c) { return c.type === 'text' && !c.blank; })
    .map(function (c) { return c.value.replace(/\s+/g, ' ').trim(); })
    .join(' ').trim();
}
function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

/* post-order: size, structHash, classHash, exactHash */
function annotate(node) {
  if (node.type !== 'element' && node.type !== 'root') { node.size = 0; return; }
  var ek = elemKids(node);
  ek.forEach(annotate);
  node.size = (node.type === 'element' ? 1 : 0)
    + ek.reduce(function (a, c) { return a + c.size; }, 0);
  if (node.type === 'root') return;

  node.structHash = h(node.tag + '(' +
    ek.map(function (c) { return c.structHash; }).join(',') + ')');

  var cls = classesOf(node).slice().sort().join('.');
  node.classHash = h(node.tag + '[' + cls + ']{' +
    ek.map(function (c) { return c.classHash; }).join(',') + '}');

  var ats = Object.keys(node.attrs).sort().map(function (a) {
    return a + '=' + node.attrs[a];
  }).join(';');
  var kidSig = node.children.map(function (c) {
    if (c.type === 'element') return 'E' + c.exactHash;
    if (c.type === 'text' && !c.blank) return 'T' + norm(c.value);
    return '';
  }).join('|');
  node.exactHash = h(node.tag + '[' + ats + ']<' + kidSig + '>');
}

/* line span of a subtree */
function lineSpan(node) {
  return Math.max(1, (node.endLine || node.line) - node.line + 1);
}

/* ── run: parse every partial ────────────────────────────────────────────── */
console.log('Scanning ' + PARTIALS_DIR + ' …');
var files = walk(PARTIALS_DIR, []).sort();
if (!files.length) { console.error('No .html files found.'); process.exit(1); }

var roots = [];
var fileMeta = [];
files.forEach(function (full) {
  var rel = path.relative(PARTIALS_DIR, full).split(path.sep).join('/');
  var text = fs.readFileSync(full, 'utf8');
  var root = parseHtml(text, rel);
  annotate(root);
  roots.push(root);
  fileMeta.push({ path: rel, lines: text.split('\n').length });
});

/* collect every element node */
var allEls = [];
(function collect(node) {
  if (node.type === 'element') allEls.push(node);
  node.children.forEach(collect);
})({ children: roots, type: 'root' });

/* ── clustering ──────────────────────────────────────────────────────────── */
function groupBy(list, keyFn) {
  var m = {};
  list.forEach(function (x) {
    var k = keyFn(x);
    if (!k) return;
    (m[k] || (m[k] = [])).push(x);
  });
  return m;
}

var bigEnough = allEls.filter(function (e) { return e.size >= MIN_NODES; });

var exactGroups  = groupBy(bigEnough, function (e) { return e.exactHash; });
var classGroups  = groupBy(bigEnough, function (e) { return e.classHash; });
var structGroups = groupBy(bigEnough, function (e) { return e.structHash; });

/* ── diff a set of structurally-identical nodes -> variable points ───────── */
function intersect(a, b) { var o = {}; Object.keys(a).forEach(function (k) { if (b[k]) o[k] = 1; }); return o; }
function distinct(arr) { var s = {}; arr.forEach(function (v) { s[v === null ? ' ' : v] = 1; }); return Object.keys(s).length; }

var _names;
function uniqName(base) {
  var nm = base, i = 2;
  while (_names[nm]) { nm = base + i; i++; }
  _names[nm] = 1;
  return nm;
}
function pickClassName(node, varTok) {
  if (node.tag === 'i' || varTok.join(' ').indexOf('bi-') === 0) return uniqName('icon');
  return uniqName('variant');
}
function pickAttrName(attr) {
  if (attr === 'id') return uniqName('id');
  if (attr === 'onclick') return uniqName('onClick');
  if (attr === 'href') return uniqName('href');
  if (attr === 'data-include') return uniqName('include');
  return uniqName(attr.replace(/[^a-z0-9]+/gi, '_'));
}
function pickTextName(node) {
  var cl = classesOf(node).join(' ');
  if (/ttl|title/i.test(cl)) return uniqName('title');
  if (/\bsub\b|subtitle/i.test(cl)) return uniqName('subtitle');
  if (/lbl|label/i.test(cl)) return uniqName('label');
  if (node.tag === 'button' || node.tag === 'a') return uniqName('label');
  if (/^h[1-6]$/.test(node.tag)) return uniqName('heading');
  return uniqName('text');
}

/* diff one aligned set of nodes — class / attr / text — annotate nodes[0] */
function diffOne(nodes, vars) {
  var n0 = nodes[0];
  // class
  var classSets = nodes.map(classesOf);
  var allTok = {}, common = null;
  classSets.forEach(function (set) {
    var seen = {};
    set.forEach(function (t) { allTok[t] = 1; seen[t] = 1; });
    common = common === null ? seen : intersect(common, seen);
  });
  common = common || {};
  var varTok = Object.keys(allTok).filter(function (t) { return !common[t]; });
  if (varTok.length) {
    var cname = pickClassName(n0, varTok);
    n0.__varClass = { name: cname, constTok: Object.keys(common) };
    vars.push({ kind: 'class', name: cname, node: n0,
      values: classSets.map(function (s) {
        return s.filter(function (t) { return !common[t]; }).join(' ');
      }) });
  }
  // non-class attrs
  var attrNames = {};
  nodes.forEach(function (nd) {
    Object.keys(nd.attrs).forEach(function (a) { if (a !== 'class') attrNames[a] = 1; });
  });
  Object.keys(attrNames).sort().forEach(function (a) {
    var vals = nodes.map(function (nd) {
      return Object.prototype.hasOwnProperty.call(nd.attrs, a) ? nd.attrs[a] : null;
    });
    if (distinct(vals) > 1) {
      var nm = pickAttrName(a);
      (n0.__varAttr || (n0.__varAttr = {}))[a] = nm;
      vars.push({ kind: 'attr', name: nm, attr: a, node: n0, values: vals });
    }
  });
  // direct text
  var txt = nodes.map(directText);
  if (distinct(txt) > 1) {
    var tn = pickTextName(n0);
    n0.__varText = tn;
    vars.push({ kind: 'text', name: tn, node: n0, values: txt });
  }
}

function diffNodes(members, slot) {
  // members: element nodes sharing tag tree on the fixed frame; annotates
  // members[0]. `slot` = {pre,suf} aligns suffix children from the end,
  // since slotted members have different middle-child counts.
  var vars = [];
  function recur(nodes, slotInfo) {
    diffOne(nodes, vars);
    var ek = nodes.map(elemKids);
    if (slotInfo) {
      for (var p = 0; p < slotInfo.pre; p++) {
        recur(ek.map(function (a) { return a[p]; }), null); // eslint-disable-line
      }
      for (var k = 0; k < slotInfo.suf; k++) {
        recur(ek.map(function (a) { return a[a.length - 1 - k]; }), null); // eslint-disable-line
      }
    } else {
      var count = ek[0].length;
      for (var c = 0; c < count; c++) {
        recur(ek.map(function (a) { return a[c]; }), null); // eslint-disable-line
      }
    }
  }
  recur(members, slot || null);
  return vars;
}

/* ── candidate builders ──────────────────────────────────────────────────── */
var candidates = [];
function avg(arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; }

function buildPlain(groups, tier) {
  Object.keys(groups).forEach(function (k) {
    var members = groups[k];
    if (members.length < 2) return;
    _names = {};
    var vars = (tier === 'exact') ? [] : diffNodes(members);
    var occLines = members.map(lineSpan);
    var fixedLines = avg(occLines);
    var saved = Math.round((members.length - 1) * fixedLines - members.length);
    if (saved < MIN_SAVED) return;
    candidates.push({
      tier: tier, root: members[0],
      members: members.map(function (m) {
        return { file: m.file, line: m.line, endLine: m.endLine, node: m };
      }),
      memberIds: members.map(function (m) { return m.id; }),
      vars: vars, slot: null, size: members[0].size,
      occLines: occLines, saved: saved
    });
  });
}

function allSame(arr) { return arr.every(function (x) { return x === arr[0]; }); }
function middleSize(node, pre, suf) {
  var ek = elemKids(node), s = 0;
  for (var i = pre; i < ek.length - suf; i++) s += ek[i].size;
  return s;
}

/* climb single-element-child ancestors so a slotted candidate's root is the
   real boundary (e.g. .rp-modal -> .rp-modal-overlay). Promotes only as far
   as every member shares the same ancestor tag at each level. */
function promotionChains(members) {
  var chains = members.map(function (m) {
    var ch = [], cur = m.parent;
    while (cur && cur.type === 'element' && elemKids(cur).length === 1) {
      ch.push(cur); cur = cur.parent;          // bottom-up
    }
    return ch;
  });
  var levels = Math.min.apply(null, chains.map(function (c) { return c.length; }));
  for (var lvl = 0; lvl < levels; lvl++) {
    if (!allSame(chains.map(function (c) { return c[lvl].tag; }))) { levels = lvl; break; }
  }
  return chains.map(function (c) { return c.slice(0, levels); });
}

function buildSlotted() {
  var kinds = groupBy(allEls.filter(function (e) {
    return firstClass(e) && elemKids(e).length >= 2;
  }), function (e) { return e.tag + '.' + firstClass(e); });

  Object.keys(kinds).forEach(function (key) {
    // sub-group by (first-child, last-child) struct signature so a few odd
    // members can't zero out the common chrome for the whole kind.
    var subs = groupBy(kinds[key], function (e) {
      var ek = elemKids(e);
      return ek[0].structHash + '|' + ek[ek.length - 1].structHash;
    });

    Object.keys(subs).forEach(function (sk) {
      var members = subs[sk];
      if (members.length < 2) return;
      var kids = members.map(elemKids);
      var minLen = Math.min.apply(null, kids.map(function (a) { return a.length; }));
      var pre = 0;
      while (pre < minLen && allSame(kids.map(function (a) { return a[pre].structHash; }))) pre++;
      var suf = 0;
      while (suf < minLen - pre &&
             allSame(kids.map(function (a) { return a[a.length - 1 - suf].structHash; }))) suf++;
      if (pre + suf < MIN_CHROME) return;
      var midSig = members.map(function (m, mi) {
        var a = kids[mi];
        return a.slice(pre, a.length - suf).map(function (c) { return c.structHash; }).join(',');
      });
      if (distinct(midSig) < 2) return; // middle identical -> struct cluster covers it

      // promote root up through single-child ancestors
      var chains = promotionChains(members);
      var roots = members.map(function (m, mi) {
        return chains[mi].length ? chains[mi][chains[mi].length - 1] : m;
      });

      var fixedSize = roots[0].size - middleSize(members[0], pre, suf);
      if (fixedSize < MIN_NODES) return;

      _names = {};
      var rk = elemKids(members[0]);
      var vars = diffNodes(members, { pre: pre, suf: suf });
      // diff the promotion chain levels (each a single-child wrapper)
      if (chains[0].length) {
        for (var lvl = 0; lvl < chains[0].length; lvl++) {
          diffOne(chains.map(function (c) { return c[lvl]; }), vars); // eslint-disable-line
        }
      }

      var slotName = uniqName('body');
      members[0].__slotRange = { start: pre, end: rk.length - suf, name: slotName };

      var occLines = roots.map(lineSpan);
      var slotLines = members.map(function (m, mi) {
        var a = kids[mi], mid = a.slice(pre, a.length - suf);
        if (!mid.length) return 0;
        return Math.max(0, mid[mid.length - 1].endLine - mid[0].line + 1);
      });
      var fixedLines = avg(occLines.map(function (l, i2) { return l - slotLines[i2]; }));
      var saved = Math.round((members.length - 1) * fixedLines - members.length);
      if (saved < MIN_SAVED) return;

      candidates.push({
        tier: 'slotted', root: roots[0],
        members: roots.map(function (m, mi) {
          return { file: m.file, line: m.line, endLine: m.endLine, node: m,
                   slotLines: slotLines[mi] };
        }),
        memberIds: roots.map(function (m) { return m.id; }),
        vars: vars, slot: { name: slotName, pre: pre, suf: suf },
        size: fixedSize, occLines: occLines, saved: saved
      });
    });
  });
}

buildPlain(exactGroups, 'exact');
buildPlain(classGroups, 'class');
buildPlain(structGroups, 'struct');
buildSlotted();

/* ── dedupe identical member-sets, keep strongest tier ───────────────────── */
var TIER_RANK = { exact: 4, class: 3, struct: 2, slotted: 1 };
(function dedupe() {
  var bySet = {};
  candidates.forEach(function (c) {
    var key = c.memberIds.slice().sort(function (a, b) { return a - b; }).join(',');
    var prev = bySet[key];
    if (!prev || TIER_RANK[c.tier] > TIER_RANK[prev.tier]) bySet[key] = c;
  });
  candidates = Object.keys(bySet).map(function (k) { return bySet[k]; });
})();

/* ── maximality: drop a candidate fully nested in a bigger/equal one ─────── */
(function maximality() {
  var memberOf = {};
  candidates.forEach(function (c, ci) {
    c.memberIds.forEach(function (id) { (memberOf[id] || (memberOf[id] = [])).push(ci); });
  });
  function ancestorIds(node) {
    var ids = [], p = node.parent;
    while (p) { if (p.id) ids.push(p.id); p = p.parent; }
    return ids;
  }
  var drop = {};
  candidates.forEach(function (c, ci) {
    var dominated = c.members.every(function (m) {
      return ancestorIds(m.node).some(function (aid) {
        return (memberOf[aid] || []).some(function (cj) {
          if (cj === ci || drop[cj]) return false;
          var o = candidates[cj];
          return o.members.length >= c.members.length && o.size > c.size;
        });
      });
    });
    if (dominated) drop[ci] = 1;
  });
  candidates = candidates.filter(function (c, ci) { return !drop[ci]; });
})();

/* ── component name + skeleton + call-site ───────────────────────────────── */
function compName(root) {
  var base = (firstClass(root) || root.tag).replace(/^rp-/, '').replace(/^sp-/, '');
  return base || root.tag;
}
function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function escText(s) {
  return String(s).replace(/[<>&]/g, function (c) {
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
  });
}

function skeleton(cand) {
  var out = [];
  function ser(node, depth) {
    var pad = '  '.repeat(depth);
    if (node.type === 'comment') return;
    if (node.type === 'text') {
      var t = node.value.replace(/\s+/g, ' ').trim();
      if (t) out.push(pad + escText(t));
      return;
    }
    if (node.type !== 'element') return;
    var attrParts = [];
    if (node.__varClass) {
      var ct = node.__varClass.constTok.slice();
      ct.push('{{' + node.__varClass.name + '}}');
      attrParts.push('class="' + ct.join(' ').trim() + '"');
    } else if (node.attrs['class'] !== undefined) {
      attrParts.push('class="' + escAttr(node.attrs['class']) + '"');
    }
    Object.keys(node.attrs).forEach(function (a) {
      if (a === 'class') return;
      if (node.__varAttr && node.__varAttr[a]) {
        attrParts.push(a + '="{{' + node.__varAttr[a] + '}}"');
      } else {
        attrParts.push(a + '="' + escAttr(node.attrs[a]) + '"');
      }
    });
    var open = '<' + node.tag + (attrParts.length ? ' ' + attrParts.join(' ') : '');
    if (VOID[node.tag]) { out.push(pad + open + ' />'); return; }
    open += '>';
    var hasKids = node.children.some(function (c) {
      return c.type === 'element' || (c.type === 'text' && c.value.trim());
    });
    if (!hasKids) { out.push(pad + open + '</' + node.tag + '>'); return; }
    out.push(pad + open);
    var cpad = '  '.repeat(depth + 1);
    var slotR = node.__slotRange, elemIdx = 0, emittedSlot = false, emittedText = false;
    node.children.forEach(function (c) {
      if (c.type === 'element') {
        if (slotR && elemIdx >= slotR.start && elemIdx < slotR.end) {
          if (!emittedSlot) {
            out.push(cpad + '<slot name="' + slotR.name + '"></slot>');
            emittedSlot = true;
          }
          elemIdx++; return;
        }
        elemIdx++; ser(c, depth + 1);
      } else if (c.type === 'text') {
        if (node.__varText) {
          if (!c.blank && !emittedText) {
            out.push(cpad + '{{' + node.__varText + '}}');
            emittedText = true;
          }
        } else { ser(c, depth + 1); }
      } else { ser(c, depth + 1); }
    });
    out.push(pad + '</' + node.tag + '>');
  }
  ser(cand.root, 0);
  return out.join('\n');
}

function callSite(cand) {
  var name = compName(cand.root);
  var props = {};
  cand.vars.forEach(function (v) { props[v.name] = v.values[0]; });
  var propStr = Object.keys(props).length
    ? " data-props='" + JSON.stringify(props).replace(/'/g, '&#39;') + "'"
    : '';
  if (cand.slot) {
    return '<div data-include="components/' + name + '.html"' + propStr + '>\n'
      + '  <template data-slot="' + cand.slot.name + '">…</template>\n'
      + '</div>';
  }
  return '<div data-include="components/' + name + '.html"' + propStr + '></div>';
}

/* ── shape the report payload ────────────────────────────────────────────── */
candidates.forEach(function (c) {
  c.name = compName(c.root);
  c.label = c.root.tag + (firstClass(c.root) ? '.' + firstClass(c.root) : '');
  var fileSet = {};
  c.members.forEach(function (m) { fileSet[m.file] = 1; });
  c.fileCount = Object.keys(fileSet).length;
  c.skeletonText = skeleton(c);
  c.callSiteText = callSite(c);
});
candidates.sort(function (a, b) {
  return (b.saved - a.saved) || (b.members.length - a.members.length);
});

/* per-file duplication coverage */
var fileCover = {};
fileMeta.forEach(function (f) { fileCover[f.path] = []; });
candidates.forEach(function (c) {
  c.members.forEach(function (m) {
    if (fileCover[m.file]) fileCover[m.file].push([m.line, m.endLine || m.line, c.name]);
  });
});
var byFile = fileMeta.map(function (f) {
  var iv = fileCover[f.path].slice().sort(function (a, b) { return a[0] - b[0]; });
  var covered = 0, end = 0, names = {};
  iv.forEach(function (r) {
    names[r[2]] = 1;
    var s = Math.max(r[0], end + 1), e = r[1];
    if (e >= s) { covered += e - s + 1; end = e; }
    else if (r[1] > end) end = r[1];
  });
  return {
    path: f.path, lines: f.lines, covered: covered,
    pct: f.lines ? Math.round(covered / f.lines * 100) : 0,
    candidates: Object.keys(names).length
  };
}).sort(function (a, b) { return b.pct - a.pct; });

var data = {
  generatedAt: new Date().toISOString(),
  partialsDir: PARTIALS_DIR,
  stats: {
    files: fileMeta.length,
    elements: allEls.length,
    candidates: candidates.length,
    slotted: candidates.filter(function (c) { return c.tier === 'slotted'; }).length,
    totalSaved: candidates.reduce(function (n, c) { return n + Math.max(0, c.saved); }, 0),
    biggest: candidates.length ? candidates[0].name : '—'
  },
  candidates: candidates.map(function (c) {
    return {
      name: c.name, label: c.label, tier: c.tier,
      occ: c.members.length, fileCount: c.fileCount, size: c.size,
      lines: Math.round(avg(c.occLines)), saved: c.saved,
      propCount: c.vars.length, hasSlot: !!c.slot,
      members: c.members.map(function (m) {
        return { file: m.file, line: m.line, endLine: m.endLine || m.line };
      }),
      props: c.vars.map(function (v) {
        return { name: v.name, kind: v.kind, attr: v.attr || '',
          values: v.values.map(function (x) { return x === null ? '∅' : String(x); }) };
      }),
      slot: c.slot ? c.slot.name : null,
      skeleton: c.skeletonText,
      callSite: c.callSiteText
    };
  }),
  byFile: byFile
};

fs.writeFileSync(OUT, renderHtml(data), 'utf8');

console.log('');
console.log('  files scanned        ' + data.stats.files);
console.log('  element nodes        ' + data.stats.elements);
console.log('  component candidates ' + data.stats.candidates
  + '  (' + data.stats.slotted + ' slotted)');
console.log('  est. lines saved     ~' + data.stats.totalSaved);
console.log('  biggest win          ' + data.stats.biggest);
console.log('');
console.log('  report -> ' + OUT);

/* ── HTML report ─────────────────────────────────────────────────────────── */
function renderHtml(d) {
  var json = JSON.stringify(d).replace(/<\//g, '<\\/');
  return [
'<!doctype html>',
'<html lang="en"><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>RedPash HTML component audit</title>',
'<style>' + CSS + '</style>',
'</head><body>',
'<header>',
'  <h1>HTML component audit <span class="muted">· redpash-app</span></h1>',
'  <div class="sub" id="sub"></div>',
'</header>',
'<section class="cards" id="cards"></section>',
'<nav class="tabs">',
'  <button class="tab active" data-tab="cmp">Component candidates</button>',
'  <button class="tab" data-tab="file">By file</button>',
'</nav>',
'<div class="panel" id="panel-cmp">',
'  <div class="toolbar">',
'    <input id="q-cmp" placeholder="Filter by name / tier…" autocomplete="off">',
'    <label class="chk"><input type="checkbox" id="only-multi" checked> 2+ files</label>',
'    <label class="chk"><input type="checkbox" id="only-slot"> slotted only</label>',
'    <span class="count" id="count-cmp"></span>',
'  </div>',
'  <table id="t-cmp"><thead><tr>',
'    <th data-k="name">Component</th>',
'    <th data-k="tier">Tier</th>',
'    <th data-k="occ" class="num">Occ.</th>',
'    <th data-k="fileCount" class="num">Files</th>',
'    <th data-k="size" class="num">Nodes</th>',
'    <th data-k="propCount" class="num">Props</th>',
'    <th data-k="saved" class="num">≈ Lines saved</th>',
'  </tr></thead><tbody></tbody></table>',
'</div>',
'<div class="panel hidden" id="panel-file">',
'  <div class="toolbar"><input id="q-file" placeholder="Filter files…" autocomplete="off">',
'    <span class="count" id="count-file"></span></div>',
'  <table id="t-file"><thead><tr>',
'    <th data-k="path">File</th>',
'    <th data-k="lines" class="num">Lines</th>',
'    <th data-k="covered" class="num">Dup lines</th>',
'    <th data-k="pct" class="num">Dup %</th>',
'    <th data-k="candidates" class="num">Components</th>',
'  </tr></thead><tbody></tbody></table>',
'</div>',
'<script>var DATA=' + json + ';</script>',
'<script>' + JS + '</script>',
'</body></html>'
  ].join('\n');
}

/* ── report stylesheet ───────────────────────────────────────────────────── */
var CSS = `
:root{--bg:#0d1117;--panel:#11161f;--panel2:#161c28;--line:#222b3a;
  --text:#d6dbe5;--muted:#7c8699;--accent:#b3001b;--accent2:#5b8cff;
  --bad:#ff5d6c;--warn:#e0a64b;--ok:#3fb56b;--slot:#c08bff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
header{padding:22px 26px 14px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.muted{color:var(--muted);font-weight:400}
.sub{margin-top:4px;color:var(--muted);font-size:12px}
.cards{display:flex;flex-wrap:wrap;gap:10px;padding:16px 26px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:10px 14px;min-width:120px}
.card .n{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.card .l{font-size:11px;color:var(--muted);margin-top:2px}
.card.ok .n{color:var(--ok)} .card.slot .n{color:var(--slot)}
.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--line)}
.tab{background:none;border:0;color:var(--muted);padding:10px 14px;cursor:pointer;
  font-size:13px;border-bottom:2px solid transparent}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.panel{padding:14px 26px 80px}
.panel.hidden{display:none}
.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:10px;flex-wrap:wrap}
#q-cmp,#q-file{background:var(--panel2);border:1px solid var(--line);color:var(--text);
  border-radius:8px;padding:7px 11px;width:300px;font-size:13px}
.chk{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:5px;
  cursor:pointer;user-select:none}
.count{color:var(--muted);font-size:12px;margin-left:auto}
table{width:100%;border-collapse:collapse}
thead th{position:sticky;top:0;background:var(--panel);text-align:left;z-index:2;
  font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  padding:9px 10px;border-bottom:1px solid var(--line);cursor:pointer;
  user-select:none;white-space:nowrap}
th.num{text-align:right}
th.sorted{color:var(--text)}
th.sorted::after{content:" ▾";color:var(--accent2)}
th.sorted.asc::after{content:" ▴"}
tbody tr.row{border-bottom:1px solid var(--line);cursor:pointer}
tbody tr.row:hover{background:var(--panel)}
tbody td{padding:7px 10px;vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.cname{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;
  color:#e6ebf2;font-weight:600}
.label{color:var(--muted);font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace}
.tier{display:inline-block;padding:1px 7px;border-radius:6px;font-size:10px;
  font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.tier-exact{background:rgba(63,181,107,.16);color:var(--ok)}
.tier-class{background:rgba(91,140,255,.16);color:var(--accent2)}
.tier-struct{background:rgba(224,166,75,.16);color:var(--warn)}
.tier-slotted{background:rgba(192,139,255,.16);color:var(--slot)}
.detail td{background:var(--panel2);padding:14px 18px}
.dgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:1100px){.dgrid{grid-template-columns:1fr}}
.dsec{margin-bottom:6px}
.dh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
  margin-bottom:6px}
.lrow{font-size:12px;padding:2px 0;font-family:ui-monospace,Menlo,Consolas,monospace}
.prop{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent2);
  border-radius:7px;padding:6px 9px;margin-bottom:6px}
.prop.k-class{border-left-color:var(--slot)}
.prop.k-text{border-left-color:var(--warn)}
.pname{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:600}
.pkind{color:var(--muted);font-size:10px;text-transform:uppercase;margin-left:5px}
.pvals{font-size:11px;color:#aab3c2;font-family:ui-monospace,Menlo,Consolas,monospace;
  margin-top:3px;max-height:74px;overflow:auto}
.pvals span{display:inline-block;background:var(--panel2);border:1px solid var(--line);
  border-radius:5px;padding:0 5px;margin:2px 3px 0 0}
pre{background:#0a0e15;border:1px solid var(--line);border-radius:8px;padding:11px 13px;
  font-size:11.5px;line-height:1.55;overflow:auto;margin:0;color:#cbd3e1;
  font-family:ui-monospace,Menlo,Consolas,monospace;max-height:360px}
pre .must{color:var(--warn)} pre .slot{color:var(--slot);font-weight:700}
.bar{height:6px;background:var(--panel);border-radius:3px;overflow:hidden;
  display:inline-block;width:90px;vertical-align:middle;margin-right:7px}
.bar i{display:block;height:100%;background:var(--accent2)}
.empty{padding:40px;text-align:center;color:var(--muted)}
a{color:var(--accent2);text-decoration:none}
`;

/* ── report client script (browser; no template literals / no dollar-brace) ─ */
var JS = [
"(function(){",
"'use strict';var D=DATA;",
"function esc(s){return String(s).replace(/[&<>\\\"]/g,function(c){",
"  return({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;'})[c];});}",
"function hl(s){return esc(s).replace(/\\{\\{([^}]+)\\}\\}/g,",
"  '<span class=\\\"must\\\">{{$1}}</span>')",
"  .replace(/(&lt;slot[^&]*&gt;&lt;\\/slot&gt;)/g,'<span class=\\\"slot\\\">$1</span>');}",
"",
"document.getElementById('sub').textContent=",
"  D.partialsDir+'  —  generated '+new Date(D.generatedAt).toLocaleString();",
"var cards=[['Files',D.stats.files,''],['Element nodes',D.stats.elements,''],",
"  ['Component candidates',D.stats.candidates,'ok'],",
"  ['Slotted (shells)',D.stats.slotted,'slot'],",
"  ['Est. lines saved','~'+D.stats.totalSaved,'ok']];",
"document.getElementById('cards').innerHTML=cards.map(function(c){",
"  return '<div class=\\\"card '+c[2]+'\\\"><div class=\\\"n\\\">'+c[1]+",
"   '</div><div class=\\\"l\\\">'+c[0]+'</div></div>';}).join('');",
"",
"var tabs=document.querySelectorAll('.tab');",
"for(var ti=0;ti<tabs.length;ti++){tabs[ti].addEventListener('click',function(){",
"  for(var j=0;j<tabs.length;j++)tabs[j].classList.remove('active');",
"  this.classList.add('active');var t=this.getAttribute('data-tab');",
"  document.getElementById('panel-cmp').classList.toggle('hidden',t!=='cmp');",
"  document.getElementById('panel-file').classList.toggle('hidden',t!=='file');});}",
"",
"function sortRows(rows,st){rows.sort(function(a,b){var k=st.k,d;",
"  if(typeof a[k]==='string')d=a[k].localeCompare(b[k]);else d=a[k]-b[k];",
"  return st.asc?d:-d;});return rows;}",
"function wireSort(id,st,re){var ths=document.querySelectorAll('#'+id+' thead th');",
"  function paint(){for(var i=0;i<ths.length;i++){ths[i].classList.remove('sorted','asc');",
"    if(ths[i].getAttribute('data-k')===st.k){ths[i].classList.add('sorted');",
"      if(st.asc)ths[i].classList.add('asc');}}}",
"  for(var i=0;i<ths.length;i++){(function(th){th.addEventListener('click',function(){",
"    var k=th.getAttribute('data-k');",
"    if(st.k===k)st.asc=!st.asc;else{st.k=k;st.asc=(k==='name'||k==='path'||k==='tier');}",
"    paint();re();});})(ths[i]);}paint();}",
"function expandable(tr,det){tr.addEventListener('click',function(){",
"  det.style.display=det.style.display==='none'?'':'none';});}",
"",
"var cmpSort={k:'saved',asc:false};",
"function cmpDetail(r){",
"  var occ=r.members.map(function(m){return '<div class=\\\"lrow\\\">'+",
"    esc(m.file)+':'+m.line+'-'+m.endLine+'</div>';}).join('');",
"  var props=r.props.length?r.props.map(function(p){",
"    var vals=p.values.map(function(v){return '<span>'+esc(v||'∅')+'</span>';}).join('');",
"    return '<div class=\\\"prop k-'+p.kind+'\\\"><span class=\\\"pname\\\">'+",
"      esc(p.name)+'</span><span class=\\\"pkind\\\">'+p.kind+",
"      (p.attr?' · '+esc(p.attr):'')+'</span><div class=\\\"pvals\\\">'+vals+",
"      '</div></div>';}).join(''):'<div class=\\\"lrow\\\">no props — identical</div>';",
"  var slot=r.slot?'<div class=\\\"prop k-class\\\"><span class=\\\"pname\\\">'+",
"    esc(r.slot)+'</span><span class=\\\"pkind\\\">slot</span></div>':'';",
"  return '<div class=\\\"dgrid\\\">'+",
"    '<div><div class=\\\"dsec\\\"><div class=\\\"dh\\\">Occurrences ('+r.occ+",
"      ')</div>'+occ+'</div>'+",
"    '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">Proposed props / slots</div>'+",
"      slot+props+'</div></div>'+",
"    '<div><div class=\\\"dsec\\\"><div class=\\\"dh\\\">Component skeleton — '+",
"      'components/'+esc(r.name)+'.html</div><pre>'+hl(r.skeleton)+'</pre></div>'+",
"    '<div class=\\\"dsec\\\"><div class=\\\"dh\\\">Example call-site</div><pre>'+",
"      hl(r.callSite)+'</pre></div></div></div>';}",
"function renderCmp(){",
"  var q=document.getElementById('q-cmp').value.toLowerCase().trim();",
"  var oM=document.getElementById('only-multi').checked;",
"  var oS=document.getElementById('only-slot').checked;",
"  var rows=D.candidates.filter(function(r){",
"    if(oM&&r.fileCount<2)return false;",
"    if(oS&&r.tier!=='slotted')return false;",
"    if(q&&(r.name+' '+r.label+' '+r.tier).toLowerCase().indexOf(q)<0)return false;",
"    return true;});",
"  sortRows(rows,cmpSort);",
"  document.getElementById('count-cmp').textContent=rows.length+' of '+",
"    D.candidates.length+' shown';",
"  var tb=document.querySelector('#t-cmp tbody');tb.innerHTML='';",
"  if(!rows.length){tb.innerHTML='<tr><td colspan=7 class=empty>No matches.</td></tr>';return;}",
"  rows.forEach(function(r){",
"    var tr=document.createElement('tr');tr.className='row';",
"    tr.innerHTML='<td><span class=\\\"cname\\\">'+esc(r.name)+'</span>'+",
"      (r.hasSlot?' <span class=\\\"tier tier-slotted\\\">slot</span>':'')+",
"      '<div class=\\\"label\\\">'+esc(r.label)+'</div></td>'+",
"      '<td><span class=\\\"tier tier-'+r.tier+'\\\">'+r.tier+'</span></td>'+",
"      '<td class=num>'+r.occ+'</td><td class=num>'+r.fileCount+'</td>'+",
"      '<td class=num>'+r.size+'</td><td class=num>'+r.propCount+'</td>'+",
"      '<td class=num>'+r.saved+'</td>';",
"    var det=document.createElement('tr');det.className='detail';det.style.display='none';",
"    det.innerHTML='<td colspan=7>'+cmpDetail(r)+'</td>';",
"    expandable(tr,det);tb.appendChild(tr);tb.appendChild(det);});}",
"",
"var fileSort={k:'pct',asc:false};",
"function renderFile(){",
"  var q=document.getElementById('q-file').value.toLowerCase().trim();",
"  var rows=D.byFile.filter(function(r){return !q||r.path.toLowerCase().indexOf(q)>=0;});",
"  sortRows(rows,fileSort);",
"  document.getElementById('count-file').textContent=rows.length+' files';",
"  var tb=document.querySelector('#t-file tbody');tb.innerHTML='';",
"  rows.forEach(function(r){",
"    var tr=document.createElement('tr');tr.className='row';",
"    tr.innerHTML='<td><span class=\\\"cname\\\">'+esc(r.path)+'</span></td>'+",
"      '<td class=num>'+r.lines+'</td><td class=num>'+r.covered+'</td>'+",
"      '<td class=num><span class=\\\"bar\\\"><i style=\\\"width:'+r.pct+'%\\\"></i>'+",
"      '</span>'+r.pct+'%</td><td class=num>'+r.candidates+'</td>';",
"    tb.appendChild(tr);});}",
"",
"document.getElementById('q-cmp').addEventListener('input',renderCmp);",
"document.getElementById('only-multi').addEventListener('change',renderCmp);",
"document.getElementById('only-slot').addEventListener('change',renderCmp);",
"document.getElementById('q-file').addEventListener('input',renderFile);",
"wireSort('t-cmp',cmpSort,renderCmp);wireSort('t-file',fileSort,renderFile);",
"renderCmp();renderFile();",
"})();"
].join("\n");
