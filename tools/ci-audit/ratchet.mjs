#!/usr/bin/env node
/* ratchet.mjs — the file-based regression gate for tools/ci-audit/check.sh.
 *
 * Computes a violation count per tools/*-audit/audit.js, compares it to the
 * committed baseline (tools/ci-audit/baseline.json), and:
 *   - exit 0 when every tool is at or below baseline (fixed / improved /
 *     unchanged are wins, not failures);
 *   - exit 1 with a markdown table when any tool is ABOVE baseline (`new`
 *     regression) or appears with violations but has no baseline entry yet;
 *   - mode `update` rewrites baseline.json from the current counts (exit 0).
 *
 * ── Why a file baseline, not audit.run_diff ─────────────────────────────────
 * Prerelease's ci-audit queried the Postgres audit.run_diff function. Lean
 * has no audit.* schema (it's the Phase-7 "Audits-as-CI ratchet" roadmap
 * item). This file baseline is the interim stand-in with the same
 * new/regressed-only-fail semantics; it retires when the Postgres ratchet
 * lands. See check.sh header.
 *
 * ── Counting a tool's violations ────────────────────────────────────────────
 * Two audit shapes coexist in the lean suite:
 *   - emits audit.json (an array of findings, or {violations|findings: [...]})
 *     → count = array length (read from disk; works in --no-run).
 *   - prints to stderr + exits with the count (e.g. ui-fork-audit)
 *     → count = the process exit code, captured by re-running the audit.
 * We prefer audit.json when present; else fall back to the exit code. */

import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const TOOLS = join(ROOT, "tools");
const BASELINE_PATH = join(HERE, "baseline.json");

const mode = process.argv[2] || "run"; // run | no-run | update

/* ── discover tools/*-audit/audit.js (same glob as the prerelease suite) ──
 * Gated on git-tracked: only audits that are actually part of the tree count
 * toward the CI floor, so the baseline stays reproducible from a fresh clone.
 * In lean today that's tools/ui-fork-audit/ alone; the untracked
 * tools/*-audit/ dirs in the working tree are stale prerelease debris and are
 * deliberately ignored. As Phase-5/7 audits are committed they're picked up
 * automatically — no edit here (matches prerelease's auto-discovery intent). */
function isTracked(file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relative(ROOT, file)], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function discoverAudits() {
  const out = [];
  for (const ent of readdirSync(TOOLS, { withFileTypes: true })) {
    if (!ent.isDirectory() || !ent.name.endsWith("-audit")) continue;
    const dir = join(TOOLS, ent.name);
    const audit = join(dir, "audit.js");
    if (existsSync(audit) && isTracked(audit)) {
      out.push({ tool: basename(ent.name, "-audit"), dir });
    }
  }
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}

/* ── violation count for one tool ── */
function countFor({ dir }) {
  const jsonPath = join(dir, "audit.json");
  if (existsSync(jsonPath)) {
    try {
      const data = JSON.parse(readFileSync(jsonPath, "utf8"));
      const arr = Array.isArray(data)
        ? data
        : data.violations ?? data.findings ?? data.results ?? null;
      if (Array.isArray(arr)) return arr.length;
      if (typeof data.count === "number") return data.count;
    } catch {
      /* malformed json → fall through to exit-code probe */
    }
  }
  // No usable audit.json: re-run the audit and read its exit code (= count).
  // execFileSync throws on non-zero exit; status carries the count.
  try {
    execFileSync("node", [join(dir, "audit.js")], { stdio: "ignore" });
    return 0;
  } catch (e) {
    if (typeof e.status === "number") return e.status;
    throw e; // a real spawn failure, not a violation count
  }
}

const audits = discoverAudits();
const current = {};
for (const a of audits) current[a.tool] = countFor(a);

/* ── update mode: accept current counts as the new baseline ── */
if (mode === "update") {
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(`  ✓ baseline updated (${BASELINE_PATH}):`);
  for (const [t, c] of Object.entries(current)) console.log(`      ${t}: ${c}`);
  process.exit(0);
}

/* ── load baseline ── */
let baseline = {};
if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`ci-audit: baseline.json is malformed — run --update-baseline.`);
    process.exit(2);
  }
} else {
  console.error(
    "ci-audit: no baseline.json. Establish one with:\n" +
      "    sh tools/ci-audit/check.sh --update-baseline"
  );
  process.exit(2);
}

/* ── classify: regression = current > baseline, or no baseline entry ── */
const regressions = [];
for (const [tool, cur] of Object.entries(current)) {
  const prev = baseline[tool];
  if (prev === undefined) {
    if (cur > 0) regressions.push({ tool, status: "new", prev: "—", cur });
  } else if (cur > prev) {
    regressions.push({ tool, status: "regressed", prev, cur });
  }
}

if (regressions.length === 0) {
  console.log("  ✓ no new or regressed findings across audited tools.");
  process.exit(0);
}

/* ── render regressions as a markdown table + exit 1 ── */
console.log("  ✗ regressions detected — see the table below.\n");
console.log("## Audit regressions\n");
console.log(
  "Latest audit run vs the committed baseline (tools/ci-audit/baseline.json). " +
    "`regressed` = more violations than the baseline; `new` = a tool with " +
    "violations and no baseline entry yet. Tools at or below baseline are not " +
    "regressions and don't appear here. After an intentional change, accept " +
    "the new counts with `sh tools/ci-audit/check.sh --update-baseline`.\n"
);
console.log("| Tool | Status | Violations (baseline → current) |");
console.log("|---|---|---|");
for (const r of regressions) {
  console.log(`| ${r.tool} | ${r.status} | ${r.prev} → ${r.cur} |`);
}
console.log("\nDrill into each finding via the tool itself: node tools/<tool>-audit/audit.js");
process.exit(1);
