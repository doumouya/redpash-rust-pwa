// Transport-agnostic MCP handlers — list/read resources + list/call
// tools. The Server instance binds these handlers; both stdio (v1) and
// HTTP/SSE (v2) transports use the same handler set, so the protocol
// surface stays identical across deployment shapes.

import { z } from "zod";
import {
  KNOWN_AGENTS,
  channelUri,
  readChannel,
  readCommitsLog,
  splitEntries,
  entriesSince,
  appendEntry,
} from "./slack.js";

// ── resources ───────────────────────────────────────────────────────────

const COMMITS_LOG_URI = "slack://commits-log";

export async function listResources() {
  const resources = KNOWN_AGENTS.map((agent) => ({
    uri: channelUri(agent),
    name: `${agent}'s inbox`,
    description:
      `Append-only channel addressed to ${agent}. Markdown; one section ` +
      `per ping, '### YYYY-MM-DD HH:MM — <intent>: <subject>' headers.`,
    mimeType: "text/markdown",
  }));
  resources.push({
    uri: COMMITS_LOG_URI,
    name: "commits.log",
    description:
      "Tab-separated commit broadcast from .git/hooks/post-commit. " +
      "Columns: ISO-UTC timestamp, agent, branch, short SHA, subject.",
    mimeType: "text/tab-separated-values",
  });
  return { resources };
}

export async function readResource(uri: string) {
  if (uri === COMMITS_LOG_URI) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/tab-separated-values",
          text: await readCommitsLog(),
        },
      ],
    };
  }
  const m = uri.match(/^slack:\/\/channels\/(.+?)\.md$/);
  if (!m) throw new Error(`unknown resource uri: ${uri}`);
  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: await readChannel(m[1]),
      },
    ],
  };
}

// ── tools ───────────────────────────────────────────────────────────────

const AppendArgsZ = z.object({
  agent: z
    .string()
    .describe("Recipient channel — Torv, Woz, or Gus (case-sensitive)."),
  intent: z
    .enum(["Asking for", "Re", "FYI"])
    .describe(
      "Intent marker on the header line. 'Asking for:' = needs an action " +
        "or decision. 'Re:' = response to a prior entry. 'FYI:' = no action " +
        "required.",
    ),
  subject: z
    .string()
    .min(1)
    .describe("One-line subject for the section header."),
  body: z
    .string()
    .min(1)
    .describe("Markdown body of the entry. Signature line is appended automatically."),
  from: z
    .string()
    .min(1)
    .describe("Sender agent name (Torv / Woz / Gus / Em) — used in the signature line."),
});

const ReadSinceArgsZ = z.object({
  agent: z.string().describe("Channel to read — Torv, Woz, or Gus."),
  since: z
    .string()
    .optional()
    .describe(
      "ISO-ish 'YYYY-MM-DD HH:MM' cutoff. Entries with header timestamp " +
        ">= this value are returned. Omit to get the most recent 5 entries.",
    ),
});

export async function listTools() {
  return {
    tools: [
      {
        name: "slack_append_entry",
        description:
          "Append a protocol-compliant entry to a channel file. Produces a " +
            "header of the form '### YYYY-MM-DD HH:MM — <intent>: <subject>' " +
            "and a trailing '— <from>' signature line, both per the channel-ping " +
            "protocol. The timestamp is generated server-side in local time.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string" },
            intent: { type: "string", enum: ["Asking for", "Re", "FYI"] },
            subject: { type: "string" },
            body: { type: "string" },
            from: { type: "string" },
          },
          required: ["agent", "intent", "subject", "body", "from"],
        },
      },
      {
        name: "slack_read_since",
        description:
          "Read channel entries newer than a given timestamp. Header-aware: " +
            "splits on '### YYYY-MM-DD HH:MM' markers and filters lexicographically " +
            "(ISO timestamps sort correctly as strings). Omit `since` for the last 5.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string" },
            since: { type: "string" },
          },
          required: ["agent"],
        },
      },
    ],
  };
}

export async function callTool(name: string, args: unknown) {
  if (name === "slack_append_entry") {
    const parsed = AppendArgsZ.parse(args);
    const entry = await appendEntry(parsed);
    return {
      content: [
        {
          type: "text" as const,
          text: `Appended to ${parsed.agent}.md:\n${entry}`,
        },
      ],
    };
  }
  if (name === "slack_read_since") {
    const parsed = ReadSinceArgsZ.parse(args);
    const text = await readChannel(parsed.agent);
    const entries = parsed.since
      ? entriesSince(text, parsed.since)
      : splitEntries(text).slice(-5);
    const out = entries.map((e) => e.text).join("");
    return {
      content: [
        {
          type: "text" as const,
          text: out || `(no entries${parsed.since ? " since " + parsed.since : ""})`,
        },
      ],
    };
  }
  throw new Error(`unknown tool: ${name}`);
}
