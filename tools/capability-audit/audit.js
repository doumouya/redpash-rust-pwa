#!/usr/bin/env node
/* capability-audit — the anti-amnesia gate.
 *
 * The `lean` graduation re-landed from MEMORY (docs/internal/parity-review-2026-06-20.md),
 * so anything unremembered was silently lost. This makes "unremembered = lost" impossible:
 * it extracts the live CAPABILITY MANIFEST from the tree and diffs it against the committed
 * ledger (docs/internal/capability-ledger.md). Findings:
 *   - DROPPED  (High): a capability the ledger lists LIVE has vanished from the tree — a
 *     regression (the graduation class of bug). The ratchet fails on a new one.
 *   - UNDOCUMENTED (Med): a capability in the tree that the ledger doesn't record — forces a
 *     ledger entry at creation, so nothing ever lives only in someone's head.
 * Ledger entries marked `[gap]` / `[lost]` / `[deferred]` are EXPECTED-absent (a known,
 * recorded gap) — not a finding. A `[gap]` key that REappears in the tree is surfaced as a
 * RECOVERED note (update the ledger).
 *
 * Usage:
 *   node tools/capability-audit/audit.js            # diff tree vs ledger → audit.json, exit=count
 *   node tools/capability-audit/audit.js --init     # print the extracted manifest (seed/refresh the ledger)
 *
 * Capability key scheme (category:name), extracted deterministically from the known files:
 *   api-mod:<m>   lib.rs `pub mod`          api-route:<p>  main.rs `.nest("/p")`
 *   db-table:<t>  migrations CREATE TABLE   tool:<d>       tools/<d>/
 *   bin:<n>       api Cargo.toml [[bin]]     data-mod:<m>   data/src/lib.rs `pub mod`
 *   fe-page:<a/p> frontend/apps/<a>/<p>/    skill:<s>      .claude/skills/<s>/ */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const p = (...s) => path.join(ROOT, ...s);
const read = (rel) => {
  try { return fs.readFileSync(p(rel), "utf8"); } catch { return ""; }
};
const dirs = (rel) => {
  try {
    return fs.readdirSync(p(rel), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
};

// ── extract the live capability manifest from the tree ───────────────────────
function extractTree() {
  const caps = new Set();
  const add = (k) => caps.add(k);

  for (const m of read("backend/crates/api/src/lib.rs").matchAll(/^pub mod (\w+);/gm)) add(`api-mod:${m[1]}`);
  for (const m of read("backend/crates/api/src/main.rs").matchAll(/\.nest\(\s*"\/([\w-]+)"/g)) {
    if (m[1] !== "api") add(`api-route:${m[1]}`); // skip the outer /api prefix mount
  }
  for (const m of read("backend/crates/data/src/lib.rs").matchAll(/^pub mod (\w+);/gm)) add(`data-mod:${m[1]}`);

  // db tables across all migrations (consolidated init + follow-ups), incl. schema-qualified
  for (const f of fs.existsSync(p("backend/migrations")) ? fs.readdirSync(p("backend/migrations")) : []) {
    if (!f.endsWith(".sql")) continue;
    for (const m of read(`backend/migrations/${f}`).matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([\w.]+)"?/gi)) {
      const t = m[1].replace(/"/g, "");
      if (!/_default$/.test(t)) add(`db-table:${t}`); // skip partition children
    }
  }

  // tools/<dir> (audits + scripts dirs), excluding infra
  for (const d of dirs("tools")) {
    if (["node_modules", "lib", "ci-audit"].includes(d)) continue;
    add(`tool:${d}`);
  }

  // bins from the api crate manifest ([[bin]] name = "redpash-*")
  for (const m of read("backend/crates/api/Cargo.toml").matchAll(/name\s*=\s*"(redpash-[\w-]+)"/g)) add(`bin:${m[1]}`);

  // frontend pages: frontend/apps/<app>/<page>/
  for (const app of dirs("frontend/apps")) {
    for (const page of dirs(`frontend/apps/${app}`)) add(`fe-page:${app}/${page}`);
  }

  for (const s of dirs(".claude/skills")) add(`skill:${s}`);

  return caps;
}

// ── read the ledger: live keys vs recorded-gap keys ──────────────────────────
const KEY_RE = /`((?:api-mod|api-route|db-table|tool|bin|data-mod|fe-page|skill):[^`]+)`/g;
function readLedger() {
  const text = read("docs/internal/capability-ledger.md");
  const live = new Set();
  const gap = new Set();
  for (const line of text.split("\n")) {
    const isGap = /\[(gap|lost|deferred)\b/i.test(line);
    for (const m of line.matchAll(KEY_RE)) (isGap ? gap : live).add(m[1]);
  }
  return { live, gap, present: text.length > 0 };
}

// ── --init: print the extracted manifest (to seed/refresh the ledger) ─────────
if (process.argv.includes("--init")) {
  const tree = [...extractTree()].sort();
  const byCat = {};
  for (const k of tree) (byCat[k.split(":")[0]] ||= []).push(k);
  for (const cat of Object.keys(byCat).sort()) {
    console.log(`\n## ${cat} (${byCat[cat].length})`);
    for (const k of byCat[cat]) console.log(`- \`${k}\``);
  }
  process.exit(0);
}

// ── diff tree vs ledger ──────────────────────────────────────────────────────
const tree = extractTree();
const { live, gap, present } = readLedger();
const findings = [];

if (!present) {
  findings.push({
    id: "CAP-LEDGER-MISSING", severity: "High", kind: "ledger_missing",
    finding_key: "ledger_missing", title: "No capability ledger",
    detail: "docs/internal/capability-ledger.md is absent — seed it with `node tools/capability-audit/audit.js --init`.",
  });
} else {
  // DROPPED: ledger says LIVE, tree doesn't have it → a capability vanished.
  for (const k of [...live].sort()) {
    if (!tree.has(k)) findings.push({
      id: `CAP-DROP:${k}`, severity: "High", kind: "dropped", finding_key: k,
      title: `Dropped capability: ${k}`,
      detail: `The ledger lists \`${k}\` as live, but it is absent from the tree. Re-land it, or move its ledger line to a recorded gap ([gap]/[lost]/[deferred]) with the reason.`,
    });
  }
  // UNDOCUMENTED: tree has it, ledger has no record at all → add a ledger entry.
  for (const k of [...tree].sort()) {
    if (!live.has(k) && !gap.has(k)) findings.push({
      id: `CAP-UNDOC:${k}`, severity: "Medium", kind: "undocumented", finding_key: k,
      title: `Undocumented capability: ${k}`,
      detail: `\`${k}\` exists in the tree but isn't in the capability ledger. Add it — no capability lives only in memory.`,
    });
  }
  // RECOVERED (info, not counted): a recorded gap reappeared.
  for (const k of [...gap].sort()) {
    if (tree.has(k)) findings.push({
      id: `CAP-RECOVERED:${k}`, severity: "info", kind: "recovered", finding_key: k,
      title: `Recovered capability: ${k}`,
      detail: `\`${k}\` was a recorded gap but is now in the tree — promote its ledger line from a gap to live.`,
      status: "accepted",
    });
  }
}

const counted = findings.filter((f) => f.status !== "accepted");
const accepted = findings.filter((f) => f.status === "accepted");
const bySeverity = counted.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
fs.writeFileSync(
  path.join(__dirname, "audit.json"),
  JSON.stringify(
    { tool: "capability", spec: "tree ↔ capability-ledger lockstep (docs/internal/capability-ledger.md)",
      stats: { gaps: counted.length, accepted: accepted.length, bySeverity, treeCount: tree.size },
      findings: counted, accepted },
    null, 2,
  ) + "\n",
);

if (counted.length) {
  console.error(`capability-audit: ${counted.length} finding(s) — tree ↔ ledger out of sync\n`);
  for (const f of counted) console.error(`  [${f.severity}] ${f.title}`);
} else {
  console.log(`capability-audit: OK — ${tree.size} capabilities, tree ↔ ledger in sync`);
}
process.exit(counted.length);
