// Internal-Slack channel access — file-path resolution, channel read,
// entry append. The MCP server's stateful surface is just this directory;
// every resource + tool reduces to a path under SLACK_DIR.
//
// Path is configurable via REDPASH_SLACK_DIR. Default matches the
// existing convention (/home/mansa/Internal-Slack) so a stdio server
// launched without env vars just works on the canonical host. For v2's
// cross-distro bridge, only the one canonical host runs the server +
// owns the files; remote clients access via HTTP transport. Same code,
// different transport — single backing file is the architecture
// 22.04 Torv flagged as load-bearing.

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SLACK_DIR = process.env.REDPASH_SLACK_DIR
  ?? path.join(process.env.HOME ?? "/home/mansa", "Internal-Slack");

export const KNOWN_AGENTS = ["Torv", "Woz", "Gus"] as const;
export type Agent = (typeof KNOWN_AGENTS)[number];

export function channelUri(agent: string): string {
  return `slack://channels/${agent}.md`;
}

export function channelPath(agent: string): string {
  return path.join(SLACK_DIR, `${agent}.md`);
}

export async function readChannel(agent: string): Promise<string> {
  return fs.readFile(channelPath(agent), "utf-8");
}

export async function readCommitsLog(): Promise<string> {
  return fs.readFile(path.join(SLACK_DIR, "commits.log"), "utf-8");
}

// Header pattern: `### YYYY-MM-DD HH:MM — <intent>: <subject>`.
// Matches the protocol Em + Gus + Woz settled on; mirrored here so the
// tool can both produce conformant headers and parse existing ones.
const HEADER_RX = /^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — /;

export interface ChannelEntry {
  /** ISO-shaped header timestamp `YYYY-MM-DD HH:MM`. */
  stamp: string;
  /** Full entry text including the `### ` header line. */
  text: string;
}

export function splitEntries(channelText: string): ChannelEntry[] {
  const parts = channelText.split(/(?=^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} — )/m);
  const out: ChannelEntry[] = [];
  for (const part of parts) {
    const m = part.match(HEADER_RX);
    if (m) out.push({ stamp: m[1], text: part });
  }
  return out;
}

export function entriesSince(channelText: string, since: string): ChannelEntry[] {
  return splitEntries(channelText).filter((e) => e.stamp >= since);
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function nowStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type Intent = "Asking for" | "Re" | "FYI";

export interface AppendArgs {
  agent: string;
  intent: Intent;
  subject: string;
  body: string;
  from: string;
  /** Override the auto-stamp for tests / replay. */
  stamp?: string;
}

/** Append a protocol-compliant entry to a channel file. Returns the
 *  full text of the new entry as written (for the tool's response). */
export async function appendEntry(args: AppendArgs): Promise<string> {
  const stamp = args.stamp ?? nowStamp();
  const header = `### ${stamp} — ${args.intent}: ${args.subject}`;
  const body = args.body.trim();
  const signature = `— ${args.from}`;
  const entry = `\n${header}\n\n${body}\n\n${signature}\n`;
  await fs.appendFile(channelPath(args.agent), entry, "utf-8");
  return entry;
}
