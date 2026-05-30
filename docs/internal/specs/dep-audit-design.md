---
title: Dependency-audit — design
section: Internal
order: 41
last modified date: 2026-05-30
---

<!-- Lifted from tools/dep-audit-brainstorming.md (2026-05-30, per
     atomic-doc-plan §10·4). This is a live design spec for the
     dependency & runtime tracking workstream — the dep-audit tool it
     describes is not yet built; this doc IS the spec the build will
     follow. -->

# Dependency-audit — design (dependency & runtime version tracking)

Keep the project's runtimes, toolchains, services and libraries
*current* — incrementally — and make one person's update **reach
everyone** instead of festering into a scary mega-jump.

Trigger: Node went 12 → 22 in a single step. Ten majors at once
compounds every breaking change. Nobody chose to fall behind — there
was simply nothing watching the gap.

Working scratchpad. Final form is a few committed config files + a
`tools/dep-audit` check + a `dev-setup.sh`. This captures the
reasoning and the open calls.

---

## The problem has two layers

| Layer | Question | Hard? |
|---|---|---|
| **Declare** | What version *should* we be on? | Easy — commit a file. |
| **Propagate** | Did every machine (and every *shell*) actually *become* that? | Hard — this is the real ask. |

The Node jump exposed both. There was no declared target (Declare
missing), and even after the update it didn't reach everywhere —
Gus's Bash shell still resolves `node` to v12 while the interactive
zsh sees 22 (Propagate missing). "What version are we on?" currently
has *more than one answer on the same machine*.

---

## Current state (snapshot, 2026-05-21)

| Thing | Installed | Declared? | Freshness tooling |
|---|---|---|---|
| Node | `v22.13.0` (interactive) / `v12.22.9` (non-login shells) | ❌ no `.nvmrc` | none |
| Rust toolchain | `1.95.0` | ❌ no `rust-toolchain.toml` | `rustup check` |
| Rust crates | `Cargo.lock` tracked ✓ | `Cargo.toml` version ranges | ❌ `cargo-outdated` / `cargo-audit` not installed |
| Postgres | `14.22` | ❌ nowhere | — |
| ECharts | `echarts@6` (floating major) + `echarts-stat@1.2.0` | URL pin in `echarts.js` — floating | — |

Nothing has a declared target. `rust-toolchain.toml` and `.nvmrc`
don't exist. The ECharts `@6` is a *floating* major — it silently
moves within v6 on every page load.

---

## Recommended approach — Declared + Reproducible + Gated

### 1. Declare — commit the target versions

| File | Pins | Auto-honored? |
|---|---|---|
| `backend/rust-toolchain.toml` | Rust channel | **Yes** — `cargo` auto-installs + uses it. Zero human action. The model to aim for. |
| `.nvmrc` (repo root) | Node major | Only via `nvm use` / an fnm `--use-on-cd` hook |
| `tools/dep-audit/targets.json` | Postgres major, ECharts version, Node LTS policy — the things with no native pin file | read by the dep-audit tool |
| `docs/dev/environment.md` | human-readable: every target + the *why* | — |

Also: pin ECharts exact (`echarts@6.0.x`) — kill the floating major.

These are committed, so they travel with `git pull` like any code.
`rust-toolchain.toml` is the gold standard — once committed, every
`cargo` invocation just *uses* the right toolchain, no human in the
loop. Node has nothing that good natively; an fnm `--use-on-cd` hook
(auto-switches Node on entering the dir) gets it close.

### 2. Reproduce — `scripts/dev-setup.sh`

One idempotent script that brings any machine (or shell) to the
declared state:
- trigger the Rust toolchain install (any `cargo` command honors `rust-toolchain.toml`);
- `nvm install` / `fnm install` the `.nvmrc` version;
- `cargo install cargo-outdated cargo-audit` if missing;
- `git config core.hooksPath hooks` so the tracked hooks activate;
- check Postgres major against `targets.json` (can't auto-switch PG — warn);
- print a summary.

`docs/dev/setup.md` points at it. After a `git pull` that bumped a
version, you run this. One command, whole environment.

### 3. Gate — `tools/dep-audit` wired as a git hook

The drift detector. Two faces:

- **Human report** — `node tools/dep-audit/audit.js` → an HTML report
  (same zero-dependency pattern as `css-audit` / `html-audit`):
  every runtime/crate, declared vs installed vs latest-available.
- **Machine check** — `node tools/dep-audit/audit.js --check` → text
  + an **exit code** (0 = matches declared, non-zero = drift /
  advisory). This is what the hook keys on.

A tracked `hooks/pre-push` runs `--check`. Proposed strictness:
**warn loudly on version drift** (with the exact fix command),
**block only on a `cargo audit` security advisory**. A hard block on
mere drift when you just need to push a fix is rage-inducing; a loud
warn + the scheduled nudge (below) is enough. Tunable.

What `dep-audit` inspects:
- **Node** — `.nvmrc` target vs `node --version`.
- **Rust toolchain** — `rust-toolchain.toml` vs `rustc --version`; `rustup check` for "channel behind latest stable".
- **Rust crates** — shells out to `cargo outdated` (behind) + `cargo audit` (security advisories against `Cargo.lock`).
- **Postgres** — `psql --version` / `SELECT version()` vs `targets.json`.
- **ECharts** — the pinned version in `echarts.js` vs `targets.json`.

Zero npm dependencies — it shells out to `cargo`/`node`/`psql`. The
`cargo-outdated` / `cargo-audit` subcommands must be installed;
`dev-setup.sh` handles that.

---

## Propagation flow — worked example: bumping Node

1. **Woz** (owns Node) bumps `.nvmrc` `22` → `24` and commits. Per the
   commit convention, the per-file changelog line reads
   `- .nvmrc — Node 22 → 24`.
2. Everyone `git pull`s.
3. `rust-toolchain.toml` (unchanged here) keeps auto-applying — free.
4. The `pre-push` hook on each teammate's next push runs `--check`,
   sees `node 22 ≠ .nvmrc 24`, and prints
   *"Node behind declared target — run `scripts/dev-setup.sh`."*
5. They run it. Done.

The update *reaches* everybody because it's in git **and** the gate
makes ignoring it impossible.

---

## The fully-automatic alternative — devcontainer

The plan above still needs a human to run `dev-setup.sh` (or set up
the fnm cd-hook). The **only** thing that removes the human entirely
— including stale non-login shells like Gus's Bash — is a
**devcontainer**: `.devcontainer/devcontainer.json` + a base image
pinning Node + Rust, Postgres as a `docker-compose` sidecar. VS Code
"Reopen in Container" → everyone runs the *exact* same environment;
one person rebuilds the image, the rest are prompted to rebuild.

Cost: everyone works *inside* the container; Docker Desktop on WSL2;
the on-disk `REDPASH_DATA_DIR` + the running backend need to be
reachable from inside. Real, but bounded — and the team is already on
WSL2 + VS Code, where devcontainers are first-class.

**Recommendation:** ship the gated plan first (~95 % of the value,
low cost). Keep the devcontainer as the escape hatch if residual
drift still bites.

---

## Open decisions

1. **Node target** — `22` (current) or `20` LTS? **Woz's call.**
2. **`rust-toolchain.toml` — exact (`1.95.0`) or minor (`1.95`)?** Exact = fully reproducible, deliberate bumps. Minor = auto patch-level. Recommend exact.
3. **Hook strictness** — proposed: `pre-push`, warn on drift, block on security advisory. Could go `pre-commit` (noisier) or pure-warn.
4. **`rust-toolchain.toml` location** — `backend/` (next to the workspace `Cargo.toml`) vs repo root. Recommend `backend/`.
5. **Devcontainer** — adopt now, or keep as the escape hatch? Recommend escape hatch.
6. **Feed `dep-audit` runs into `audit.run`?** The audit-storage tables (`audit-storage-brainstorming.md`) could track freshness *trend over time* — "we were 2 minors behind, now 5." Natural synergy; defer to a later phase.

---

## Suggested phasing

| Phase | Work | Owner |
|---|---|---|
| 1 | Declare — `backend/rust-toolchain.toml`, `.nvmrc`, `tools/dep-audit/targets.json`, exact ECharts pin, `docs/dev/environment.md` | infra; Node value = Woz |
| 2 | `scripts/dev-setup.sh` + `docs/dev/setup.md` update | infra |
| 3 | `tools/dep-audit/audit.js` — report + `--check` exit code | infra |
| 4 | `hooks/pre-push` + `core.hooksPath` (set by `dev-setup.sh`) | infra |
| 5 | Schedule the weekly nudge run; optionally feed `audit.run` | infra |
| defer | devcontainer | team call |

Phase 1 alone fixes the *Declare* gap — versions stop being a guess.
Phases 2–4 are *Propagate*. Phase 1 can ship today minus the one
Node value that's Woz's.

---

## Handoff notes

- **Ownership split:** the propagation *system* (setup script, hook,
  `dep-audit` tool, the non-Node pins) is infra — Gus or anyone. The
  Node *target value* in `.nvmrc` is **Woz's**, per the per-contributor
  branch model.
- **`rust-toolchain.toml` is the template** for what "good" looks
  like: a committed declaration the tooling auto-honors with zero
  human action. Every other runtime is a worse approximation of that
  — judge each propagation mechanism by how close it gets.
- **The dep-audit tool stays zero-npm-dependency** — same deliberate
  property as `css-audit` / `html-audit`. It shells out; it never
  grows a `node_modules`.
- **`cargo-outdated` / `cargo-audit` are external** — not installed
  today. `dev-setup.sh` installs them; the dep-audit tool degrades
  gracefully (reports "not installed, run dev-setup") if they're
  missing rather than crashing.
- **Don't hard-block on drift.** An observability/gate layer that
  blocks routine work gets disabled. Warn loudly, block only on
  security. The real proactive signal is the scheduled run, not the
  hook.
- This is the third member of the `tools/` suite (`css-audit`,
  `html-audit`, `dep-audit`) — the same "reusable tools for the
  never-ending maintenance" thread.
