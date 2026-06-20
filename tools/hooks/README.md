# tools/hooks — tracked git hooks

Version-controlled git hooks + a non-destructive installer (git's `.git/hooks/` isn't tracked, so they live here
and get copied in).

## Install (once per clone)
```
sh tools/hooks/install.sh
```
Copies each hook into `.git/hooks/` (overwriting only that hook). It does **not** set `core.hooksPath`, so any other
installed hook (e.g. the `post-commit` → `commits.log` hook) keeps working.

## Hooks

### `pre-push` — hard-enforces "Case-first by default"
Runs `tools/case-coverage-audit/audit.js` and **blocks the push** if a non-trivial commit since the discipline
install (`0ea7896`) lacks a Case reference. See root `CLAUDE.md` → *Case-first by default*.

- **Scoped to case-coverage only** — it does *not* run the full `ci-audit` ratchet, so unrelated audit drift can
  never wedge a push. (The full ratchet stays ops's job at push time.)
- **Fail-open on infra** — if node is missing, it warns and allows (a tooling blip never blocks a push).
- **Bypass (git's design, use sparingly):** `git push --no-verify`.

A pre-push hook is a strong *local* default, not an absolute wall (`--no-verify` always exists). The truly
un-bypassable gate is **server-side CI** (a GitHub Action running `tools/ci-audit/check.sh` on push/PR) — a separate
lever, blocked today by the audit drift tracked in `CAS_480B4F4836504B51B8A5512874D267DA`.
