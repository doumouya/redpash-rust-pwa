---
title: 0008 — MCP cases bridge needs auto-refreshing session (env-pin is fragile)
section: Internal
order: 8
last modified date: 2026-05-31
case_id: TBD
filename_pending_rename: CAS_<rid>-mcp-cases-session-auto-refresh.md
status: proposal (draft)
---

# 0008 — MCP cases bridge needs auto-refreshing session (env-pin is fragile)

**Date:** 2026-05-31 · **Area:** `tools/mcp-server/src/cases.ts` (MCP bridge → `/api/cases`) · **Status:** proposal (draft, fix pending)

> **Filename note:** This entry uses the legacy `NNNN-<slug>.md` naming
> because the cases MCP was 401-blocked when it was filed. Rename to
> `CAS_<rid>-mcp-cases-session-auto-refresh.md` once the MCP is back
> up and a case is allocated — see the
> [cadence](../processes/bug-case-runbook-cadence.md).

## Problem Statement

The MCP cases bridge (`tools/mcp-server/dist/cases.js`, `apiFetch`
helper) reads `REDPASH_API_SESSION` from process env once at startup
and pins that value as the `rp_session` cookie for every request to
`/api/cases/*`. The env is set in `~/.claude.json` under
`mcpServers.redpash-slack.env`. When the pinned session expires (30-
day `Max-Age` from the dev-login `Set-Cookie`, or any backend
invalidation event), every Torv's `case_create` / `case_list` /
`case_get` call returns:

```
HTTP 401
{ "error": "no session cookie", "kind": "unauthenticated" }
```

…until someone notices, manually mints a fresh cookie via
`POST /api/auth/dev-login`, edits `~/.claude.json` by hand, and
restarts Claude Code. Em 2026-05-31: *"this is not a viable long term
plan"* — same critique that landed
[runbook 0007](0007-column-drag-reorder-cluster.md) (un-documented
bug pile) but applied to auth: an undocumented manual rotation step
that no Torv knows about until they hit the 401.

This blocked the natural close-out of runbook 0007 (couldn't file the
column-drag cluster case at discovery time, can't link the runbook to
a `CAS_<rid>` filename) and earlier in the session blocked
`case_create` during the column-drag session itself ("yea true, there
is a big job in the backend at the moment").

## Troubleshooting steps

1. `curl /api/cases` without a cookie → `HTTP 401, "no session cookie"`. Backend is up, auth gate works as designed.
2. `curl -X POST /api/auth/dev-login` → `HTTP 204` with `Set-Cookie: rp_session=SES_<new>; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`. Fresh cookie mintable on demand, no rate limit.
3. `curl /api/cases -H "Cookie: rp_session=SES_<new>"` → `HTTP 200` + real case data (e.g. `CAS_1E8DCCF6E35A4CEA88B6EC4DD331A310 "Polars 0.43 lazy-sort drops rows after group_by"`). Fresh cookie works end-to-end.
4. Read `~/.claude.json` `mcpServers.redpash-slack.env` → `REDPASH_API_SESSION` was pinned to `SES_8751787ACD564F749B383E5FC1C9D907`, which the backend now rejects. Confirms expiration / invalidation, not a bridge bug.
5. Read `tools/mcp-server/dist/cases.js:31-37` — `sessionCookie()` returns env or null; no fetch, no refresh path. The bridge is intentionally minimal (per its own docstring: *"the bridge is a transport adapter"*) — fine for the canonical-host case but wrong for a long-lived MCP that survives backend restarts.

## RCA

The bridge was designed for a *static* env-pinned identity (per the
docstring on `dist/cases.js:7-19`: "The bridge is per-agent in stdio
mode … the session identity IS the agent's identity"). That made
sense when the cookie's lifetime was assumed to match the agent's
lifetime — restart Claude Code, restart the MCP, mint a new cookie
in `dev-login`, pin it.

In practice the Torv pool keeps Claude Code instances alive for days,
the cookie's 30-day Max-Age doesn't survive backend restarts or
session-table truncations during dev, and there's no operator-facing
signal that "your cookie has expired, mint a new one and edit
`~/.claude.json`." The 401 is the only feedback, and only when an
agent actually tries to use the cases MCP — silent until that point.

This is the same anti-pattern that lives behind every "fix-it-once"
runbook entry: a recurring manual step that fails silently until
something breaks, then re-emerges as soon as memory fades. The
[process-oriented](../../../../home/mansa/.claude/projects/-home-mansa/memory/feedback_process_oriented.md)
discipline says encode it in code/tooling, not in agent memory.

## Solution (proposed)

Two-layer fix in `tools/mcp-server/src/cases.ts`:

1. **Lazy session init.** If `REDPASH_API_SESSION` is unset at first
   request, call `POST /api/auth/dev-login`, read the `Set-Cookie`
   header, cache the value in module-scope state, use it from then on.

2. **Self-healing 401 retry.** On any `/api/cases/*` response with
   status 401, clear the cached cookie, re-mint via dev-login, retry
   the original request *exactly once* (no infinite loop). If the
   retry also 401s, return the original error to the caller — that's
   a real auth problem (dev-login itself broken, backend not
   configured for dev-permissive, etc.) and shouldn't be silently
   swallowed.

`REDPASH_API_SESSION` env can stay supported as an *override*
(useful for CI / canonical-host pinning) but should no longer be
*required*. The env-pin docstring on `dist/cases.js:7-19` updates
accordingly.

Tradeoffs:
- **Identity:** the env-pin tied the MCP to a specific human's
  session (Em's, via the canonical host). Auto-mint via dev-login
  uses whatever dev-login returns — currently a single shared dev
  user. For the v1 stdio-per-agent model that's fine; for a
  multi-agent HTTP-transport mode it would need explicit identity
  per call, which is already noted as out-of-scope in the bridge's
  docstring.
- **Audit attribution:** today's `slack_*` and `case_*` calls
  attribute to `woz_48` regardless of actor (per
  [[project-agent-identities]]). Auto-refresh doesn't change that —
  the dev-login session is still single-identity.
- **Failure modes:** the retry-on-401 path adds one round-trip per
  expired-cookie call. Acceptable since expiration is rare and the
  alternative is the current "every Torv 401s until someone
  notices" silence.

## Post Checking (planned, post-fix)

1. Unpin `REDPASH_API_SESSION` from `~/.claude.json`, restart
   Claude Code, observe `case_list` succeed on first call (lazy init
   path).
2. Re-pin a known-stale `REDPASH_API_SESSION`, restart, observe
   `case_list` 401 → auto-mint → retry → 200 (self-healing path).
3. Stop the backend, restart, hit case_list, observe two-phase
   recovery (dev-login succeeds after backend warms up, retry
   succeeds).
4. Hit `case_list` 100× in a tight loop, observe exactly one
   dev-login call total (the cached cookie stays warm).
5. `tools/audit.sh` clean — no behavior regression on the slack-side
   MCP tools that share the bridge.

## The discipline this updates

For any MCP bridge that wraps an auth-gated HTTP API:

- **Don't pin secrets in env-only with no refresh path.** A static
  env-pinned token is fine when the token outlives the process, but
  every MCP we ship outlives its tokens. Always have a refresh path,
  even if the path is "call this dev-only mint endpoint."
- **Lazy init + retry-once-on-401 is the floor.** The bridge should
  never silently swallow a 401 *or* loop on it.
- **Surface the secret-source in the bridge docstring.** If the
  bridge depends on a particular env var, the docstring at the top
  of the file should say so — and say what to do when it goes stale.
  The current docstring on `dist/cases.js` says where the env
  *comes from* but not what to do when it *fails*.
- **MCP outages are now caught by [[bug-case-runbook-cadence]].** This
  entry is itself the worked example: the 401 wasn't blocking
  anyone catastrophically (cases workstream wasn't on a critical
  path today), but the un-documented manual rotation step would have
  silently bitten the next agent. Catching it as a runbook means the
  next "MCP is down" can reach for the auto-mint code path instead
  of guessing.

### Follow-ups worth a pass

- **MCP slack-tools** (`slack_append_entry`, `slack_read_since`,
  case_comment, etc.) share the same `apiFetch` helper — fix
  benefits all of them at once. Verify in the post-fix audit that no
  slack-side caller has a different cookie path.
- **HTTP-transport mode** (v2/v3, per
  [[project-mcp-server-lane]]) will need per-call identity. Once
  the auto-mint lands, the v2 transport can layer a per-request
  cookie injection over the same helper, with the auto-mint as the
  default fallback when the per-call cookie is absent.
- **Tooling:** a `tools/mcp-audit/` static check that scans
  `tools/mcp-server/src/` for `apiFetch`-style helpers and confirms
  they have a 401 retry path. Sister to the proposed
  `tools/runbook-audit/` from [runbook 0007](0007-column-drag-reorder-cluster.md).

## Linked

- The current bridge — [`tools/mcp-server/dist/cases.js`](../../../tools/mcp-server/dist/cases.js) (source at `tools/mcp-server/src/cases.ts`).
- The backend auth route — `backend/crates/api/src/routes/auth.rs` (`POST /auth/dev-login`).
- The MCP server config — `~/.claude.json` `mcpServers.redpash-slack.env`.
- The first runbook this cadence produced — [0007 column-drag-reorder-cluster](0007-column-drag-reorder-cluster.md).
- The cadence behind this entry — [bug-case-runbook-cadence](../processes/bug-case-runbook-cadence.md).
- Related memory — [[process-oriented]] (encode the fix in tooling, not in agent memory).
- **Case ID:** TBD — `case_create` MCP currently 401-blocked by exactly the bug this runbook documents. File the case + rename the file once the immediate `~/.claude.json` env patch is rotated and a Claude Code restart picks it up.
