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
case CRUD, slack-append-entry, case-comment.

## Public surface

- **Resources** — read-only views of `Internal-Slack/*.md` files and
  `commits.log`.
- **Tools** — case_create / case_get / case_list / case_comment /
  slack_append_entry / slack_read_since (this is how this Torv files
  cases programmatically).
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

## Related

- [Spec: mcp-memory-bridge](../../specs/mcp-memory-bridge.md) — v3 design
- [Process: team coord tools](team.md)
