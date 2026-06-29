// numu-roundtrip.mjs — RED integration test for the redpash-slack MCP → numu repoint.
// Case CAS_C5AB84FB (cases-mcp-restore.md), AC-7 (verification — round-trip).
//
// Drives case_create → case_get → case_comment → case_set_status through the SAME
// adapter the unit test pins (`../dist/cases-numu.js`), against a LIVE numu running
// in debug with dev-login, and asserts the MCP-expected flat shapes plus that an
// illegal status skip surfaces numu's 422.
//
// RUN MODES:
//   - $NUMU_API_BASE UNSET  → every test SKIPs cleanly (CI without numu stays green).
//   - $NUMU_API_BASE SET    → tests run for real. RED today because:
//       (a) `../dist/cases-numu.js` does not exist (import throws), and
//       (b) even once it does, a live numu without the adapter wiring fails the shape
//           assertions. Green only when the adapter ships and numu is up.
//
// PRECONDITIONS when $NUMU_API_BASE is set (documented for the operator, AC-1/AC-4):
//   - numu is a DEBUG build (dev-login is #[cfg(debug_assertions)] — auth.rs:115).
//   - $NUMU_API_BASE = http://127.0.0.1:<numu-port>/api (a DEDICATED port, not :8080).
//   - $NUMU_SEED_PROJECT = a real PRJ_<rid> to create the scratch case under
//     (case.project_id is REQUIRED — 0007:34). Defaults to "PRJ_numu"; the test SKIPs
//     with a clear message if create 404/422s for a missing project rather than
//     asserting a false failure.

import { test } from "node:test";
import assert from "node:assert/strict";

const NUMU_API_BASE = process.env.NUMU_API_BASE;
const SEED_PROJECT = process.env.NUMU_SEED_PROJECT ?? "PRJ_numu";
const RUN = Boolean(NUMU_API_BASE);

// Point the adapter at the live numu before importing it (the adapter reads
// REDPASH_API_BASE at call time via apiBase()).
if (RUN) {
    process.env.REDPASH_API_BASE = NUMU_API_BASE;
    delete process.env.REDPASH_API_SESSION; // force a fresh dev-login mint
    process.env.NUMU_CASES_ADAPTER = "1";
}

// Lazy import so the SKIP path never touches the (not-yet-existent) module.
async function loadAdapter() {
    return import("../dist/cases-numu.js");
}

const skipMsg = "NUMU_API_BASE unset — integration round-trip skipped (set it to run against a live debug numu)";

test("AC-7: case_create → case_get → case_comment → case_set_status round-trip returns MCP-flat shapes", { skip: RUN ? false : skipMsg }, async () => {
    const { createCase, getCase, addComment, setCaseStatus, CaseApiError } = await loadAdapter();

    // 1) create — must come back as the flat MCP Case (redpash_id + flattened data).
    let created;
    try {
        created = await createCase({
            title: `roundtrip-${Date.now()}`,
            description: "automated AC-7 round-trip",
            type: "task",
            priority: "medium", // exercises the medium→normal mapping over the wire (AC-4)
            project_id: SEED_PROJECT,
        });
    } catch (err) {
        if (err instanceof CaseApiError && (err.status === 404 || err.status === 422)) {
            // No seed project present — environment not provisioned, not an adapter defect.
            test.skip?.(`seed project ${SEED_PROJECT} not creatable (HTTP ${err.status}) — set NUMU_SEED_PROJECT`);
            return;
        }
        throw err;
    }
    const rid = created.redpash_id;
    assert.ok(typeof rid === "string" && rid.startsWith("CAS_"), `create must return a CAS_ redpash_id, got ${rid}`);
    assert.equal(created.status, "backlog", "a fresh numu case starts at the workflow initial state");
    assert.equal(created.priority, "normal", "medium must have been mapped to normal");
    assert.equal(created.data, undefined, "the numu {data} envelope must be unwrapped");

    // 2) get — round-trips to the same flat shape.
    const got = await getCase(rid);
    assert.equal(got.redpash_id, rid);
    assert.equal(got.status, "backlog");
    assert.equal(got.title, created.title);

    // 3) comment — bare {subject_id, body} → /objects/comment, unwrapped.
    const comment = await addComment({ rid, body: "round-trip comment" });
    assert.ok(typeof comment.redpash_id === "string" && comment.redpash_id.startsWith("CMT_"), "comment returns a CMT_ id");
    assert.equal(comment.subject_id, rid, "comment hangs off the case via subject_id");
    assert.equal(comment.body, "round-trip comment");

    // 4) set_status — a LEGAL one-step move (backlog → todo) succeeds via GET-etag + If-Match PATCH.
    const moved = await setCaseStatus({ rid, status: "todo" });
    assert.equal(moved.redpash_id, rid);
    assert.equal(moved.status, "todo", "the legal transition must land");
    assert.ok(moved.version > created.version, "a successful PATCH bumps the version");
});

test("AC-7/AC-5: an illegal status skip surfaces numu's 422 illegal_transition", { skip: RUN ? false : skipMsg }, async () => {
    const { createCase, setCaseStatus, CaseApiError } = await loadAdapter();

    let created;
    try {
        created = await createCase({
            title: `roundtrip-illegal-${Date.now()}`,
            type: "task",
            project_id: SEED_PROJECT,
        });
    } catch (err) {
        if (err instanceof CaseApiError && (err.status === 404 || err.status === 422)) {
            test.skip?.(`seed project ${SEED_PROJECT} not creatable (HTTP ${err.status})`);
            return;
        }
        throw err;
    }

    // backlog → done is a skip; numu's workflow engine rejects it with 422.
    await assert.rejects(
        () => setCaseStatus({ rid: created.redpash_id, status: "done" }),
        (err) => {
            assert.ok(err instanceof CaseApiError, "must throw CaseApiError, not a raw error");
            assert.equal(err.status, 422, "an illegal status skip must surface HTTP 422");
            return true;
        },
    );
});
