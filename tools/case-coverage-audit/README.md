# case-coverage audit

Enforces **Case-first by default** (root `CLAUDE.md`): every *non-trivial* commit made **after** the discipline
went live must reference a Case (`CAS_<32 hex>`, or a `Case: CAS_…` trailer, anywhere in the message). The
`UserPromptSubmit` hook is the default-on nudge; this audit is the wall that makes it non-bypassable — *fail the
tool, not Em.*

## What it checks
Commits in `${CASE_AUDIT_SINCE:-0ea7896}..HEAD` (the install commit is the "discipline starts here" line), **excluding**:
- merge commits (2+ parents), and
- subjects prefixed `chore | docs | style | ci | build | test | meta | process` (truly trivial / infra / process).

Every remaining commit must contain a Case reference. Offenders are reported (short sha + subject).

## Contract
Matches `tools/ci-audit/`: writes `audit.json` = `{ tool, count, since, note, findings }` and exits with the
violation count. Auto-discovered by `tools/ci-audit/check.sh` (globs `tools/*-audit/audit.js`) and ratcheted against
`tools/ci-audit/baseline.json` (`"case-coverage"`). Pre-discipline history is grandfathered by `CASE_AUDIT_SINCE`;
the baseline (0) fails CI on **new** offenders only. **Fail-open:** if `CASE_AUDIT_SINCE` doesn't resolve, it reports
0 + a note (a config issue never blocks CI).

## Fixing a failure
Open a Case (`mcp__redpash-slack__case_create`) and put its `CAS_…` in the commit message (amend if not yet pushed).
Genuine exception: `sh tools/ci-audit/check.sh --update-baseline` after review.

## Run
```
node tools/case-coverage-audit/audit.js
CASE_AUDIT_SINCE=<ref> node tools/case-coverage-audit/audit.js
```
