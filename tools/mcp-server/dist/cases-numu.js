// MCP-Cases bridge — NUMU repoint adapter.
//
// Mirrors the public surface of `cases.js` (createCase / getCase /
// listCases / addComment / setCaseStatus + class CaseApiError) so
// `handlers.js` can select it by an env flag (NUMU_CASES_ADAPTER), but
// targets numu's generic-object surface instead of RedPash's /cases/*
// routes. The Rust backend owns auth, RBAC, audit-events, workflow
// transition validation, and If-Match concurrency — this bridge is a
// transport + shape adapter only.
//
// Case CAS_C5AB84FB95E141B995983BE68C38984E (cases-mcp-restore.md), AC-4/AC-6.
//
// numu contract (source-confirmed, objects.rs / auth.rs / migrations):
//   - Cases are the generic registry object: there is NO /api/cases route.
//     create  → POST  /objects/case      (BARE field object — no {data} wrapper)
//     get     → GET   /objects/case/:id
//     list    → GET   /objects/case?limit&offset  (only limit/offset supported)
//     comment → POST  /objects/comment    (BARE {subject_id, body})
//     status  → GET the case for its version, then
//               PATCH /objects/case/:id   (BARE {status}) with If-Match: W/"<version>"
//   - Responses are the envelope { id, type, data, version, etag }; the
//     adapter UNWRAPS it to the MCP-flat shape (id → redpash_id, data.*
//     flattened to top level, version kept). The {data} envelope is
//     response-only — requests send fields at the top level.
//   - The etag is weak-form W/"<version>"; numu REQUIRES If-Match on
//     PUT/PATCH/DELETE (missing → 428, stale → 412).
//   - Auth cookie is `numu_session` (NOT rp_session). dev-login is
//     POST /auth/dev-login (debug build only); the Set-Cookie regex
//     matches `numu_session=…`.
//
// Auth model (self-healing, mirrors cases.js v2):
//   REDPASH_API_BASE     — base URL incl. /api suffix. numu runs on a
//                          DEDICATED port (NOT :8080 — RedPash holds it),
//                          so this MUST be set explicitly (e.g.
//                          http://127.0.0.1:8090/api). No :8080 fallback.
//   REDPASH_API_SESSION  — numu_session cookie value (optional). Used as
//                          the initial cookie when set; on a 401 the
//                          bridge invalidates it, re-mints via dev-login,
//                          and retries the failed call once.
//
// SECURITY: the bridge logs URLs / statuses only — never the cookie value.
const API_BASE_DEFAULT = "http://localhost:8080/api";
export class CaseApiError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "CaseApiError";
    }
}
function apiBase() {
    return (process.env.REDPASH_API_BASE ?? API_BASE_DEFAULT).replace(/\/+$/, "");
}
// RedPash → numu priority enum mapping (AC-4). RedPash used
// `medium`/`critical`; numu's enum is `low|normal|high|urgent`. Anything
// already in numu's vocabulary (or unknown) passes through unchanged so
// callers can also send numu-native values.
const PRIORITY_MAP = { medium: "normal", critical: "urgent" };
function mapPriority(p) {
    if (p == null)
        return undefined;
    return PRIORITY_MAP[p] ?? p;
}
// Unwrap numu's { id, type, data, version, etag } envelope into the
// MCP-flat shape the handlers expect: id → redpash_id, data.* flattened
// to top level, version preserved. The raw {data} envelope must NOT leak
// through (handlers read created.redpash_id / .title / .status / .version
// / comment.subject_id / .body).
function unwrap(env) {
    if (env == null || typeof env !== "object")
        return env;
    const { id, data, version } = env;
    const flat = { ...(data && typeof data === "object" ? data : {}) };
    if (id !== undefined)
        flat.redpash_id = id;
    if (version !== undefined)
        flat.version = version;
    return flat;
}
// ── session state (cache + mint coalescer) ──────────────────────────
let cachedSession = null;
let mintInFlight = null;
async function mintSession() {
    if (mintInFlight)
        return mintInFlight;
    const url = apiBase() + "/auth/dev-login";
    mintInFlight = (async () => {
        try {
            const res = await fetch(url, { method: "POST" });
            if (!res.ok) {
                throw new CaseApiError(`POST /auth/dev-login failed with HTTP ${res.status}`, res.status);
            }
            // numu's dev-login returns `Set-Cookie: numu_session=<token>; …`.
            // Node's fetch joins multiple Set-Cookie headers with comma, so a
            // permissive regex on the joined value is fine — we only extract
            // the `numu_session=…` token.
            const setCookie = res.headers.get("set-cookie") ?? "";
            const match = setCookie.match(/numu_session=([^;,\s]+)/);
            if (!match) {
                throw new CaseApiError("POST /auth/dev-login succeeded but Set-Cookie missing numu_session", res.status);
            }
            cachedSession = match[1];
            return cachedSession;
        }
        finally {
            mintInFlight = null;
        }
    })();
    return mintInFlight;
}
function currentSessionCookie() {
    const sid = cachedSession ?? process.env.REDPASH_API_SESSION ?? null;
    return sid ? `numu_session=${sid}` : null;
}
// Called at the start of each public tool invocation. When no session is
// pinned via REDPASH_API_SESSION, we don't trust a stale module cache as the
// initial cookie — we drop it so the operation mints a fresh numu_session
// up front (numu's dev-login is cheap; an expired cached cookie would just
// cost a 401 + retry anyway). A pinned env session is left intact and only
// rotated reactively on a 401. The cache still holds WITHIN an operation, so
// a GET+PATCH pair (set_status) mints exactly once.
function beginOperation() {
    if ((process.env.REDPASH_API_SESSION ?? null) == null) {
        cachedSession = null;
    }
}
// Inner request runner — one round-trip with the cookie + headers given.
// Returns the parsed body on success; throws `CaseApiError` on failure.
async function doFetch(url, method, cookie, hasBody, bodyJson, ifMatch, path) {
    const headers = { Accept: "application/json" };
    if (cookie)
        headers.Cookie = cookie;
    if (hasBody)
        headers["Content-Type"] = "application/json";
    if (ifMatch)
        headers["If-Match"] = ifMatch;
    const res = await fetch(url, { method, headers, body: bodyJson });
    const ct = res.headers.get("content-type") ?? "";
    let parsed = null;
    if (ct.includes("application/json")) {
        try {
            parsed = await res.json();
        }
        catch {
            parsed = null;
        }
    }
    else {
        try {
            parsed = await res.text();
        }
        catch {
            parsed = null;
        }
    }
    if (!res.ok) {
        const msg = typeof parsed === "object" && parsed && "message" in parsed
            ? String(parsed.message)
            : `${method} ${path} failed with HTTP ${res.status}`;
        throw new CaseApiError(msg, res.status, parsed);
    }
    return parsed;
}
async function apiFetch(path, opts = {}) {
    const method = opts.method ?? "GET";
    let url = apiBase() + path;
    if (opts.query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query)) {
            if (v != null && v !== "")
                params.set(k, v);
        }
        const qs = params.toString();
        if (qs)
            url += (url.includes("?") ? "&" : "?") + qs;
    }
    const hasBody = opts.body !== undefined;
    const bodyJson = hasBody ? JSON.stringify(opts.body) : undefined;
    const ifMatch = opts.ifMatch;
    // Ensure a session up front: if neither the cache nor the env seed has a
    // cookie, mint one via dev-login BEFORE the first real call (numu requires
    // an authenticated session on every /objects/* request). A pinned env
    // session is trusted on the first attempt and only re-minted on a 401.
    if (currentSessionCookie() == null) {
        await mintSession();
    }
    // First attempt — use whatever cookie is currently cached / env'd.
    try {
        return await doFetch(url, method, currentSessionCookie(), hasBody, bodyJson, ifMatch, path);
    }
    catch (err) {
        if (!(err instanceof CaseApiError) || err.status !== 401)
            throw err;
        // 401 path — invalidate the cache so a stale env seed can't be
        // reused, re-mint via numu's dev-login, then retry once.
        cachedSession = null;
        await mintSession();
        return await doFetch(url, method, currentSessionCookie(), hasBody, bodyJson, ifMatch, path);
    }
}
// ── public helpers ──────────────────────────────────────────────────
// create → POST /objects/case with the BARE field object. project_id is
// required; status starts at the workflow initial state (backlog);
// origin marks agent-filed cases; priority is mapped to numu's enum.
// Engine-owned readonly fields (workflow_id, reporter_id) are NEVER sent.
export async function createCase(args) {
    beginOperation();
    const body = {
        title: args.title,
        status: "backlog",
        origin: "agent",
    };
    if (args.description !== undefined)
        body.description = args.description;
    if (args.type !== undefined)
        body.type = args.type;
    const priority = mapPriority(args.priority);
    if (priority !== undefined)
        body.priority = priority;
    if (args.assignee_id !== undefined)
        body.assignee_id = args.assignee_id;
    if (args.project_id !== undefined)
        body.project_id = args.project_id;
    if (args.visibility !== undefined)
        body.visibility = args.visibility;
    const env = await apiFetch("/objects/case", { method: "POST", body });
    return unwrap(env);
}
export async function getCase(rid) {
    beginOperation();
    const env = await apiFetch(`/objects/case/${encodeURIComponent(rid)}`);
    return unwrap(env);
}
// list → GET /objects/case?limit&offset. numu's ListParams supports only
// limit/offset; RedPash's status/assignee/project/q filters are not
// available server-side. We translate size/page into limit/offset so the
// existing handlers.js arguments still work.
export async function listCases(args = {}) {
    beginOperation();
    const limit = args.size != null ? args.size : args.limit;
    let offset = args.offset;
    if (offset == null && args.page != null && args.size != null) {
        offset = (Math.max(1, args.page) - 1) * args.size;
    }
    const env = await apiFetch("/objects/case", {
        query: {
            limit: limit != null ? String(limit) : undefined,
            offset: offset != null ? String(offset) : undefined,
        },
    });
    const items = Array.isArray(env?.items) ? env.items.map(unwrap) : [];
    return {
        items,
        total: items.length,
        page: args.page ?? 1,
        size: args.size ?? items.length,
        limit: env?.limit,
        offset: env?.offset,
    };
}
// comment → POST /objects/comment with the BARE { subject_id, body }.
// The case rid maps to subject_id; the engine-owned author_id is NEVER sent.
export async function addComment(args) {
    beginOperation();
    const env = await apiFetch("/objects/comment", {
        method: "POST",
        body: { subject_id: args.rid, body: args.body },
    });
    return unwrap(env);
}
// set_status → optimistic-concurrency move. numu requires If-Match on a
// PATCH and rejects status skips (422 illegal_transition), so: (1) GET the
// case to read its current version/etag, (2) PATCH with a BARE { status }
// body and If-Match: W/"<version>". Only `status` is sent — title /
// priority / assignee stay untouched.
export async function setCaseStatus(args) {
    beginOperation();
    const current = await apiFetch(`/objects/case/${encodeURIComponent(args.rid)}`);
    const ifMatch = (current && current.etag)
        ? current.etag
        : `W/"${current?.version ?? 0}"`;
    const env = await apiFetch(`/objects/case/${encodeURIComponent(args.rid)}`, {
        method: "PATCH",
        body: { status: args.status },
        ifMatch,
    });
    return unwrap(env);
}
