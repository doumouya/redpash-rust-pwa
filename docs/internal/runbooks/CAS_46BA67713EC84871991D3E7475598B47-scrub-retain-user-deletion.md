---
title: 0011 — Scrub-retain user deletion (scrub_user_tx + sole-owner blocker + case-membership retention)
section: Internal
order: 11
last modified date: 2026-05-31
case_id: CAS_46BA67713EC84871991D3E7475598B47
status: resolved
---

# 0011 — Scrub-retain user deletion (scrub_user_tx + sole-owner blocker + case-membership retention)

**Date:** 2026-05-31 · **Area:** `backend/crates/api/src/db/users.rs` + `backend/crates/api/src/db/mod.rs` + `backend/crates/api/src/routes/users.rs` + `backend/crates/api/src/routes/admin.rs` · **Status:** resolved · **Case:** `CAS_46BA67713EC84871991D3E7475598B47`

## Problem Statement

Em 2026-05-31 shared the 4-step `scrub-and-retain` transaction directly: block on sole-ownership, strip active assignments (cases + teams), destroy auth + prefs, scrub PII while leaving the identity row in place. The intent: keep historical references resolvable ("reported by X" still renders something useful) while removing the user as an active actor.

The pre-fix `db::delete_user` at `db/users.rs:302-313` was a hard `DELETE FROM users WHERE redpash_id = $1` that CASCADEd every membership (including the `role='owner'` rows that strand projects without an owner per the function's own comment) and broke the audit-retention contract on the most-rendered surface — cases.

The workflow `wik561ah7` synthesis (2026-05-31 ~02:30 UTC) flagged this as the only branch of Em's broader RBAC proposal that CONTRADICTS current behavior — every other slice was "missing enforcement on a schema that already exists" but `delete_user` was actively destructive.

Workflow synthesis blocker #3 added a structural caveat to Em's transaction-as-written: step 2's `DELETE … WHERE object_redpash_id LIKE 'CAS_%'` would delete the Reporter / Case Owner membership rows, making `CASE_USER_JOINS` (db/mod.rs:1463-1493) return NULL, falling through to `cases.js:1849-1869`'s RID-fallback render `c.reporter_display_name || c.reporter_id || "—"` and surfacing **`—`** instead of **`Deleted User`** on the most-rendered surface in the app. The user's intent in step 2 was to remove the user from active-assignment *dropdowns* — but achieving it via DELETE on case memberships erases history too.

## Troubleshooting steps

1. **Read the current `db::delete_user`** at `db/users.rs:302-313`. The function comment itself admits: *"FKs from sessions + memberships (user side, ON DELETE CASCADE) take out the user's auth + their membership rows — including any role='owner' membership, which leaves those projects ownerless."* The function knew it was broken; nobody had picked it up.
2. **Locate the call sites.** `db::delete_user` is called from exactly two routes: `routes/users.rs:183` (`delete_one`) and `routes/admin.rs:1076` (`delete_user`). Both wired via dev-permissive `AUTH-AUDIT-ACK` gates. Replacement is a 2-route change.
3. **Find the parallel helper for the sole-owner check.** `db::company_owner_count` at `db/mod.rs:1053` already implements the "is there at least one owner left" check for company-member removal. The user-deletion variant needs to be "for each object where this user is an owner, is there another owner?" — same pattern, generalised across `memberships`, returning the list of blocking objects so the API can surface a useful 409.
4. **Confirm the post-migration column name.** The entity-membership migration (`7875079` + `77dcce5`, 2026-05-31 ~05:00 UTC) renamed `memberships.user_redpash_id` → `member_redpash_id` because the subject can hold a USER or a TEAM rid now. All sole-owner / scrub queries reference `member_redpash_id`.
5. **Validate the case-membership retention against the live JOIN path.** `CASE_USER_JOINS` (db/mod.rs:1463-1493) joins case memberships to `users.display_name`. After scrub-with-step-2-CAS-delete: the JOIN returns NULL, frontend renders RID. After scrub-with-step-2-CAS-skip + `display_name='Deleted User'`: the JOIN resolves through to `'Deleted User'`. Cheaper path, matches retention intent.
6. **Live smoke-test three paths** against the running `:8088` backend connected to the migrated `redpash_prerelease` DB:
   - Happy path A (route `/users/:rid`): create user via direct SQL → DELETE via API → verify `display_name='Deleted User'`, `email=NULL`, `google_sub=NULL`, `status='archived'`.
   - Happy path B (route `/admin/users/:rid`): same dance via the admin route → HTTP 204.
   - Blocker path C: user as sole company owner → DELETE returns HTTP 409 with `kind='sole_owner_blocker'` and the user row UNTOUCHED (transaction never started).
   - Retention check: user as case Reporter → scrub → GET case → `reporter_display_name = 'Deleted User'` (not NULL, not '—'); membership row preserved.

## RCA

The pre-fix flow was a "rely on FK CASCADE to do everything" pattern from the early-prerelease stage when no historical references existed yet. As cases shipped with reporter / assignee semantics that JOIN through memberships rows, the CASCADE-on-delete became a silent history-loss footgun. The function's docstring even acknowledged the problem ("leaves those projects ownerless") but offered no replacement; deletion was just *intentionally permissive* in dev mode and nobody had revisited it for production semantics.

The general lesson: **CASCADE is correct for purely structural FKs (a project's files belong to that project), but wrong for FKs that carry historical-reference semantics (a case's reporter membership is a long-lived audit trail).** Drawing the line *before* shipping the case-rendering surface would have prevented the contract from forming in the first place.

The step-2-CAS refinement is the same shape lesson at a smaller scope: a literal reading of "remove from active assignments" via DELETE would have shipped the same history-loss footgun that the hard `DELETE FROM users` was introducing. Filtering at the dropdown layer (via `users.status='active'`) instead of deleting at the source preserves the JOIN path that already worked.

## Solution

Four coordinated changes — `db/mod.rs` + `db/users.rs` (data layer) and `routes/users.rs` + `routes/admin.rs` (transport):

### 1. `db::user_sole_owner_objects` in `db/mod.rs` (next to `company_owner_count`)

```rust
pub async fn user_sole_owner_objects(
    pool: &PgPool,
    user_rid: &str,
) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT m1.object_redpash_id
         FROM memberships m1
         WHERE m1.member_redpash_id = $1
           AND m1.role = 'owner'
           AND NOT EXISTS (
             SELECT 1 FROM memberships m2
             WHERE m2.object_redpash_id = m1.object_redpash_id
               AND m2.member_redpash_id != $1
               AND m2.role = 'owner'
           )",
    )
    .bind(user_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(rid,)| rid).collect())
}
```

`DISTINCT` because the post-migration widened PK `(object, member_redpash_id, role, context_role)` allows the same user to hold multiple 'owner' rows on the same object (different `context_role`); the blocker should fire once per object.

### 2. `db::scrub_user_tx` in `db/users.rs` (replaces `db::delete_user`)

Single transaction over four statements: DELETE TEM_% memberships (cases kept), DELETE sessions, DELETE user_preferences, UPDATE users with PII NULLs + display_name='Deleted User' + status='archived'. Old `db::delete_user` deleted — no caller can fall back to the hard-delete path now (`grep -rn "db::delete_user"` returns empty).

### 3. `routes/users.rs::delete_one` + `routes/admin.rs::delete_user` (mirrored shape)

```rust
let blocking = db::user_sole_owner_objects(&state.db, &rid).await?;
if !blocking.is_empty() {
    return Err(AppError::conflict(
        "sole_owner_blocker",
        format!(
            "cannot scrub: user is sole owner of {} object(s); transfer ownership first",
            blocking.len()
        ),
    ));
}
let scrubbed = db::scrub_user_tx(&state.db, &rid).await?;
if !scrubbed {
    return Err(AppError::not_found("not_found", format!("user {rid}")));
}
crate::event::warn(&state.db, "user_scrub", format!("scrubbed user {rid}"))
    .user(caller)
    .context(serde_json::json!({ "user": rid }))
    .send();
```

Event renamed `user_delete` → `user_scrub` to honestly describe what happened — important for audit-trail honesty downstream.

## Post Checking

Three-scenario live smoke against `:8088` (post-77dcce5 binary) connected to migrated `redpash_prerelease` DB:

| Path | HTTP | Post-state |
|---|---|---|
| **A** — `DELETE /api/users/:rid` (no ownership) | `200 {ok:true, scrubbed:true}` | `display_name='Deleted User'`, `email=NULL`, `google_sub=NULL`, `status='archived'` ✓ |
| **B** — `DELETE /api/admin/users/:rid` (no ownership) | `204 No Content` | same as A ✓ |
| **C** — sole-owner blocker | `409 {kind:'sole_owner_blocker', error:'cannot scrub: user is sole owner of 1 object(s); transfer ownership first'}` | user row UNCHANGED — `email`/`status`/`display_name` all intact (transaction never ran) ✓ |
| **retention** — case reporter rendering | before: `'Will Be Scrubbed'`; after scrub: `'Deleted User'` (not NULL, not `'—'`) | case membership row preserved verbatim ✓ |

The retention path is the load-bearing verification — the workflow synthesis flagged it as the silent contract-break that "step 2 deletes case memberships" would have shipped. Confirmed end-to-end the alternative (step 2 skips CAS_%, relies on `users.status='active'` for dropdown filtering elsewhere) preserves the display contract.

## The discipline this updates

**Hard rule for any future user-lifecycle operation:**

> A user's identity rid (`USR_<rid>`) is a long-lived audit handle. Functions that "delete a user" MUST be either (a) scrub-retain (PII null, identity rid stays, `users.status='archived'`) or (b) blocked at the API boundary if no scrub variant exists. Hard `DELETE FROM users` is not a valid path because CASCADE wipes audit-retention memberships (reporter, author, assignee) and the most-rendered surface in the app falls through to RID-or-`—` instead of a meaningful display. Drop the hard DELETE; route every caller through `db::scrub_user_tx`.

**Corollary on FK CASCADE patterns:**

> `ON DELETE CASCADE` is correct for purely structural FKs (a project's files belong to that project, deletion of the project drops the files). It's WRONG for FKs that carry historical-reference semantics (a case's reporter membership is a long-lived audit trail). Drawing the line *before* shipping the rendering surface that consumes those references is cheaper than fixing it after a deletion contract has been baked in.

### Follow-ups worth a pass

- **`?status=active` filter on user-picker call sites** (separate slice, not in this commit per the case description's "follow-up" framing). Sites to gate: `/admin/users` user picker, `/search/users`, `/monitoring` user-activity lookups, `cases.js` mention autocomplete + assignee picker, `home.js` Memberships tab user dropdown. Until this lands, deleted users will still surface in dropdowns rendered as 'Deleted User' — annoying UX but not a data-loss bug.
- **Transfer-owner endpoint** (also referenced in the case description, deferred). The current scrub-retain flow returns 409 on sole-ownership but provides no clean way for the user to *transfer* ownership and retry. A `POST /api/users/:rid/transfer-ownership` or per-object `PATCH /api/companies/:rid/owner` would close this loop. Until then, manual SQL is the only path.
- **Frontend "Deleted User" badge on Home Users tab** — when `status='archived'` is exposed via the user list endpoint, render a visual marker so admin users can distinguish active vs scrubbed accounts. Cheap follow-up.
- **Cancel ROW LOCK considerations** — `scrub_user_tx` acquires no explicit lock. Under concurrent scrub + grant-ownership races (admin scrubs user X while another agent is granting them owner rights elsewhere), the new owner row could land *after* the sole-owner check but *before* the scrub completes, leaving an unintended scrub of a user who became sole-owner mid-transaction. Probability extremely low in dev; pre-prod tightening could add `SELECT … FOR UPDATE` on the memberships rows before the check.
- **The `delete_user_prefs` cascade question** — the post-fix `scrub_user_tx` explicitly DELETEs `user_preferences` because they're per-user runtime state with no audit value. If a future preference becomes audit-relevant (e.g., "what column-reorder did the user have when they filed this case"), this DELETE would erase context. Acceptable today; flag for the audit-storage subsystem's next review.

## Linked

- The implementation — this commit (next).
- The case discovery — `CAS_46BA67713EC84871991D3E7475598B47` (filed via MCP v2 self-healing post-restart).
- The audit that surfaced the contract gap — workflow `wik561ah7`, 2026-05-31 ~02:30 UTC, synthesis blocker #2 (db::delete_user) + #3 (reporter render contract). Output at `/tmp/claude-1000/.../wik561ah7.output`.
- The sibling RBAC migration that landed in parallel — `7875079` (entity-edge model) + `77dcce5` (subject column rename). `member_redpash_id` references throughout this runbook depend on `77dcce5` having landed first.
- The cadence under which this runbook is filed — `docs/internal/processes/bug-case-runbook-cadence.md`.
- Related discipline — [[bug-case-runbook-cadence]] (the cadence itself), [[process-oriented]] (encode the fix in tooling so the next agent can't reintroduce the hard-delete), [[no-code-debt]] (history-loss footguns are the worst form of debt — they're invisible until consulted).
