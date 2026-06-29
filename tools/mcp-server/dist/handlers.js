// Transport-agnostic MCP handlers — list/read resources + list/call
// tools. The Server instance binds these handlers; both stdio (v1) and
// HTTP/SSE (v2) transports use the same handler set, so the protocol
// surface stays identical across deployment shapes.
import { z } from "zod";
import { KNOWN_AGENTS, channelUri, readChannel, readCommitsLog, splitEntries, entriesSince, appendEntry, } from "./slack.js";
// Cases backend selection (AC-3/AC-6, Case CAS_C5AB84FB95E141B995983BE68C38984E):
// the default stays the RedPash /cases/* adapter; setting NUMU_CASES_ADAPTER=1
// (alias NUMU_CASES=1) repoints the case_* tools onto numu's generic-object
// surface. Both modules export the same public surface, so the rest of this
// file is backend-agnostic.
import * as casesRedpash from "./cases.js";
import * as casesNumu from "./cases-numu.js";
const USE_NUMU = process.env.NUMU_CASES_ADAPTER === "1" || process.env.NUMU_CASES === "1";
const casesApi = USE_NUMU ? casesNumu : casesRedpash;
const { CaseApiError, createCase, getCase, listCases, addComment, setCaseStatus, } = casesApi;
// ── resources ───────────────────────────────────────────────────────────
const COMMITS_LOG_URI = "slack://commits-log";
export async function listResources() {
    const resources = KNOWN_AGENTS.map((agent) => ({
        uri: channelUri(agent),
        name: `${agent}'s inbox`,
        description: `Append-only channel addressed to ${agent}. Markdown; one section ` +
            `per ping, '### YYYY-MM-DD HH:MM — <intent>: <subject>' headers.`,
        mimeType: "text/markdown",
    }));
    resources.push({
        uri: COMMITS_LOG_URI,
        name: "commits.log",
        description: "Tab-separated commit broadcast from .git/hooks/post-commit. " +
            "Columns: ISO-UTC timestamp, agent, branch, short SHA, subject.",
        mimeType: "text/tab-separated-values",
    });
    return { resources };
}
export async function readResource(uri) {
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
    if (!m)
        throw new Error(`unknown resource uri: ${uri}`);
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
        .describe("Intent marker on the header line. 'Asking for:' = needs an action " +
        "or decision. 'Re:' = response to a prior entry. 'FYI:' = no action " +
        "required."),
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
        .describe("ISO-ish 'YYYY-MM-DD HH:MM' cutoff. Entries with header timestamp " +
        ">= this value are returned. Omit to get the most recent 5 entries."),
});
// ── case tool schemas ───────────────────────────────────────────────
// Thin shells around /api/cases — the backend owns validation,
// invariants, and audit-event emission; these schemas only enforce
// shape at the MCP boundary so a malformed argument fails before the
// HTTP roundtrip.
const CaseCreateArgsZ = z.object({
    title: z.string().min(1).describe("Case title. Required, non-empty."),
    description: z
        .string()
        .optional()
        .describe("Optional markdown description / context. Plain text in v1."),
    type: z
        .enum(["bug", "feature", "task", "epic"])
        .optional()
        .describe("Defaults to 'task' on the backend if omitted."),
    priority: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .describe("Defaults to 'medium' on the backend if omitted."),
    assignee_id: z.string().optional().describe("USR_<rid> of the assignee."),
    project_id: z.string().optional().describe("PRJ_<rid> for project-scoped cases."),
    company_id: z.string().optional().describe("CMP_<rid> for company-scoped cases."),
});
const CaseGetArgsZ = z.object({
    rid: z.string().describe("CAS_<rid> of the case to read."),
});
const CaseListArgsZ = z.object({
    status: z
        .string()
        .optional()
        .describe("Filter by status (backlog / todo / in_progress / in_review / done)."),
    assignee: z
        .string()
        .optional()
        .describe("USR_<rid> filter. Pass the caller's own RID for a 'my assigned' view."),
    project: z.string().optional().describe("PRJ_<rid> filter."),
    q: z.string().optional().describe("Free-text search across title + description."),
    page: z.number().int().min(1).optional(),
    size: z.number().int().min(1).max(500).optional(),
});
const CaseCommentArgsZ = z.object({
    rid: z.string().describe("CAS_<rid> of the case to comment on."),
    body: z.string().min(1).describe("Comment body. Plain text in v1; markdown render is v2 polish."),
});
const CaseSetStatusArgsZ = z.object({
    rid: z.string().describe("CAS_<rid> of the case to move."),
    status: z
        .enum(["backlog", "todo", "in_progress", "in_review", "done"])
        .describe("Target kanban column. The backend validates the enum and emits a " +
        "'status: X → Y' activity-feed event (audit spine)."),
});
// Common error mapping for case-tool branches — keep the response
// shape consistent so the calling agent sees the same HTTP-mapped
// text regardless of which tool tripped the error.
function caseErrorContent(err) {
    if (err instanceof CaseApiError) {
        return {
            content: [
                {
                    type: "text",
                    text: `Case API error (HTTP ${err.status}): ${err.message}` +
                        (err.body ? `\n\n${JSON.stringify(err.body, null, 2)}` : ""),
                },
            ],
            isError: true,
        };
    }
    throw err;
}
export async function listTools() {
    return {
        tools: [
            {
                name: "slack_append_entry",
                description: "Append a protocol-compliant entry to a channel file. Produces a " +
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
                description: "Read channel entries newer than a given timestamp. Header-aware: " +
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
            {
                name: "case_create",
                description: "File a new RedPash case. Returns the created Case row including its " +
                    "CAS_<rid>. title is required; type defaults to 'task', priority to " +
                    "'medium', status to 'backlog' on the server. Use this when a piece of " +
                    "work spans multiple back-and-forths or needs cross-agent visibility — " +
                    "quick lookups stay on the slack channel.",
                inputSchema: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        type: { type: "string", enum: ["bug", "feature", "task", "epic"] },
                        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
                        assignee_id: { type: "string" },
                        project_id: { type: "string" },
                        company_id: { type: "string" },
                    },
                    required: ["title"],
                },
            },
            {
                name: "case_get",
                description: "Fetch a single case by CAS_<rid>. Returns the full CaseDetail shape — " +
                    "the case row plus its comments thread and activity-feed events. Use " +
                    "this when picking up assigned work to see prior context.",
                inputSchema: {
                    type: "object",
                    properties: { rid: { type: "string" } },
                    required: ["rid"],
                },
            },
            {
                name: "case_list",
                description: "List cases with optional filters. Pass `assignee` = your own USR_<rid> " +
                    "for a 'my assigned' view; `status` for kanban-column slices; `q` for " +
                    "free-text search. Returns { items, total, page, size }.",
                inputSchema: {
                    type: "object",
                    properties: {
                        status: { type: "string" },
                        assignee: { type: "string" },
                        project: { type: "string" },
                        q: { type: "string" },
                        page: { type: "number" },
                        size: { type: "number" },
                    },
                },
            },
            {
                name: "case_comment",
                description: "Append a comment to an existing case. Comments are the agent-to-agent " +
                    "thread surface — the replacement for cross-channel slack pings now " +
                    "that Cases is live. Plain text body in v1; markdown render comes with " +
                    "v2 polish.",
                inputSchema: {
                    type: "object",
                    properties: {
                        rid: { type: "string" },
                        body: { type: "string" },
                    },
                    required: ["rid", "body"],
                },
            },
            {
                name: "case_set_status",
                description: "Move a case to a kanban column (backlog / todo / in_progress / " +
                    "in_review / done) — the close / transition verb. Sends only `status` " +
                    "to PATCH /api/cases/:rid, so title / priority / assignee stay " +
                    "untouched; the backend validates the enum and logs a 'status: X → Y' " +
                    "activity event. Use it to close a finished case (status='done') or to " +
                    "reflect real progress on the board. Pair with case_comment to record " +
                    "the why alongside the move.",
                inputSchema: {
                    type: "object",
                    properties: {
                        rid: { type: "string" },
                        status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "done"] },
                    },
                    required: ["rid", "status"],
                },
            },
        ],
    };
}
export async function callTool(name, args) {
    if (name === "slack_append_entry") {
        const parsed = AppendArgsZ.parse(args);
        const entry = await appendEntry(parsed);
        return {
            content: [
                {
                    type: "text",
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
                    type: "text",
                    text: out || `(no entries${parsed.since ? " since " + parsed.since : ""})`,
                },
            ],
        };
    }
    if (name === "case_create") {
        const parsed = CaseCreateArgsZ.parse(args);
        try {
            const created = await createCase(parsed);
            return {
                content: [
                    {
                        type: "text",
                        text: `Created case ${created.redpash_id ?? "(unknown rid)"}: ${created.title ?? parsed.title}\n\n` +
                            JSON.stringify(created, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return caseErrorContent(err);
        }
    }
    if (name === "case_get") {
        const parsed = CaseGetArgsZ.parse(args);
        try {
            const detail = await getCase(parsed.rid);
            return {
                content: [
                    { type: "text", text: JSON.stringify(detail, null, 2) },
                ],
            };
        }
        catch (err) {
            return caseErrorContent(err);
        }
    }
    if (name === "case_list") {
        const parsed = CaseListArgsZ.parse(args);
        try {
            const result = await listCases(parsed);
            return {
                content: [
                    {
                        type: "text",
                        text: `Found ${result.total} case(s); showing page ${result.page} (size ${result.size}):\n\n` +
                            JSON.stringify(result, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return caseErrorContent(err);
        }
    }
    if (name === "case_comment") {
        const parsed = CaseCommentArgsZ.parse(args);
        try {
            const comment = await addComment(parsed);
            return {
                content: [
                    {
                        type: "text",
                        text: `Appended comment to ${parsed.rid}:\n\n` +
                            JSON.stringify(comment, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return caseErrorContent(err);
        }
    }
    if (name === "case_set_status") {
        const parsed = CaseSetStatusArgsZ.parse(args);
        try {
            const updated = await setCaseStatus(parsed);
            return {
                content: [
                    {
                        type: "text",
                        text: `Case ${parsed.rid} → status "${updated.status ?? parsed.status}".\n\n` +
                            JSON.stringify(updated, null, 2),
                    },
                ],
            };
        }
        catch (err) {
            return caseErrorContent(err);
        }
    }
    throw new Error(`unknown tool: ${name}`);
}
