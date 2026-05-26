# redpash-mcp-server

MCP server exposing `Internal-Slack/` channels + `commits.log` as
**resources**, plus protocol-compliant channel-append **tooling**. Built
to retire the cross-WSL-distro coordination divergence (see "What this
fixes" below).

Per [[feedback-no-frameworks]], the `@modelcontextprotocol/sdk` dep is
the same kind of tools/-adjacent infrastructure carve-out as Acorn in
the `js-audit` shelf (`[[feedback-acorn-allowed-for-static-analysis]]`).
The SDK is agent-tooling glue — never imported from `frontend/`, never
linked into the Rust `data` / `api` crates.

## What this fixes

WSL2 isolates each distro's filesystem. `\\wsl.localhost\Ubuntu-22.04\…`
resolves from Windows only — not from inside another WSL distro. So an
agent on Ubuntu-26.04 couldn't read entries written to
`/home/mansa/Internal-Slack/Torv.md` on Ubuntu-22.04, and vice versa.
Throughout 2026-05-26 this caused real coordination cost: pings were
written on one distro and invisible on the other until a manual
Windows-side `robocopy` ran.

This MCP server gives both distros' Claude Code instances a single
canonical Internal-Slack view through one transport:

- **v1 (this commit)**: stdio transport. One server per host. Each
  host's server reads/writes its own local `Internal-Slack/`. Useful
  on its own as the agent-tool surface, but does **not** by itself
  close the cross-distro gap.
- **v2 (next commit)**: HTTP/SSE transport. **One canonical server**
  runs on one distro (whichever owns the active push lane). Both
  distros register *the same remote URL* in their Claude Code config.
  Single backing file; both Torv sessions read + write the same
  `Internal-Slack/` regardless of which distro the Claude Code session
  runs on. The local stdio shape from v1 stays available for
  development.

## Install

```sh
cd tools/mcp-server
npm install
npm run build
```

Outputs `dist/server.js` (executable via the `bin` entry).

## Register with Claude Code

Add to your project's `.mcp.json` or to `~/.claude.json`'s
`mcpServers` block:

```jsonc
{
  "mcpServers": {
    "redpash-slack": {
      "command": "node",
      "args": ["/home/mansa/rust-project/redpash-rust-pwa/tools/mcp-server/dist/server.js"],
      "env": {
        "REDPASH_SLACK_DIR": "/home/mansa/Internal-Slack"
      }
    }
  }
}
```

For v2's HTTP transport, swap `command`/`args`/`env` for the canonical
HTTP URL. v2's commit will include the registration block.

## Exposed surface

### Resources

| URI | mime | description |
|---|---|---|
| `slack://channels/Torv.md` | text/markdown | Torv's inbox |
| `slack://channels/Woz.md` | text/markdown | Woz's inbox |
| `slack://channels/Gus.md` | text/markdown | Gus's inbox |
| `slack://commits-log` | text/tab-separated-values | `commits.log` raw TSV |

### Tools

| name | description |
|---|---|
| `slack_append_entry` | Append a protocol-compliant entry to a channel. Header `### YYYY-MM-DD HH:MM — <intent>: <subject>` + signature line built automatically. |
| `slack_read_since` | Filtered read — entries newer than a `YYYY-MM-DD HH:MM` cutoff. Header-aware split. Omit `since` for last 5. |

## Configuration

| env var | default | purpose |
|---|---|---|
| `REDPASH_SLACK_DIR` | `$HOME/Internal-Slack` | Directory containing the channel files + `commits.log`. v2's canonical-host runs the server with its own path; other hosts hit the HTTP transport, so this env var only matters where the server actually executes. |

## TODOs

- **`tools/mcp-server-audit/`** — eventually a sibling audit shelf
  matching the `tools/*-audit/audit.js` pattern. Probes the MCP
  server's `listResources` + `listTools` surface, diffs against the
  schema in this README, flags drift. Same encoded-discipline pattern
  as the rest of the audit suite (per
  [[feedback-build-tools-proactively]] +
  [[feedback-audit-everything]]).
- **v2 HTTP/SSE transport** — next commit, same session. Adds
  `src/transports/http.ts`, wires canonical-host semantics, updates
  this README's registration block.
- **Cross-distro auth** (v2-adjacent) — the HTTP transport on a
  WSL2-loopback IP is fine for solo-dev (no untrusted clients on the
  network), but if the deployment shape ever expands beyond the local
  Windows host's two WSL distros, add a shared-secret header.

## Legacy housekeeping

There's an empty root-owned `/home/mansa/MCP Server/` directory left
over from a Windows-side `mkdir` attempt before we converged on
`tools/mcp-server/`. Delete it via Windows when convenient — no urgency.
