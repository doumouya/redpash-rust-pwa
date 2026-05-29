# tools/team — the team coordination layer

Three signals so parallel agents don't clobber each other:

1. **commits** — every `git commit` appends one line to
   `Internal-Slack/commits.log` via a `.git/hooks/post-commit` hook.
   Everyone sees who landed what without a DM.
2. **presence** — each agent maintains
   `Internal-Slack/presence/<agent>.md`, listing the paths they have
   under active work (`- frontend/scripts/topbar.js`, `- tools/team`,
   …). They update it when their claim changes.
3. **overlaps** — `tools/team/board.js` reads both, prints the state,
   and **flags any two agents claiming the same path (or a parent /
   child of the other)** as a collision warning.

No daemon, no lock files — append-only markdown plus one shell hook.

## Install (once per clone)

```sh
sh tools/team/install.sh
```

Installs two git hooks: `post-commit` (the commits.log broadcast above)
and `pre-commit` (the correctness gate below). Then write your agent
name into `Internal-Slack/.agent` (one line — `Torv`, `Gus`, `Woz`, …)
so the post-commit hook tags your commits.

## Pre-commit gate

`pre-commit` runs the checks we kept doing by hand, now enforced — each
step fires ONLY when its file kind is staged, so a frontend-only commit
never pays the Rust compile and vice-versa:

1. **Staged frontend `*.js` → ESM syntax** via
   `node --check --input-type=module < file`. Plain `node --check` parses
   `.js` as CommonJS and *silently passes* a broken ES module, so we force
   a module parse — this is what catches the parse-error /
   duplicate-declaration class that blanks the page.
2. **Any frontend `*.js` staged → the js-audit gate** — blocks on an
   extracted anti-pattern (`esc`/`cssEsc` redefinition, themeless
   `echarts.init`, a data endpoint with no `file_type` gate, …). It does
   NOT catch syntax (it skips unparseable files) — step 1 owns that.
3. **Any backend `*.rs` staged → `cargo check -p api`.**

Exit non-zero blocks the commit. Bypass with `git commit --no-verify`
only when you know why (a deliberate WIP stash, a docs-only commit the
gate misreads). The js-audit `report.html` it regenerates is gitignored,
so the hook never dirties the tree.

## Daily use

```sh
node tools/team/board.js     # what's everyone on, any clashes, last 15 commits
sh   tools/team/verify.sh    # commits.log audit: any git commits missing from the log?
```

Before claiming a new folder, run `board.js`. If someone's already
there, hold or pick another lane.

`verify.sh` is the audit-layer check on the log itself — useful when
the shared `Internal-Slack/` directory is also externally synced
(rsync / scp between hosts) and an overwrite-style sync may have
stomped recent hook-written entries. Default scans the last 100 git
commits; `--fix` backfills missing entries with the same line shape
the hook emits. See `sh tools/team/verify.sh --help` for the full
flag set.

## Presence file format

Free-form markdown — only the `- path` lines are parsed as claims; the
rest is human notes. Example:

```
agent:  Torv
branch: frontend-reset
since:  2026-05-23
note:   building the team coordination system.

claims:
- tools/team
- frontend/scripts/topbar.js
```

Clear (or empty) `claims:` when you're done with a chunk so the board
stays honest.
