#!/usr/bin/env node
// ─── memory-gc ──────────────────────────────────────────────────────
// Read-only staleness detector for the shared Torv auto-memory store.
// Em 2026-05-29: "we need some kind of garbage collector to wipe out
// old memories." This is the SAFE half — it FLAGS candidates; it never
// deletes (deletion stays human-gated, per the data-loss caution from
// the same conversation). "Old" ≠ "garbage": durable principles
// (commit-convention, no-code-debt) are ancient but evergreen, so age
// is a weak signal — supersession / orphaning / contradiction are the
// strong ones.
//
// Signals (each finding names the file + why it's a candidate):
//   orphan        — .md file not referenced in MEMORY.md (lost from the index)
//   broken-index  — MEMORY.md points at a file that doesn't exist
//   dangling-link — a [[slug]] with no matching `name:` anywhere
//   superseded    — body says superseded / retired / deprecated / "no longer"
//   stale-project — type:project with a past absolute date + pending/deferred
//                   language (an in-flight state that may have resolved)
//   dup-desc      — two memories whose descriptions overlap heavily
//
// Read-only. No deps. Run:
//   node tools/memory-gc/audit.js [MEMORY_DIR]
// Default MEMORY_DIR: ~/.claude/projects/-home-mansa/memory
// Exits 1 if any hard candidate (orphan / broken-index / dangling /
// superseded) is found — CI-gate parity with the other audits.

"use strict";
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const MEMORY_DIR = process.argv[2]
  || path.join(os.homedir(), ".claude/projects/-home-mansa/memory");
const INDEX = "MEMORY.md";
const AGE_REVIEW_DAYS = 21;   // soft "review for currency" threshold

function read(f) { return fs.readFileSync(path.join(MEMORY_DIR, f), "utf8"); }

// frontmatter: grab name / description / type without a YAML dep.
function parseFront(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : "";
  const grab = (k) => (fm.match(new RegExp("^\\s*" + k + ":\\s*\"?(.+?)\"?\\s*$", "m")) || [])[1] || "";
  return { name: grab("name"), description: grab("description"), type: grab("type"), body: src.slice(m ? m[0].length : 0) };
}

function main() {
  if (!fs.existsSync(MEMORY_DIR)) {
    console.error("memory dir not found: " + MEMORY_DIR);
    process.exit(2);
  }
  const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md") && f !== INDEX);
  const indexSrc = fs.existsSync(path.join(MEMORY_DIR, INDEX)) ? read(INDEX) : "";

  // Map files → parsed; collect name-slugs + the index's referenced paths.
  const mem = new Map();           // file → { name, description, type, body, mtime }
  const slugs = new Set();
  for (const f of files) {
    const p = parseFront(read(f));
    p.mtime = fs.statSync(path.join(MEMORY_DIR, f)).mtime;
    mem.set(f, p);
    if (p.name) slugs.add(p.name);
  }
  const indexedFiles = new Set([...indexSrc.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]));

  // A [[link]] resolves to EITHER a name: slug OR a filename-derived slug
  // (foo_bar.md → foo-bar) — both conventions are in live use.
  const resolvable = new Set(slugs);
  for (const f of files) resolvable.add(f.replace(/\.md$/, "").replace(/_/g, "-"));

  const findings = { orphan: [], "broken-index": [], "dangling-link": [], superseded: [], "stale-project": [], "dup-desc": [], "age-review": [] };

  // orphan + broken-index
  for (const f of files) if (!indexedFiles.has(f)) findings.orphan.push(f);
  for (const f of indexedFiles) if (!mem.has(f)) findings["broken-index"].push(f);

  // dangling links — [[slug]] with no matching name:
  const linkRe = /\[\[([a-z0-9-]+)\]\]/g;
  const seen = new Set();
  for (const [f, p] of mem) {
    let m;
    while ((m = linkRe.exec(p.body)) !== null) {
      const slug = m[1];
      if (!resolvable.has(slug) && !seen.has(slug)) {
        seen.add(slug);
        findings["dangling-link"].push(slug + "  (first seen in " + f + ")");
      }
    }
  }

  // superseded — precise: a memory is a deletion candidate only if ANOTHER
  // memory declares it superseded/retired/replaced near a [[link]] to it,
  // or it self-declares obsolete. (Merely *mentioning* that some other
  // thing was retired is not a signal — that over-fired in v1.)
  const supDeclared = new Set();
  const supNear = /(?:supersed|retir|deprecat|replac)\w*[^.\n]{0,60}\[\[([a-z0-9-]+)\]\]|\[\[([a-z0-9-]+)\]\][^.\n]{0,40}(?:supersed|retir|deprecat|replac)\w*/gi;
  for (const [, p] of mem) {
    let m;
    while ((m = supNear.exec(p.body)) !== null) { const s = m[1] || m[2]; if (s) supDeclared.add(s); }
  }
  const selfSup = /this memory (?:is |was )?(?:superseded|obsolete|retired|no longer (?:applies|valid))/i;
  for (const [f, p] of mem) {
    const fileSlug = f.replace(/\.md$/, "").replace(/_/g, "-");
    if ((p.name && supDeclared.has(p.name)) || supDeclared.has(fileSlug) || selfSup.test(p.body)) {
      findings.superseded.push(f);
    }
  }

  // stale-project: type:project, a past YYYY-MM-DD, + in-flight language
  // stale-project — an in-flight state whose NEWEST date is well in the
  // past (>30d): a "pending/deferred" item that hasn't moved in a month
  // is likely resolved or abandoned. An active queue dated last week is
  // NOT stale, so the 30-day floor matters (v1 over-fired on it).
  const STALE_DAYS = 30;
  const staleCutoff = Date.now() - STALE_DAYS * 864e5;
  const flightRe = /\b(pending|deferred|in[- ]progress|upcoming|planned|will land|next big|queued)\b/i;
  for (const [f, p] of mem) {
    if (p.type !== "project") continue;
    const dates = [...p.body.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)].map((d) => new Date(d[1], +d[2] - 1, +d[3]));
    if (!dates.length) continue;
    const newest = new Date(Math.max(...dates));
    if (newest.getTime() < staleCutoff && flightRe.test(p.body)) {
      findings["stale-project"].push(f + "  (newest date " + newest.toISOString().slice(0, 10) + ", >" + STALE_DAYS + "d, in-flight language)");
    }
  }

  // duplicate descriptions — token-overlap (Jaccard) ≥ 0.5
  const tok = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const arr = [...mem.entries()].filter(([, p]) => p.description);
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    const a = tok(arr[i][1].description), b = tok(arr[j][1].description);
    if (a.size < 4 || b.size < 4) continue;
    const inter = [...a].filter((w) => b.has(w)).length;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= 0.5) findings["dup-desc"].push(arr[i][0] + "  ≈  " + arr[j][0] + "  (" + Math.round(jac * 100) + "% desc overlap)");
  }

  // age-review (soft) — mtime older than threshold
  const cutoff = Date.now() - AGE_REVIEW_DAYS * 864e5;
  for (const [f, p] of mem) if (p.mtime.getTime() < cutoff) findings["age-review"].push(f + "  (" + p.mtime.toISOString().slice(0, 10) + ")");

  // ── report ──
  console.log("\n  memory-gc — staleness candidates (read-only; deletion stays human-gated)\n");
  console.log("  store: " + MEMORY_DIR + "  (" + files.length + " memories)\n");
  const hard = ["orphan", "broken-index", "dangling-link", "superseded"];
  const order = [...hard, "stale-project", "dup-desc", "age-review"];
  const label = {
    orphan: "ORPHAN — not in MEMORY.md index",
    "broken-index": "BROKEN INDEX — index points at a missing file",
    "dangling-link": "DANGLING [[link]] — no memory with that name:",
    superseded: "SUPERSEDED — body marks it retired/deprecated (review for deletion)",
    "stale-project": "STALE PROJECT — past-dated in-flight state (may have resolved)",
    "dup-desc": "DUPLICATE? — descriptions overlap heavily (review for merge)",
    "age-review": "AGE REVIEW — untouched > " + AGE_REVIEW_DAYS + "d (currency check; NOT auto-garbage)",
  };
  let hardCount = 0;
  for (const k of order) {
    const list = findings[k];
    if (!list.length) continue;
    if (hard.includes(k)) hardCount += list.length;
    console.log("  " + label[k] + "  [" + list.length + "]");
    for (const item of list) console.log("    - " + item);
    console.log("");
  }
  if (order.every((k) => !findings[k].length)) console.log("  ✓ nothing flagged — store is clean.\n");
  else console.log("  Review the candidates above; nothing was deleted. "
    + (hardCount ? "✗ " + hardCount + " hard candidate(s)." : "✓ no hard candidates (soft flags only).") + "\n");

  process.exit(hardCount ? 1 : 0);
}

main();
