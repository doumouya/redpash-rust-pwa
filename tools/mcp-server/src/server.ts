#!/usr/bin/env node
// redpash-mcp-server — MCP server exposing Internal-Slack as resources +
// channel-write tooling. v1 stdio transport (this commit). v2 adds an
// HTTP/SSE transport so the canonical-file semantics work across WSL
// distros (one server owns the files; both distros' Claude Code instances
// hit the same backing store).
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

export function makeServer(): Server {
  const server = new Server(
    { name: "redpash-mcp-server", version: "0.1.0" },
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

async function main() {
  const server = makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // StdioServerTransport keeps the process alive via its stdin reader.
  // Nothing else to do — handlers fire on each incoming JSON-RPC frame.
}

main().catch((err) => {
  // The MCP protocol expects clean JSON-RPC over stdio, so anything we
  // shout goes to stderr — never stdout — to keep the wire format intact.
  process.stderr.write(`[redpash-mcp-server] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
