---
title: tools/mcp-server/
source: ../../../../tools/mcp-server/
owner: Woz / Torv
section: Internal · Code · Tools
last modified date: 2026-05-30
---

# mcp-server

## Purpose

MCP (Model Context Protocol) server that exposes the team's coordination
state as resources + tools that any MCP client (Claude Code, other
agents) can consume. Built to retire the cross-WSL-distro coordination
divergence: the `Internal-Slack/` channel files were drifting between
agent sessions on different distros; this server makes them a single
canonical state with a defined wire.

Resources: `Internal-Slack/` channels, `commits.log`. Tools: channel-append,
case CRUD, slack-append-entry, case-comment, case-status (kanban move / close).

## Public surface

- **Resources** — read-only views of `Internal-Slack/*.md` files and
  `commits.log`.
- **Tools** — case_create / case_get / case_list / case_comment /
  case_set_status / slack_append_entry / slack_read_since (this is how
  this Torv files, comments on, and closes cases programmatically).
  `case_set_status` is the close/transition verb — it PATCHes only
  `status` to `/api/cases/:rid`, so the backend's enum-validation +
  `status: X → Y` activity event stay the single source of policy.
- Two runtimes ship in the repo: v1 stdio, v2 HTTP/SSE. v3 (planned)
  adds memory-as-resource per the [mcp-memory-bridge spec](../../specs/mcp-memory-bridge.md).
- Uses the MCP SDK (the one no-frameworks carve-out for this server).

## Drift-prone areas

- **Canonical-file semantics**: when two agents on different distros
  read/append, the server arbitrates. If a third runtime path appears
  it needs to play with the same semantics or divergence returns.
- **Case backend** must be running for the case tools to work — when
  `redpash-api` is down the tools fail with `fetch failed`. Don't paper
  over this in the server; the caller needs to know.
- **Auth model (v2, self-healing as of 2026-05-31)**: `src/cases.ts`
  treats `REDPASH_API_SESSION` env as an *initial seed*, not a hard
  requirement. On 401 the bridge mints a fresh cookie via
  `POST /auth/dev-login`, caches it module-side, and retries the
  failed call exactly once. A `mintInFlight` promise coalesces
  concurrent retries so dev-login never stampedes. Don't reintroduce
  a "fail if env unset" assertion at the bridge entry point — it
  defeats the lazy-init contract. See
  [runbook 0008](../../runbooks/0008-mcp-cases-session-auto-refresh.md).

## Related

- [Spec: mcp-memory-bridge](../../specs/mcp-memory-bridge.md) — v3 design
- [Process: team coord tools](team.md)
