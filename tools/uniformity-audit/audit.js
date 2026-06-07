#!/usr/bin/env node
/* Purpose: uniformity guard — fail when a railed page introduces a class whose
   FAMILY is not a sanctioned framework/positioning family (a parallel fork like
   sw-* / rt-*). Baselined: the current follow-on backlog is locked as known;
   only NEW forks fail. This is the guard that would have caught SheetWise's sw-*
   fork on day one.
   Doc: docs/internal/code/tools/uniformity-audit/audit.md
   Usage: node tools/uniformity-audit/audit.js [--baseline]  (--baseline rewrites baseline.json) */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PARTIALS = path.join(ROOT, 'frontend/partials');
const PAGES = path.join(ROOT, 'frontend/scripts/pages');
const BASELINE = path.join(__dirname, 'baseline.json');

// login is divergent BY DESIGN (a centered card, not a railed shell) — out of scope.
const EXCLUDE = new Set(['login.html', 'login.js']);

// SANCTIONED families: the framework (rp), icons (bi), state (is/has), and the
// page POSITIONING families the team has blessed (ws/ds = workspace/designer
// layout — the rp-<page>-* peers that predate the rp- prefix). A NEW family not
// in this set FAILS — adding one must be a DELIBERATE, reviewed edit here, never
// an accidental fork. That review gate is the whole point: SheetWise's sw-* would
// have had to be justified + added here, surfacing the "is this really a new role,
// or a re-skin of an atom?" question before it ever shipped.
const ALLOW_FAMILY = new Set(['rp', 'bi', 'is', 'has', 'tok', 'ws', 'mode']);

// SCOPE: this is a FAMILY gate (foreign prefix family) — the SheetWise class of
// failure. It deliberately does NOT chase rp--prefixed role re-skins
// (rp-profile__id-btn re-skinning rp-btn): a static "embeds a role word" test
// false-positives massively on legit positioning (rp-cases-rail-source,
// rp-seg--rail, rp-cases-chip-row all embed role words but are correct). That
// semantic call belongs to the periodic AGENT uniformity audit, not a static
// rule. Keeping this gate PRECISE (zero false positives) is what makes it
// trustworthy — a shaky guard gets ignored.

function classTokens(text) {
  const out = new Set();
  for (const m of text.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/g))
    m[1].split(/\s+/).forEach((c) => c && out.add(c));
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g))
    for (const s of m[1].matchAll(/["'`]([a-zA-Z][\w-]*)["'`]/g)) out.add(s[1]);
  return [...out];
}

// A class is a "family" only if it's prefixed (has a hyphen). Bare classes
// (open / active / compact / nul …) are states/utilities, not families — skip them.
function foreignFamily(cls) {
  if (!cls.includes('-')) return null;
  const fam = cls.split('-')[0];
  if (!fam || ALLOW_FAMILY.has(fam)) return null;
  return fam;
}

function scan() {
  const found = [];
  for (const d of [PARTIALS, PAGES]) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (EXCLUDE.has(f) || !/\.(html|js)$/.test(f)) continue;
      const page = f;
      const seen = new Set();
      for (const cls of classTokens(fs.readFileSync(path.join(d, f), 'utf8'))) {
        const fam = foreignFamily(cls);
        if (!fam) continue;
        const key = page + '|' + cls;
        if (seen.has(key)) continue; seen.add(key);
        found.push({ page, cls, fam, key });
      }
    }
  }
  return found;
}

const found = scan();
if (process.argv.includes('--baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(found.map((v) => v.key).sort(), null, 2) + '\n');
  console.log(`uniformity: baseline written — ${found.length} known foreign-family classes locked.`);
  process.exit(0);
}

const baseline = new Set(fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : []);
const fresh = found.filter((v) => !baseline.has(v.key));
const known = found.filter((v) => baseline.has(v.key));

const byPage = {};
for (const v of found) {
  (byPage[v.page] ||= { known: 0, fresh: 0 });
  baseline.has(v.key) ? byPage[v.page].known++ : byPage[v.page].fresh++;
}

console.log('\n════════  uniformity-audit  ════════');
console.log('  railed pages scanned   ' + new Set(found.map((v) => v.page)).size + ' (with findings) / scoped partials+pages');
console.log('  known (baselined)      ' + known.length + '   (follow-on backlog — the rt-* legacy tail, etc.)');
console.log('  NEW foreign families   ' + fresh.length + (fresh.length ? '   ✗' : '   ✓'));
if (Object.keys(byPage).length) {
  console.log('\n  per page (foreign-family classes):');
  for (const [p, c] of Object.entries(byPage).sort())
    console.log(`    ${p.padEnd(22)} fresh ${c.fresh}  · known ${c.known}`);
}
if (fresh.length) {
  console.log('\n  ✗ NEW foreign-family classes — a page must compose rp-* atoms, not fork a family:');
  for (const v of fresh) console.log(`      ${v.page}  .${v.cls}   (${v.fam}-* not sanctioned)`);
  console.log('\n  Fix: compose the canonical rp-* atom/component. If this is genuinely page');
  console.log('  POSITIONING (not a role re-skin), name it rp-<page>-* and/or add the family to');
  console.log('  ALLOW_FAMILY in tools/uniformity-audit/audit.js (a deliberate, reviewed act).');
}
console.log('');
process.exit(fresh.length ? 1 : 0);
