---
title: tools/dev-setup.sh
source: ../../../../../tools/dev-setup.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-06-08
---

# dev-setup.sh

## Purpose

Orchestrator — chains the onboarding steps (install-stack → db-setup →
**mcp-server build** → cargo check) in dependency order so a fresh host
goes from clean to *"api boots"* in one invocation. The "first-run"
command for a new contributor.

The `mcp-server build` step (`npm install && npm run build` in
`tools/mcp-server/`) produces `dist/server.js` — without it the
`redpash-slack` MCP entry has no module to load and fails with
"Connection closed" (`node_modules`/`dist` are gitignored, so a fresh
checkout has neither). Gated on `npm` being present + `--no-build` off.

## Public surface

- `sh tools/dev-setup.sh` — runs in sequence with per-step pass/fail.
- Stops at the first failing step (no continue-on-error).
- Idempotent: re-running on a partially-set-up host skips completed
  steps.

## Drift-prone areas

- **Step ordering** is hard-coded; new bootstrap steps (e.g. seed
  fixtures, install Node deps for tools/) need adding here.
- Assumes the host already has bash + curl + git; the install-stack
  step picks up everything else.

## Related

- [Sibling: install-stack.sh](install-stack.md)
- [Sibling: db-setup.sh](db-setup.md)
- [Sibling: build-wasm.sh](build-wasm.md)
- [Public: Getting started](../../../../../getting-started.md)
