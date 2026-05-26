#!/usr/bin/env node
// redpash-mcp-server — MCP server exposing Internal-Slack as resources +
// channel-write tooling. Two transports:
//
//   - stdio (default): one server per host. Each Claude Code instance
//     spawns its own subprocess and talks JSON-RPC over stdin/stdout.
//     Useful for development and for the single-host case.
//
//   - http (when REDPASH_MCP_PORT is set): one canonical server binds
//     a TCP port; both WSL distros' Claude Code instances point at the
//     same URL and write/read the same backing Internal-Slack files.
//     This is the cross-distro divergence fix the build was scoped for.
//
// Per [[feedback-no-frameworks]] the @modelcontextprotocol/sdk dep is
// the same kind of tools/-adjacent infrastructure carve-out as Acorn
// in tools/*-audit/ (see [[feedback-acorn-allowed-for-static-analysis]]).
// Not runtime code; not on the product path; serves the agent-tooling
// layer that the vanilla-JS + Rust runtime never imports.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { listResources, readResource, listTools, callTool } from "./handlers.js";
import { startHttpServer } from "./transports/http.js";

export function makeServer(): Server {
  const server = new Server(
    { name: "redpash-mcp-server", version: "0.2.0" },
    { capabilities: { resources: {}, tools: {} } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, listResources);
  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    readResource(req.params.uri),
  );
  server.setRequestHandler(ListToolsRequestSchema, listTools);
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(req.params.name, req.params.arguments),
  );

  return server;
}

function parsePort(raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(
      `REDPASH_MCP_PORT must be an integer in [1, 65535]; got: ${raw}`,
    );
  }
  return n;
}

async function main() {
  const server = makeServer();
  const portEnv = process.env.REDPASH_MCP_PORT;

  if (portEnv) {
    // HTTP transport — canonical-host mode. The peer distro reaches in
    // over the WSL2 bridge IP, registering this same URL in its own
    // Claude Code config. One server, one backing SLACK_DIR, both
    // distros see identical state.
    const port = parsePort(portEnv);
    const host = process.env.REDPASH_MCP_HOST ?? "0.0.0.0";
    await startHttpServer(server, { port, host });
    // http server holds the event loop; nothing else to do.
    return;
  }

  // Default — stdio transport. Claude Code spawns the binary as a
  // subprocess and exchanges JSON-RPC frames over stdin/stdout.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // The stdio path expects clean JSON-RPC over stdout, so anything we
  // shout goes to stderr — never stdout — to keep the wire format intact.
  process.stderr.write(
    `[redpash-mcp-server] fatal: ${err instanceof Error ? err.stack ?? err.message : err}\n`,
  );
  process.exit(1);
});
