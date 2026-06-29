// numu-adapter.test.mjs — RED unit tests for the redpash-slack MCP → numu repoint adapter.
// Case CAS_C5AB84FB (cases-mcp-restore.md), Checkpoint 1. Tester owns this file.
//
// WHAT THIS LOCKS DOWN (the request/response MAPPING — no live server):
//   The adapter module the coder must build is `../dist/cases-numu.js`. It mirrors the
//   public surface of the current RedPash `cases.js` (so `handlers.js` can select it by
//   env flag — AC-6) but targets numu's generic-object surface:
//     export function createCase(args)       -> POST   /objects/case      (bare body)
//     export function getCase(rid)           -> GET    /objects/case/:rid
//     export function addComment(args)       -> POST   /objects/comment   (bare body)
//     export function setCaseStatus(args)    -> GET then PATCH /objects/case/:rid (If-Match)
//     export function listCases(args)        -> GET    /objects/case?limit&offset
//     export class CaseApiError extends Error { status; body }
//
// These are RED by design: `../dist/cases-numu.js` does not exist yet. `import` throws
// ERR_MODULE_NOT_FOUND, which fails every test. The coder makes them green; they MUST NOT
// edit this file (that boundary is what makes the assertions meaningful).
//
// Each test cites the spec AC it encodes. Mapping table is in cases-mcp-restore.md
// "API contracts (exact)".

import { test } from "node:test";
import assert from "node:assert/strict";

const NUMU_BASE = "http://127.0.0.1:8090/api"; // numu on a DEDICATED port, NOT :8080 (AC-1/AC-3, Risk f)

// ── fetch mock harness ──────────────────────────────────────────────────────
// Records every call (url, method, headers, body) and replays a scripted queue
// of responses so we can assert what the adapter *sent*, deterministically.
function installFetch(script) {
    const calls = [];
    const queue = [...script];
    globalThis.fetch = async (url, init = {}) => {
        const headers = init.headers ?? {};
        // Normalise header access regardless of plain-object vs Headers.
        const get = (k) =>
            headers instanceof Headers
                ? headers.get(k)
                : Object.entries(headers).find(([h]) => h.toLowerCase() === k.toLowerCase())?.[1];
        calls.push({
            url: String(url),
            method: init.method ?? "GET",
            cookie: get("Cookie") ?? get("cookie") ?? null,
            ifMatch: get("If-Match") ?? get("if-match") ?? null,
            contentType: get("Content-Type") ?? get("content-type") ?? null,
            body: init.body != null ? JSON.parse(init.body) : undefined,
            rawBody: init.body,
        });
        const next = queue.shift();
        if (!next) throw new Error(`fetch mock: no scripted response for ${init.method ?? "GET"} ${url}`);
        return makeResponse(next);
    };
    return calls;
}

function makeResponse({ status = 200, json = undefined, setCookie = undefined }) {
    const hdrs = new Headers();
    hdrs.set("content-type", "application/json");
    if (setCookie) hdrs.set("set-cookie", setCookie);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: hdrs,
        async json() {
            return json;
        },
        async text() {
            return json != null ? JSON.stringify(json) : "";
        },
    };
}

// Reset env between tests so cookie-cache / base-url state can't leak across cases.
function resetEnv() {
    process.env.REDPASH_API_BASE = NUMU_BASE;
    delete process.env.REDPASH_API_SESSION;
    process.env.NUMU_CASES_ADAPTER = "1"; // env flag selecting the numu adapter (AC-6)
}

// A canonical numu create/get response envelope: { id, type, data, version, etag }.
function caseEnvelope(overrides = {}) {
    return {
        id: "CAS_abc123",
        type: "case",
        version: 1,
        etag: 'W/"1"',
        data: {
            title: "Repoint the MCP",
            description: "do the thing",
            type: "task",
            status: "backlog",
            priority: "normal",
            origin: "agent",
            project_id: "PRJ_numu",
            workflow_id: "default",
        },
        ...overrides,
    };
}

// Import lazily inside each test so the module-not-found error is attributed to the
// specific test (and the whole file stays RED until the coder ships the adapter).
async function loadAdapter() {
    return import("../dist/cases-numu.js");
}

// ── AC-6 / mapping: create → POST /objects/case with the BARE field object ───
test("AC-6: case_create POSTs /objects/case with a bare top-level body (no {data} wrapper)", async () => {
    resetEnv();
    const calls = installFetch([
        { status: 200, setCookie: "numu_session=devtok; HttpOnly; Path=/" }, // dev-login mint
        { status: 201, json: caseEnvelope() },
    ]);
    const { createCase } = await loadAdapter();

    await createCase({ title: "Repoint the MCP", description: "do the thing", project_id: "PRJ_numu" });

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/objects/case"));
    assert.ok(post, "expected a POST to /objects/case");
    assert.equal(post.url, `${NUMU_BASE}/objects/case`, "create must hit numu /objects/case (not /cases)");
    assert.equal(post.contentType, "application/json");

    // Bare field object at top level — NOT { data: {...} }.
    assert.equal(post.body.data, undefined, "create body must NOT be wrapped in {data:{...}}");
    assert.equal(post.body.title, "Repoint the MCP");
    assert.equal(post.body.project_id, "PRJ_numu", "project_id is required and must be sent");
    assert.equal(post.body.status, "backlog", "create must start at the workflow initial state");
    assert.equal(post.body.origin, "agent", "the MCP marks agent-origin cases");

    // Engine-owned readonly fields must NOT be sent (numu rejects them on create).
    assert.equal("workflow_id" in post.body, false, "must omit readonly workflow_id");
    assert.equal("reporter_id" in post.body, false, "must omit readonly reporter_id");
});

// ── AC-4 / mapping: priority values are mapped onto numu's enum ──────────────
test("AC-4: case_create maps RedPash priority medium→normal and critical→urgent", async () => {
    resetEnv();
    const c1 = installFetch([
        { status: 200, setCookie: "numu_session=devtok" },
        { status: 201, json: caseEnvelope() },
    ]);
    const { createCase } = await loadAdapter();
    await createCase({ title: "x", project_id: "PRJ_numu", priority: "medium" });
    const p1 = c1.find((c) => c.method === "POST" && c.url.endsWith("/objects/case"));
    assert.equal(p1.body.priority, "normal", "medium must map to numu's `normal`");

    const c2 = installFetch([
        { status: 200, setCookie: "numu_session=devtok" },
        { status: 201, json: caseEnvelope() },
    ]);
    await createCase({ title: "y", project_id: "PRJ_numu", priority: "critical" });
    const p2 = c2.find((c) => c.method === "POST" && c.url.endsWith("/objects/case"));
    assert.equal(p2.body.priority, "urgent", "critical must map to numu's `urgent`");
});

// ── AC-6 / mapping: create response is UNWRAPPED to the flat MCP shape ───────
test("AC-6: case_create unwraps {id,type,data,version,etag} into the flat MCP Case", async () => {
    resetEnv();
    installFetch([
        { status: 200, setCookie: "numu_session=devtok" },
        { status: 201, json: caseEnvelope() },
    ]);
    const { createCase } = await loadAdapter();
    const created = await createCase({ title: "Repoint the MCP", project_id: "PRJ_numu" });

    // handlers.js reads `created.redpash_id`, `created.title`, `created.status`.
    assert.equal(created.redpash_id, "CAS_abc123", "id must surface as redpash_id");
    assert.equal(created.title, "Repoint the MCP", "data.* fields must be flattened to top level");
    assert.equal(created.status, "backlog");
    assert.equal(created.version, 1);
    // The raw {data:{...}} envelope must NOT leak through unflattened.
    assert.equal(created.data, undefined, "the numu {data} envelope must be unwrapped, not passed through");
});

// ── AC-6 / mapping: get → GET /objects/case/:id, unwrapped ──────────────────
test("AC-6: case_get GETs /objects/case/:id and unwraps the envelope", async () => {
    resetEnv();
    const calls = installFetch([
        { status: 200, setCookie: "numu_session=devtok" },
        { status: 200, json: caseEnvelope() },
    ]);
    const { getCase } = await loadAdapter();
    const detail = await getCase("CAS_abc123");

    const get = calls.find((c) => c.method === "GET" && c.url.endsWith("/objects/case/CAS_abc123"));
    assert.ok(get, "expected GET /objects/case/CAS_abc123");
    assert.equal(get.url, `${NUMU_BASE}/objects/case/CAS_abc123`);
    assert.equal(detail.redpash_id, "CAS_abc123", "get must unwrap id → redpash_id");
    assert.equal(detail.title, "Repoint the MCP");
    assert.equal(detail.status, "backlog");
});

// ── AC-6 / mapping: comment → POST /objects/comment with bare {subject_id, body} ──
test("AC-6: case_comment POSTs /objects/comment with bare {subject_id, body} (not /cases/:id/comments)", async () => {
    resetEnv();
    const calls = installFetch([
        { status: 200, setCookie: "numu_session=devtok" },
        { status: 201, json: { id: "CMT_1", type: "comment", version: 1, etag: 'W/"1"', data: { subject_id: "CAS_abc123", body: "hello" } } },
    ]);
    const { addComment } = await loadAdapter();
    const comment = await addComment({ rid: "CAS_abc123", body: "hello" });

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/objects/comment"));
    assert.ok(post, "expected a POST to /objects/comment");
    assert.equal(post.url, `${NUMU_BASE}/objects/comment`, "comments route to /objects/comment, NOT /cases/:id/comments");
    assert.equal(post.body.data, undefined, "comment body must be bare (no {data} wrapper)");
    assert.equal(post.body.subject_id, "CAS_abc123", "the case id maps to subject_id");
    assert.equal(post.body.body, "hello");
    assert.equal("author_id" in post.body, false, "must omit engine-owned author_id");
    assert.equal(comment.redpash_id, "CMT_1", "comment response is unwrapped too");
});

// ── AC-6 / mapping: set_status reads etag from a prior GET, sends If-Match on PATCH ──
test("AC-6: case_set_status GETs the case, then PATCHes /objects/case/:id with bare {status} + If-Match", async () => {
    resetEnv();
    const calls = installFetch([
        { status: 200, setCookie: "numu_session=devtok" },                 // dev-login mint
        { status: 200, json: caseEnvelope({ version: 3, etag: 'W/"3"' }) }, // the GET that reads the etag
        { status: 200, json: caseEnvelope({ version: 4, etag: 'W/"4"', data: { ...caseEnvelope().data, status: "todo" } }) }, // the PATCH
    ]);
    const { setCaseStatus } = await loadAdapter();
    const updated = await setCaseStatus({ rid: "CAS_abc123", status: "todo" });

    const get = calls.find((c) => c.method === "GET" && c.url.endsWith("/objects/case/CAS_abc123"));
    const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/objects/case/CAS_abc123"));
    assert.ok(get, "set_status must first GET the case to read its current version/etag");
    assert.ok(patch, "set_status must PATCH /objects/case/:id");

    // If-Match must carry the version read from the prior GET, in weak-etag form W/"<version>".
    assert.equal(patch.ifMatch, 'W/"3"', "PATCH must send If-Match from the GET's etag (version 3)");
    assert.equal(patch.body.data, undefined, "set_status PATCH body must be bare {status}");
    assert.equal(patch.body.status, "todo");
    // Only status — title/priority/assignee untouched.
    assert.deepEqual(Object.keys(patch.body), ["status"], "PATCH must send ONLY status");
    assert.equal(updated.status, "todo", "response unwrapped to the updated status");
    assert.equal(updated.version, 4);
});

// ── AC-6 / mapping: an illegal status move surfaces numu's 422 as CaseApiError ──
test("AC-6: case_set_status surfaces a 422 illegal_transition as CaseApiError(422)", async () => {
    resetEnv();
    installFetch([
        { status: 200, setCookie: "numu_session=devtok" },                 // mint
        { status: 200, json: caseEnvelope({ version: 1, etag: 'W/"1"' }) }, // GET
        { status: 422, json: { kind: "illegal_transition", message: "backlog -> done is not a legal transition" } }, // PATCH rejected
    ]);
    const { setCaseStatus, CaseApiError } = await loadAdapter();
    await assert.rejects(
        () => setCaseStatus({ rid: "CAS_abc123", status: "done" }),
        (err) => {
            assert.ok(err instanceof CaseApiError, "must throw CaseApiError");
            assert.equal(err.status, 422, "illegal transition is HTTP 422");
            return true;
        },
    );
});

// ── AC-6 / auth: dev-login mints the numu_session cookie and the adapter sends it ──
test("AC-6: adapter mints via /auth/dev-login and sends the numu_session cookie on every call", async () => {
    resetEnv();
    const calls = installFetch([
        { status: 200, setCookie: "numu_session=devtok; HttpOnly; SameSite=Lax; Path=/" }, // dev-login
        { status: 201, json: caseEnvelope() },
    ]);
    const { createCase } = await loadAdapter();
    await createCase({ title: "x", project_id: "PRJ_numu" });

    const login = calls.find((c) => c.url.endsWith("/auth/dev-login"));
    assert.ok(login, "must mint via POST /auth/dev-login");
    assert.equal(login.method, "POST");

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/objects/case"));
    assert.ok(post.cookie, "the create call must carry a Cookie header");
    assert.match(post.cookie, /numu_session=devtok/, "cookie must be numu_session (NOT rp_session)");
    assert.doesNotMatch(post.cookie, /rp_session=/, "must not use the RedPash rp_session cookie");
});

// ── AC-6 / auth: a 401 re-mints via numu dev-login and retries once ─────────
test("AC-6: a 401 invalidates the cache, re-mints via numu /auth/dev-login, and retries once", async () => {
    resetEnv();
    process.env.REDPASH_API_SESSION = "staletok"; // a pinned-but-stale numu_session value
    const calls = installFetch([
        { status: 401, json: { kind: "unauthorized" } },                 // first attempt with the stale cookie
        { status: 200, setCookie: "numu_session=freshtok; Path=/" },     // re-mint via dev-login
        { status: 201, json: caseEnvelope() },                            // retried create succeeds
    ]);
    const { createCase } = await loadAdapter();
    const created = await createCase({ title: "x", project_id: "PRJ_numu" });

    const login = calls.find((c) => c.url.endsWith("/auth/dev-login"));
    assert.ok(login, "the 401 path must re-mint via numu's dev-login URL");
    // The retried create must carry the freshly-minted numu_session.
    const retried = calls.filter((c) => c.method === "POST" && c.url.endsWith("/objects/case"));
    assert.equal(retried.length, 2, "create is attempted twice (initial 401 + retry)");
    assert.match(retried[1].cookie, /numu_session=freshtok/, "retry must use the re-minted numu_session");
    assert.equal(created.redpash_id, "CAS_abc123");
});

// ── AC-1/AC-3: the base URL is numu on a dedicated port, never RedPash :8080 ──
test("AC-1/AC-3: REDPASH_API_BASE points the adapter at numu (not the RedPash :8080 default)", async () => {
    resetEnv();
    const calls = installFetch([
        { status: 200, setCookie: "numu_session=devtok" },
        { status: 200, json: caseEnvelope() },
    ]);
    const { getCase } = await loadAdapter();
    await getCase("CAS_abc123");
    for (const c of calls) {
        assert.match(c.url, /^http:\/\/127\.0\.0\.1:8090\/api\//, `every call must hit the numu base, got ${c.url}`);
        assert.doesNotMatch(c.url, /:8080/, "must not fall back to the RedPash :8080 default");
        assert.doesNotMatch(c.url, /\/cases(\/|$|\?)/, "must use /objects/* routes, not RedPash /cases/*");
    }
});
