---
title: 0008 — MCP cases bridge needs auto-refreshing session (env-pin is fragile)
section: Internal
order: 8
last modified date: 2026-05-31
case_id: CAS_097E36B6F6904E429401F4951A54BA9B
status: resolved
---

# 0008 — MCP cases bridge needs auto-refreshing session (env-pin is fragile)

**Date:** 2026-05-31 · **Area:** `tools/mcp-server/src/cases.ts` (MCP bridge → `/api/cases`) · **Status:** resolved — proposed → shipped same day per Em 2026-05-31 *"ship the auto-refresh implementation in tools/mcp-server/src/cases.ts."* · **Case:** `CAS_097E36B6F6904E429401F4951A54BA9B`

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

## Solution (shipped)

Two-layer fix landed in `tools/mcp-server/src/cases.ts`:

1. **Lazy session init.** `currentSessionCookie()` returns the
   module-scope `cachedSession` if set, else falls back to the
   `REDPASH_API_SESSION` env, else `null`. When the cache and env
   are both empty, `apiFetch` passes `null` cookie → backend 401s →
   the retry-on-401 path mints a fresh session and retries.

2. **Self-healing 401 retry.** Top-level `apiFetch` wraps the actual
   HTTP work in a `try` / `catch`. On a `CaseApiError` with
   `status === 401`, it clears `cachedSession`, calls
   `mintSession()` (which POSTs `/auth/dev-login`, parses the
   `Set-Cookie` header for `rp_session=…`, writes it to the cache),
   then retries the same request exactly once. If the retry also
   401s, the error surfaces — that's a real auth problem
   (dev-login itself broken, backend not configured for
   dev-permissive, etc.).

3. **Mint coalescer.** `mintInFlight` holds the in-flight mint
   promise; concurrent 401-driven retries share one mint round-trip
   instead of stampeding `dev-login` when several MCP tool calls
   401 simultaneously.

`REDPASH_API_SESSION` env stays supported as an *initial seed* —
useful for CI / canonical-host pinning, and the cache only
overrides it after a successful mint. The docstring at the top of
the file documents the v2 behaviour.

Implementation notes:
- `doFetch` (private) is the linear one-round-trip helper; `apiFetch`
  (exported) is the 401-aware wrapper. Splitting them keeps the
  retry logic readable and avoids recursive `apiFetch` calls.
- The `rp_session=…` regex is permissive (`[^;,\s]+`) because Node's
  `fetch` joins multiple `Set-Cookie` headers with commas — the
  comma-stop matters when other cookies are also set in the same
  response.
- Error attribution: on mint failure, a `CaseApiError` with the
  underlying `/auth/dev-login` status surfaces so the agent sees
  the actual broken hop, not a generic 401 from the retried call.

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

## Post Checking (done)

Smoke-tested the four code paths against the live backend on
`localhost:8080` (4 invocations of `listCases({ size: 1 })` returning
`HTTP 200, items=1, total=13`):

| Scenario | env | cache state | Outcome |
|---|---|---|---|
| no env, no cache | unset | cold | lazy mint fires → cache warms → 200 ✓ |
| no env, warm cache | unset | warm (from prior call) | cache used directly, no mint → 200 ✓ |
| stale env, warm cache | `SES_KNOWN_STALE_…` | warm | cache wins over env → 200 ✓ |
| stale env, cold cache | `SES_KNOWN_STALE_…` | cold | first call 401 → mint → retry → 200 ✓ |

Pending verification once Em restarts Claude Code:
- `case_create` + `case_list` via the live MCP from another agent's
  perspective (this session's MCP subprocess still has the v1 dist
  loaded; only a CC restart picks up the v2).
- Concurrent retry coalescing: spawn N parallel MCP tool calls
  against a stale-env start, count dev-login round-trips in the
  backend Events log — expected: exactly 1.

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
- **Case ID:** `CAS_097E36B6F6904E429401F4951A54BA9B` (filed 2026-05-31 02:16 UTC via MCP v2 after the fix shipped — the case itself was filed through the new self-healing path, end-to-end validation that the chicken-and-egg is gone).
