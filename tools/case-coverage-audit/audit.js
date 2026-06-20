#!/usr/bin/env node
/* Purpose: process audit — every NON-TRIVIAL commit made since the Case-first
 * discipline went live must reference a Case (CAS_… or a `Case:` trailer).
 * Makes "Case-first by default" (root CLAUDE.md) non-bypassable: fail the tool,
 * not Em. The hook is the default-on nudge; this is the wall.
 * Doc: tools/case-coverage-audit/README.md
 *
 * Contract (matches tools/ci-audit/): writes audit.json next to itself and exits
 * with the violation count. tools/ci-audit/check.sh auto-discovers this file;
 * ratchet.mjs grandfathers history via baseline.json ("case-coverage": N) and
 * fails CI only on NEW offenders. CommonJS (tools/ has no "type":"module").
 */
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const HERE = __dirname;
const OUT = join(HERE, "audit.json");

// Commits AFTER this point are post-discipline (the Case-first install commit,
// process: Case-first-by-default). Override with CASE_AUDIT_SINCE=<ref>.
// Pre-discipline history is out of scope by design.
const SINCE = process.env.CASE_AUDIT_SINCE || "0ea7896";

// Subject prefixes that never need a Case (truly trivial / infra / process).
const EXEMPT = /^(chore|docs|style|ci|build|test|meta|process|merge)\b/i;
// A Case reference anywhere in the message: the CAS_ rid, or a `Case:` trailer.
const CASE_REF = /\bCAS_[0-9A-Fa-f]{32}\b/;

const git = (args) => execFileSync("git", args, { cwd: HERE, encoding: "utf8" });
function resolves(ref) {
  try { git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return true; }
  catch { return false; }
}

let findings = [];
let note = null;

if (!resolves(SINCE)) {
  // Fail-open: a missing baseline ref (fresh clone before fetch, a rebased
  // install commit) must NEVER block CI on a config issue. Report 0 + a note.
  note = `CASE_AUDIT_SINCE='${SINCE}' did not resolve — coverage check skipped (fail-open).`;
} else {
  const FS = "\x1f", RS = "\x1e"; // unit / record separators (won't appear in messages)
  const raw = git(["log", `${SINCE}..HEAD`, `--format=%h${FS}%p${FS}%s${FS}%b${RS}`]);
  for (const rec of raw.split(RS)) {
    const r = rec.replace(/^\s+/, "");
    if (!r) continue;
    const [sha, parents = "", subject = "", body = ""] = r.split(FS);
    if (parents.trim().split(/\s+/).filter(Boolean).length > 1) continue; // merge
    if (EXEMPT.test(subject.trim())) continue;                            // exempt prefix
    if (CASE_REF.test(subject) || CASE_REF.test(body)) continue;          // has a Case ref
    findings.push({ sha, subject: subject.trim() });
  }
}

const count = findings.length;
writeFileSync(OUT, JSON.stringify({ tool: "case-coverage", count, since: SINCE, note, findings }, null, 2) + "\n");

if (note) {
  console.log(`case-coverage: ${note}`);
} else if (count === 0) {
  console.log(`case-coverage: 0 — every non-trivial commit since ${SINCE} references a Case ✓`);
} else {
  console.log(`case-coverage: ${count} commit(s) since ${SINCE} with NO Case reference — open a Case and put its CAS_… in the message (amend if unpushed):`);
  for (const f of findings) console.log(`  ${f.sha}  ${f.subject}`);
}
process.exit(Math.min(count, 255));
