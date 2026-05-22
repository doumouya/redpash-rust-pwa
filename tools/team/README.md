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

Then write your agent name into `Internal-Slack/.agent` (one line —
`Torv`, `Gus`, `Woz`, …) so the hook tags your commits.

## Daily use

```sh
node tools/team/board.js     # what's everyone on, any clashes, last 15 commits
```

Before claiming a new folder, run it. If someone's already there,
hold or pick another lane.

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
