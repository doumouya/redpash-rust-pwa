---
title: <relative source path — e.g. backend/crates/api/src/routes/files/joins.rs>
source: ../../../../<relative path from this doc back to the source file>
owner: Gus | Torv | Em | shared
section: Internal · Code · <Pillar>
last modified date: YYYY-MM-DD
---

<!--
  Template for atomic code docs. Copy this file when authoring a new
  atomic doc; populate the front-matter and the three REQUIRED headings
  (Purpose, Public surface, Drift-prone areas). Other sections may be
  left as `_n/a_` until the file's surface justifies them.

  doc-coverage-audit (tools/doc-coverage-audit/audit.js) parses the
  headings below — if any of the three required ones is missing or has
  a body shorter than ~40 characters, the audit flags it as a stub.

  Plan: ../processes/atomic-doc-plan.md
-->

# <filename>

## Purpose          ← REQUIRED
1–3 paragraphs. WHY this file exists, what problem it solves, what
would break if it were deleted. No code.

## Public surface   ← REQUIRED
Bulleted list of every exported symbol.
- Rust: `pub fn name(args) -> Ret — one-line summary`
- Routes: `METHOD /path — handler — auth posture`
- JS: `export name — shape — callers`

## Internal contracts
Invariants this file assumes about its inputs and guarantees about its
outputs. The "if you touch this, you must preserve…" list.

## Dependencies (upstream)
- Crates / modules imported and what is used from each.
- DB tables / columns touched (backend).
- DOM ids / CSS classes touched (frontend).

## Callers (downstream)
- Who imports this file and which symbol they reach for.
- Cross-tier callers (`api/routes/foo.rs` ← `frontend/scripts/pages/foo.js`)
  — captured by `tools/crossing-audit`; link to its latest finding.

## Drift-prone areas   ← REQUIRED
Places this file is most likely to silently break:
- shape changes shared with `shared/<x>.rs`
- hardcoded ids / paths / route strings that must match X
- ordering / mutex / regex assumptions

## Related docs
- Subsystem: [../../../subsystems/<x>.md]
- Spec: [../../../specs/<x>.md]
- Sibling atoms in the same dir.

## History (optional)
Decomp dates, big rewrites, deprecations.
