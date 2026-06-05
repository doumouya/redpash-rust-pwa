#!/usr/bin/env node
/* Purpose: the design-language migration engine — token-safe rt-*→rp-* rename
   (special atom renames + blanket prefix swap) and a byte-equivalent-twin pruner
   that strips a page sheet's framework-duplicate rules. Reused per slice + Phase C.
   Doc: docs/internal/code/tools/css-twin-verify/migrate.md
   Usage:
     node migrate.js rename <file...>                 # in-place token-safe rt-→rp-
     node migrate.js prune  <page.css> <fw-dir> [extraDeleteRegex]   # drop fw dups */
'use strict';
const fs = require('fs');
const path = require('path');

// ── the NON-straight atom renames (everything else is a straight rt-X→rp-X).
//    longest source token first so rt-btn--accent is consumed before rt-btn, etc.
const SPECIAL = [
  ['rt-panel-tabs--pills', 'rp-panel-tabs-pills'],
  ['rt-icon-btn--sm', 'rp-btn-icon--sm'],
  ['rt-btn--accent', 'rp-btn-icon--accent'],
  ['rt-btn--ghost',  'rp-btn-icon--ghost'],
  ['rt-btn--glass',  'rp-btn-icon--glass'],
  ['rt-btn--text',   'rp-btn-icon--text'],
  ['rt-btn--sm',     'rp-btn-icon--sm'],
  ['rt-panel--filter',  'rp-panel-filter'],
  ['rt-panel--history', 'rp-panel-history'],
  ['rt-panel--tools',   'rp-panel-tools'],
  ['rt-icon-btn',  'rp-btn-icon rp-btn-icon--sq'],
  ['rt-field-lbl', 'rp-label'],
  ['rt-dd-wrap',   'rp-menu-wrap'],
  ['rt-dd-item',   'rp-menu-item'],
  ['rt-chk',       'rp-redtable-chk'],
  ['rt-btn',       'rp-btn-icon'],
  ['rt-dd',        'rp-menu'],
];
const SPECIAL_MAP = new Map(SPECIAL);

// token-by-token rename: each class-token-leading rt-… is matched WHOLE, so an
// exact SPECIAL entry (rt-btn--accent) and the bare rt-btn never collide — no
// longest-first ordering needed. `leave` = family-prefixes to skip (slice
// boundaries, e.g. table/designer/toolbar still owned by a later slice).
function rename(text, leave = []) {
  const leaveRe = leave.length ? new RegExp('^rt-(' + leave.join('|') + ')(-|$)') : null;
  return text.replace(/(?<![a-z0-9-])rt-[a-z0-9-]+/g, (tok) => {
    if (leaveRe && leaveRe.test(tok)) return tok;          // out-of-slice — leave verbatim
    if (SPECIAL_MAP.has(tok)) return SPECIAL_MAP.get(tok); // non-straight atom rename
    return 'rp-' + tok.slice(3);                           // straight prefix swap
  });
}

// ── rule parser shared with verify.js (flat sheets; @-headers skipped) ──
function ruleSpans(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selRaw = m[1];
    const sel = selRaw.trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    const decl = m[2].replace(/\s+/g, ' ').split(';').map(s => s.trim()).filter(Boolean).sort().join('; ');
    // span start = where the trimmed selector begins (skip leading ws/comments handled by caller)
    const start = m.index + (selRaw.length - selRaw.trimStart().length);
    out.push({ sel, decl, start, end: re.lastIndex });
  }
  return out;
}
const norm = s => s.replace(/\b(rt|rp)-/g, 'X-');
const KEYFRAME_STEP = /^(to|from|\d+%?)$/;

function prune(pageFile, fwDir, extra) {
  let css = fs.readFileSync(pageFile, 'utf8');
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length)); // keep offsets
  const fw = new Map();
  for (const f of fs.readdirSync(fwDir).filter(f => f.endsWith('.css'))) {
    // strip framework comments too, so an inline-comment'd decl still matches the page's clean decl
    const fwText = fs.readFileSync(path.join(fwDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const r of ruleSpans(fwText)) {
      const k = norm(r.sel);
      if (!fw.has(k)) fw.set(k, new Set());
      fw.get(k).add(r.decl);
    }
  }
  const extraRe = extra ? new RegExp(extra) : null;
  const spans = ruleSpans(noComments).filter(r => {
    if (KEYFRAME_STEP.test(r.sel)) return false;           // never touch @keyframes innards
    if (extraRe && extraRe.test(r.sel)) return true;        // explicit deletes (the guards)
    const k = norm(r.sel);
    return fw.has(k) && fw.get(k).has(r.decl);              // byte-equivalent framework twin
  });
  // extend each deleted span backwards over its immediately-preceding comment
  // block (+ intervening blank line) so a rule's descriptive comment doesn't
  // orphan once the rule is gone — comment-rot the migration must not leave.
  const eatLeadingComment = (pos) => {
    let i = pos - 1;
    while (i >= 0 && /[ \t\r\n]/.test(css[i])) i--;        // skip ws back to prev token
    if (i >= 1 && css[i] === '/' && css[i - 1] === '*') {   // landed on a '*/'
      const open = css.lastIndexOf('/*', i - 1);
      if (open >= 0) {                                       // consume comment + its own leading ws
        let j = open - 1;
        while (j >= 0 && /[ \t]/.test(css[j])) j--;
        return j + 1;
      }
    }
    return pos;
  };
  // delete back-to-front from the REAL css (offsets align with noComments)
  spans.sort((a, b) => b.start - a.start);
  for (const s of spans) css = css.slice(0, eatLeadingComment(s.start)) + css.slice(s.end);
  fs.writeFileSync(pageFile, css);
  console.log(`pruned ${spans.length} byte-equivalent-twin rules from ${pageFile}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'rename') {
  // optional first arg --leave=a,b,c → family-prefixes left verbatim (slice boundary)
  let leave = [];
  if (rest[0] && rest[0].startsWith('--leave=')) leave = rest.shift().slice(8).split(',').filter(Boolean);
  for (const f of rest) {
    fs.writeFileSync(f, rename(fs.readFileSync(f, 'utf8'), leave));
    console.log('renamed ' + f + (leave.length ? ' (left: ' + leave.join(',') + ')' : ''));
  }
} else if (mode === 'prune') {
  prune(rest[0], rest[1], rest[2]);
} else {
  console.error('usage: migrate.js rename [--leave=a,b,c] <file...> | prune <page.css> <fw-dir> [extraDeleteRegex]');
  process.exit(2);
}
