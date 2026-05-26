// HTTP/SSE transport for the redpash-mcp-server. v2 of the build — see
// the README's "What this fixes" for why this matters: WSL2 distros are
// network-isolated at the filesystem layer, so the cross-distro
// coordination divergence only closes if BOTH distros' Claude Code
// instances hit the same canonical backing files. This transport is
// what makes that possible: one server binds the canonical SLACK_DIR,
// remote distros connect via the WSL2 bridge / Windows-host loopback,
// and every channel read or append targets the SAME on-disk files.
//
// Uses StreamableHTTPServerTransport (the SDK's current recommended
// HTTP shape — replaces the older SSE-only transport with a unified
// streaming model that handles both single-shot requests and long-
// lived streams over the same /mcp endpoint).

import * as http from "node:http";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpOptions {
  /** TCP port to bind. Required — fail fast if the caller didn't pick one. */
  port: number;
  /** Bind host. Defaults to 0.0.0.0 so a peer WSL distro can reach the server
   *  over the WSL2 bridge. Override to 127.0.0.1 for stricter exposure. */
  host?: string;
}

export async function startHttpServer(
  server: Server,
  opts: HttpOptions,
): Promise<http.Server> {
  const host = opts.host ?? "0.0.0.0";

  // One transport instance binds to the server; per-request work happens
  // via transport.handleRequest(req, res). Session IDs are stamped per
  // initial handshake so a remote client can issue multiple JSON-RPC
  // frames within the same logical session.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "";

      // Health endpoint — useful for cross-distro reachability probes
      // (curl http://<server-ip>:PORT/health) before configuring the
      // peer Claude Code instance.
      if (url === "/health" || url === "/health/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            server: "redpash-mcp-server",
            transport: "http",
            note: "canonical-host mode — this server owns the Internal-Slack backing files",
          }),
        );
        return;
      }

      // All MCP traffic flows through /mcp. POST = client→server JSON-RPC,
      // GET = SSE stream for server→client messages within an open session.
      if (url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/")) {
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
    } catch (err) {
      const stack = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`[redpash-mcp-server] http handler error: ${stack}\n`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end("internal error\n");
      } catch {
        /* response already closed */
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `[redpash-mcp-server] http listening on ${host}:${opts.port}\n` +
      `[redpash-mcp-server] canonical mode — single backing SLACK_DIR for all clients\n`,
  );

  return httpServer;
}
