#!/usr/bin/env node
/* Purpose: uniformity guard — fail when a page/component introduces a class whose
   FAMILY is not a sanctioned framework/positioning family (a parallel fork like
   sw-* / rt-*). Baselined: any known follow-on backlog is locked; only NEW forks
   fail. This is the guard that would have caught SheetWise's sw-* fork on day one.
   Doc: docs/internal/code/tools/uniformity-audit/audit.md
   Usage: node tools/uniformity-audit/audit.js [--baseline]  (--baseline rewrites baseline.json)

   LEAN ADAPTATION (vs prerelease):
   - Prerelease scanned the flat frontend/partials/*.{html,js} +
     frontend/scripts/pages/*.{html,js} tree (since retired). The lean cut
     co-locates JS+HTML per component/page, so this scans
     frontend/framework/<component>/ and frontend/apps/<app>/<page>/ recursively.
   - Namespace is rp-* (rt-* retired). The sanctioned positioning family is the
     lean pg-<app>-<page>-* page-root family (see ui-fork-audit R1), which
     REPLACES prerelease's ws/ds positioning peers. ws/ds are no longer scoped.
   - login is no longer a top-level file: it lives at apps/auth/login/ and emits
     its own pg-auth-login-* positioning family, so it is in-scope and uniform
     (no special-case exclusion needed). EXCLUDE is kept (empty) as the knob.
   - vendor/ (bootstrap-icons etc.) is NOT walked — only framework + apps. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const FE = path.join(ROOT, 'frontend');
// Lean FE emitter homes: JS+HTML co-located per component/page.
const SCAN_DIRS = [path.join(FE, 'framework'), path.join(FE, 'apps')];
const BASELINE = path.join(__dirname, 'baseline.json');

// Files divergent BY DESIGN — out of scope. In the lean cut login is a normal
// railed app page (apps/auth/login/) emitting its own pg-auth-login-* family,
// so nothing needs excluding; kept as the knob for any future divergent shell.
const EXCLUDE = new Set([]);

// SANCTIONED families: the framework (rp), icons (bi), state (is/has), tokens
// (tok), the theme-mode hook (mode), and the lean page POSITIONING family
// (pg-<app>-<page>-*, the page-root the team has blessed — see ui-fork-audit R1;
// this is the lean replacement for prerelease's ws/ds positioning peers).
// A NEW family not in this set FAILS — adding one must be a DELIBERATE, reviewed
// edit here, never an accidental fork. That review gate is the whole point:
// SheetWise's sw-* would have had to be justified + added here, surfacing the
// "is this really a new role, or a re-skin of an atom?" question before it shipped.
const ALLOW_FAMILY = new Set(['rp', 'bi', 'is', 'has', 'tok', 'pg', 'mode']);

// SCOPE: this is a FAMILY gate (foreign prefix family) — the SheetWise class of
// failure. It deliberately does NOT chase rp--prefixed role re-skins
// (rp-profile__id-btn re-skinning rp-btn) nor pg-* positioning that embeds role
// words: a static "embeds a role word" test false-positives massively on legit
// positioning (pg-admin-cases-rail-source embeds role words but is correct).
// That semantic call belongs to the periodic AGENT uniformity audit, not a
// static rule. Keeping this gate PRECISE (zero false positives) is what makes it
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
// (open / active / compact / bi / nul …) are states/utilities, not families — skip.
function foreignFamily(cls) {
  if (!cls.includes('-')) return null;
  const fam = cls.split('-')[0];
  if (!fam || ALLOW_FAMILY.has(fam)) return null;
  return fam;
}

// Walk a dir recursively, collecting .html/.js leaf files.
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/.test(d.name)) out.push(p);
  }
  return out;
}

function scan() {
  const found = [];
  const files = SCAN_DIRS.reduce((acc, d) => walk(d, acc), []);
  for (const file of files) {
    const base = path.basename(file);
    if (EXCLUDE.has(base)) continue;
    // page key = path relative to frontend/ (unique across co-located trees).
    const page = path.relative(FE, file);
    const seen = new Set();
    for (const cls of classTokens(fs.readFileSync(file, 'utf8'))) {
      const fam = foreignFamily(cls);
      if (!fam) continue;
      const key = page + '|' + cls;
      if (seen.has(key)) continue; seen.add(key);
      found.push({ page, cls, fam, key });
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
console.log('  pages/components scanned  ' + new Set(found.map((v) => v.page)).size + ' (with findings) / frontend/{framework,apps}');
console.log('  known (baselined)         ' + known.length + '   (locked follow-on backlog)');
console.log('  NEW foreign families      ' + fresh.length + (fresh.length ? '   ✗' : '   ✓'));
if (Object.keys(byPage).length) {
  console.log('\n  per file (foreign-family classes):');
  for (const [p, c] of Object.entries(byPage).sort())
    console.log(`    ${p.padEnd(40)} fresh ${c.fresh}  · known ${c.known}`);
}
if (fresh.length) {
  console.log('\n  ✗ NEW foreign-family classes — compose rp-* atoms, do not fork a family:');
  for (const v of fresh) console.log(`      ${v.page}  .${v.cls}   (${v.fam}-* not sanctioned)`);
  console.log('\n  Fix: compose the canonical rp-* atom/component. If this is genuinely page');
  console.log('  POSITIONING (not a role re-skin), name it pg-<app>-<page>-* (apps) and/or add');
  console.log('  the family to ALLOW_FAMILY in tools/uniformity-audit/audit.js (a reviewed act).');
}
console.log('');
process.exit(fresh.length ? 1 : 0);
