---
title: tools/list-endpoint-rbac-audit/audit.js
source: ../../../../../tools/list-endpoint-rbac-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-03
---

# list-endpoint-rbac-audit

## Purpose

Backend list-endpoint RBAC posture scanner. Classifies every
`db::list_*` (and similar list-shaped functions) by the reach of their
caller filter — reach-aware, strict-owner, scope-filtered,
caller-blind, ambiguous — so the bug class CAS_3B0DAD92 surfaced (list
endpoints filtering direct membership only, blind to cascade-visible
rows) can be enumerated once instead of hit-by-user one at a time.

The structural-detector for the bug class, per
[`build-for-unknown-failures`](../../../../../../.claude-memory-equivalent) —
same architectural shape as the codec registry + adversarial LLM
suites: build the detector so one finding becomes N.

## Public surface

`node tools/list-endpoint-rbac-audit/audit.js [backendDir]`

- Default scan path: `backend/crates/api/src/db/`.
- Output: `audit.json` (machine, sorted red-first) + `audit.html`
  (human, color-coded rows) + stdout summary.

## Classifications

| Class | Health | Meaning | Exemplar |
|-------|--------|---------|----------|
| `reach-aware` | green | uses `principals()`, `= ANY($1)`, `GRANT_SQL`, `resolve_grant`, `require_view`, any `viewer: Option<&…>` caller-scope param (list_cases' `&[String]` principals slice OR list_events' single caller rid the SQL filters on — 2026-06-03), **OR an inline platform-admin bypass (`role='admin'`) / company cascade (`object_redpash_id = …company_id`)** — the last two added 2026-06-01 so a reach-aware inline-SQL fix (CAS_3B0DAD92 `list_projects`) isn't mis-flagged strict-owner by its owner-*display* join's `role='owner'`. **CORRECT.** | `db::list_cases` |
| `scope-filtered` | yellow | filters by a parent-scope rid (project_redpash_id, file_redpash_id, case_id, object_redpash_id, company_id). The route must `require_view(scope)` before calling — v2 cross-ref will verify. | `db::list_files_in_project` |
| `caller-blind` | yellow | no `$n` bind site at all. Acceptable for admin endpoints + public taxonomies IF the route gates. | `db::list_users` |
| `ambiguous` | yellow\* | `member_redpash_id = $n` without `role='owner'` pin (often a `$1` that only feeds a `my_role` **display** subquery — the "looks-scoped-but-isn't" trap), OR no matched pattern. \*v2 recolors **RED** if behind an ungated `TENANT_DATA_NESTS` nest. | `db::list_companies` (v2: **RED** — ungated `/companies`; tenant-isolation vs. join-discovery intent pending Em's product call) |
| `strict-owner` | red | filters `member_redpash_id = $n AND role = 'owner'` with no cascade JOIN / principals closure. **BUG CLASS** — company owners + platform admins + team members miss rows they have reach on. | `db::list_projects` (CAS_3B0DAD92) |

## How the heuristic works

1. Walk `.rs` files under `backend/crates/api/src/db/` (configurable).
2. For each file, harvest top-level `const NAME: &str = "..."` so
   shared SELECTs (PROJECT_SELECT, CHART_COLS, CASE_SELECT, etc.) are
   available for placeholder expansion. Without this, `list_projects`
   presents only `WHERE om.member_redpash_id = $1` to the classifier
   and lands in `ambiguous` — the `role = 'owner'` pin lives in the
   constant the function `format!()`s in.
3. Find every `pub async fn (list|find_all|fetch_all|select_all|get_all)_*`
   that returns `Vec<_>` (via brace-counting on the comment-stripped
   text — same pattern as auth-audit + rs-audit).
4. Extract string literals from the function body, expand
   `{CONST_NAME}` placeholders using the file's harvested constants.
5. Match the expanded SQL + the param list against the classification
   patterns in priority order:
   - reach-aware signals (highest priority — wins if any matches)
   - `member + 'owner'` → strict-owner
   - `member` without `'owner'` → ambiguous (verify intent)
   - parent-scope rid bind → scope-filtered
   - no `$n` binds → caller-blind
   - anything else → ambiguous

## v2 — route-gate awareness (2026-06-03)

v1 classified db fns by SQL shape but was **blind to the route gate**, so it
false-positived nest-gated routes (read `/admin`'s `create_membership` as
ungated) and only YELLOW-shrugged genuinely-ungated tenant leaks. v2 closes
both by parsing `routes/mod.rs`:

- **`parseNestGates`** paren-matches every `.nest("<prefix>", <mod>::routes()….layer(GATE_MW))`
  and records whether a platform-admin middleware wraps the nest. (The bare
  `mod::routes()\)` regex in crossing-audit can't see the `.layer()`-wrapped nests.)
- **`mapDbFnsToNests`** maps each list-fn → the route module(s) that call it (`db::<fn>(`
  / bare `<fn>(`) → their nest(s).

**Policy (security declarations, ratified with Em 2026-06-03 — NOT heuristics):**

| Constant | Value | Effect |
|---|---|---|
| `GATE_MW` | `[require_platform_admin_mw]` | what counts as a platform-admin nest gate |
| `EXPECT_NEST_GATE` | `{admin, monitoring, metrics}` | these nests MUST carry a `GATE_MW .layer()` — **RED `nest-gate-missing`** if absent (drift fails the tool), **GREEN** affirmation when present. (`metrics` added 2026-06-03 when `/metrics` was gated — runbook `CAS_CBA057EE…`.) |
| `TENANT_DATA_NESTS` | `{search, events, companies, teams}` | ungated nests exposing tenant data — a caller-blind/ambiguous list-fn behind one is **RED** (leak); the nest also gets a YELLOW "verify per-handler scoping" so inline-SQL handlers like `search` (no db list-fn) aren't missed |

**Recolor:** all-gated nest → GREEN (`nest-gated`); caller-blind/ambiguous behind an
ungated `TENANT_DATA_NESTS` nest → RED (`LEAK`); `strict-owner` stays RED regardless
(under-reach is orthogonal to the gate). The nest gate is now an **asserted invariant** —
removing `/admin`'s `.layer()` flips the audit RED. Origin: the "audit the auditor"
review (plan `wf_afacef54`), which caught a false-positive SEV-0 + 5 real leaks the
SQL-only v1 missed.

## Drift-prone areas

- Heuristic, not a parser. Hand-rolled SQL using shapes that don't
  match the project's conventions (e.g. a future endpoint that filters
  on a column not in the recognized list) lands in `ambiguous` —
  expected, read the function.
- `extractFileConstants` is shallow — one pass, no recursive expansion
  of constants-inside-constants. The current codebase doesn't need
  recursion; if a constant references another constant via
  `format!()`, extend the loop.
- v2 walks `routes/mod.rs` for nest gates, but the db-fn→nest map is a
  call-site grep (`db::<fn>(` / bare `<fn>(`) — a fn reached only via a
  re-exported alias or a macro won't map and shows "no route caller found
  — verify manually". Inline-SQL handlers (e.g. `search.rs`) have no db
  list-fn, so they're covered only at the nest granularity
  (`TENANT_DATA_NESTS` YELLOW), not per-query.
- The nest-gate policy (`GATE_MW` / `EXPECT_NEST_GATE` / `TENANT_DATA_NESTS`)
  is hand-declared at the top of `audit.js` — when a new platform-admin nest
  or tenant-data surface lands, add it there or the invariant won't cover it.

## Related

- [`backend/api/src/rbac.rs`](../../backend/api/rbac.md) — the reach-aware
  resolver primitives (`principals`, `resolve_grant`, `require_view`,
  `is_platform_admin`).
- [Frontend pillar landing](../../../index.md) — sibling audits.
- CAS_3B0DAD92 — original ticket; the `list_projects` strict-owner
  finding. The audit's `strict-owner` set is the broader bug class.
