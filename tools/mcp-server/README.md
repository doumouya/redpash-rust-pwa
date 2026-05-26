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
canonical Internal-Slack view through one of two transports:

- **stdio** (default): one server per host. Each Claude Code instance
  spawns its own subprocess; each subprocess reads/writes its own
  local `Internal-Slack/`. Useful as the agent-tool surface on a
  single host, but does **not** by itself close the cross-distro gap.
- **http** (set `REDPASH_MCP_PORT`): **one canonical server** runs on
  one distro (whichever owns the active push lane). Both distros
  register *the same remote URL* in their Claude Code config. Single
  backing file; both Torv sessions read + write the same
  `Internal-Slack/` regardless of which distro the session runs on.
  **This is the cross-distro divergence fix.**

## Install

```sh
cd tools/mcp-server
npm install
npm run build
```

Outputs `dist/server.js` (executable via the `bin` entry).

## Register with Claude Code

Two registration shapes — pick based on whether you want the single-host
stdio surface or the canonical-host HTTP transport.

### stdio (default — single-host)

Each Claude Code instance spawns its own subprocess; reads + writes go
to the local `Internal-Slack/`. Useful for development and when only
one distro needs the server.

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

### http (canonical-host — cross-distro)

**Pick ONE distro as the canonical host** (the one that owns the active
push lane is the natural choice). On that distro, start the server with
`REDPASH_MCP_PORT` set:

```sh
cd tools/mcp-server
REDPASH_MCP_PORT=8765 REDPASH_SLACK_DIR=/home/mansa/Internal-Slack \
  node dist/server.js &
```

The server logs its bind to stderr (`http listening on 0.0.0.0:8765`).
Verify reachability:

```sh
curl http://<canonical-host-ip>:8765/health
# → {"ok":true,"server":"redpash-mcp-server","transport":"http", ...}
```

Find the canonical host's WSL2 IP from the *peer* distro with
`getent hosts <canonical-distro-hostname>` or by checking the canonical
distro's `hostname -I`. Both WSL distros can reach each other over the
WSL2 bridge — no Windows-side proxying needed.

Then in **both** distros' `~/.claude.json`:

```jsonc
{
  "mcpServers": {
    "redpash-slack": {
      "url": "http://<canonical-host-ip>:8765/mcp"
    }
  }
}
```

Same URL on both sides; single backing `Internal-Slack/`. Reads return
identical state; appends land in one file the other distro reads
immediately. **This is the cross-distro divergence fix.**

### Configuration

| env var | default | scope |
|---|---|---|
| `REDPASH_SLACK_DIR` | `$HOME/Internal-Slack` | dir holding channel files + `commits.log`. Only the host actually running the server reads this. |
| `REDPASH_MCP_PORT` | (unset → stdio) | set to a TCP port → server boots in HTTP mode |
| `REDPASH_MCP_HOST` | `0.0.0.0` (HTTP mode only) | bind interface. `127.0.0.1` for stricter exposure when both distros aren't talking. |

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

## TODOs

- **`tools/mcp-server-audit/`** — eventually a sibling audit shelf
  matching the `tools/*-audit/audit.js` pattern. Probes the MCP
  server's `listResources` + `listTools` surface, diffs against the
  schema in this README, flags drift. Same encoded-discipline pattern
  as the rest of the audit suite (per
  [[feedback-build-tools-proactively]] +
  [[feedback-audit-everything]]).
- **Cross-distro auth** — the HTTP transport on a WSL2-bridge IP is
  fine for solo-dev (no untrusted clients on the network), but if the
  deployment shape ever expands beyond the local Windows host's two
  WSL distros, add a shared-secret header.
- **Persistent session resume** — the SDK's
  `StreamableHTTPServerTransport` supports `EventStore` for
  resumable streams. Not wired yet; useful if/when a long-lived
  subscription resource lands (e.g. tail of `commits.log` streamed
  in real time).

## Legacy housekeeping

There's an empty root-owned `/home/mansa/MCP Server/` directory left
over from a Windows-side `mkdir` attempt before we converged on
`tools/mcp-server/`. Delete it via Windows when convenient — no urgency.
