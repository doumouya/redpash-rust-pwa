#!/usr/bin/env node
/* rail-create-audit — the global rail footer is UNIVERSALS-ONLY.
 *
 * RedPash's create/add affordance is the TOOLBAR "+" (object-list's bi-plus-lg;
 * every list opens its create there). A "New X" button in the rail FOOTER is the
 * predecessor's placement and drifts from that design language — the kind of thing
 * that quietly creeps back when a page copies old code. This audit makes the rule
 * un-driftable: create lives in the toolbar, never the rail footer.
 *
 * Rules (exit code = violation count; also written to audit.json):
 *   RC1 (conduit) frontend/framework/rail/rail-data.js — mountAppRail() is the ONE
 *       place the global rail is built. Its footer must be universals-only:
 *       `universalFooter(null, …)` with no page-supplied create (no `spec.create`
 *       / `spec.onCreate`, no `on.create`). This is the authoritative check — the
 *       footer can't sprout a create button without tripping here.
 *   RC2 (pages) frontend/apps/** — no railSpec carries a footer create: a
 *       `create:` / `onCreate` key inside a `rail:{…}` literal or a `railSpec`
 *       declaration. (object-list's `create:{label,onCreate}` — the toolbar "+" —
 *       lives in a mountObjectList() call, NOT a rail spec, so it's never flagged.)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FE = path.join(ROOT, "frontend");
const CONDUIT = path.join(FE, "framework", "rail", "rail-data.js");
const SKIP_DIRS = new Set(["vendor", "wasm", "dist", "node_modules"]);
const violations = [];

const flag = (file, line, rule, msg) =>
  violations.push({ file: path.relative(ROOT, file), line, rule, msg });

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

// blank out /* */ and // comments (keep newlines) so a comment mentioning
// "create" in a rail spec doesn't false-flag.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), exts, out);
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

// From the `{` at openIdx, return the index just past its matching `}`.
function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

// Char ranges that are rail-spec bodies: each `rail:{…}` literal and each
// `railSpec` declaration body (function or arrow). NOT a `rail: railSpec()` call.
function railSpecRegions(text) {
  const regions = [];
  const starts = [
    /\brail\s*:\s*\{/g, // inline literal passed to assemblePage
    /\b(?:function\s+railSpec\b|(?:const|let|var)\s+railSpec\s*=)/g, // declaration
  ];
  for (const re of starts) {
    let m;
    while ((m = re.exec(text))) {
      const open = text.indexOf("{", m.index);
      if (open === -1) continue;
      regions.push([open, matchBrace(text, open)]);
    }
  }
  return regions;
}

// ── RC1: the conduit ─────────────────────────────────────────────────────────
if (fs.existsSync(CONDUIT)) {
  const raw = stripComments(fs.readFileSync(CONDUIT, "utf8"));
  // the footer-building call (`footer: universalFooter(…)`) must pass `null` —
  // anchored on `footer:` so the `function universalFooter(create, …)` helper
  // definition (whose param is legitimately named `create`) isn't matched.
  for (const m of raw.matchAll(/footer\s*:\s*universalFooter\(\s*(?!null\b)([^,)]*)/g)) {
    flag(CONDUIT, lineOf(raw, m.index), "RC1", `rail footer built with a create arg (\`${m[1].trim()}\`) — must be universalFooter(null, …); create belongs in the toolbar "+"`);
  }
  // a page create forwarded into the footer / handlers
  for (const m of raw.matchAll(/spec\.(?:create|onCreate)\b/g)) {
    flag(CONDUIT, lineOf(raw, m.index), "RC1", "forwards a page-supplied rail-footer create — the global rail footer is universals-only");
  }
}

// ── RC2: app pages ───────────────────────────────────────────────────────────
for (const f of walk(path.join(FE, "apps"), [".js"])) {
  const raw = stripComments(fs.readFileSync(f, "utf8"));
  const regions = railSpecRegions(raw);
  if (!regions.length) continue;
  for (const m of raw.matchAll(/\b(create|onCreate)\s*:/g)) {
    if (regions.some(([a, b]) => m.index >= a && m.index < b)) {
      flag(f, lineOf(raw, m.index), "RC2", `\`${m[1]}\` in a rail spec — create/add belongs in the toolbar "+" (mountObjectList's create), not the rail footer`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(__dirname, "audit.json"), JSON.stringify(violations, null, 2) + "\n");
if (violations.length) {
  console.error(`rail-create-audit: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  [${v.rule}] ${v.file}:${v.line} — ${v.msg}`);
} else {
  console.log("rail-create-audit: OK — rail footer is universals-only; create lives in the toolbar +");
}
process.exit(violations.length);
