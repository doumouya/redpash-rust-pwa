---
title: tools/list-endpoint-rbac-audit/audit.js
source: ../../../../../tools/list-endpoint-rbac-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-01
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
| `reach-aware` | green | uses `principals()`, `= ANY($1)`, `GRANT_SQL`, `resolve_grant`, `require_view`, or accepts a `viewer: Option<&[String]>`. **CORRECT.** | `db::list_cases` |
| `scope-filtered` | yellow | filters by a parent-scope rid (project_redpash_id, file_redpash_id, case_id, object_redpash_id, company_id). The route must `require_view(scope)` before calling — v2 cross-ref will verify. | `db::list_files_in_project` |
| `caller-blind` | yellow | no `$n` bind site at all. Acceptable for admin endpoints + public taxonomies IF the route gates. | `db::list_users` |
| `ambiguous` | yellow | `member_redpash_id = $n` without `role='owner'` pin, OR no matched pattern at all. Needs a human read. | `db::list_companies` (intentional: surfaces non-member companies) |
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

## Drift-prone areas

- Heuristic, not a parser. Hand-rolled SQL using shapes that don't
  match the project's conventions (e.g. a future endpoint that filters
  on a column not in the recognized list) lands in `ambiguous` —
  expected, read the function.
- `extractFileConstants` is shallow — one pass, no recursive expansion
  of constants-inside-constants. The current codebase doesn't need
  recursion; if a constant references another constant via
  `format!()`, extend the loop.
- Does NOT walk `routes/` to verify the route gate compensates for a
  `scope-filtered` or `caller-blind` finding. That's v2 once the
  inventory stabilizes — the route-walking shape exists in auth-audit
  and can be borrowed.

## Related

- [`backend/api/src/rbac.rs`](../../backend/api/rbac.md) — the reach-aware
  resolver primitives (`principals`, `resolve_grant`, `require_view`,
  `is_platform_admin`).
- [Frontend pillar landing](../../../index.md) — sibling audits.
- CAS_3B0DAD92 — original ticket; the `list_projects` strict-owner
  finding. The audit's `strict-owner` set is the broader bug class.
