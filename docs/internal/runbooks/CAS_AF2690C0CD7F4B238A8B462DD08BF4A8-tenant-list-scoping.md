---
title: "Ungated tenant-list read leaks — scope list_* to caller reach"
order: 15
case_id: CAS_AF2690C0CD7F4B238A8B462DD08BF4A8
section: Internal
severity: Sev1
last modified date: 2026-06-03
owner: Torv
---

# 0015 — Ungated tenant-list read leaks (scope `list_*` to caller reach)

Pattern runbook for the cross-tenant **list-read** leaks found by the "audit the
auditor" review (`wf_afacef54`). One pattern, several endpoints; each fix appends a
row to the **Per-endpoint** table below as it lands.

## Problem Statement

Several `GET` list endpoints returned **every tenant's rows** to any authenticated
caller — the list path was unscoped even where the *singular* (`get_one`) path was
correctly tenant-gated. Sensitive surfaces: `/api/events` (PII — user rids, paths,
context), `/api/companies`, `/api/teams`, `/api/search`.

## Troubleshooting steps

1. The audit-the-auditor workflow flagged each `list_*` fn behind an **ungated**
   tenant-data nest (`/events`, `/companies`, `/teams`, `/search` carry no
   `require_platform_admin_mw` layer — confirmed in `routes/mod.rs`).
2. Read each handler + db fn: the list path either discarded the resolved caller
   (events) or bound `$1` only into a `my_role` **display** subquery while the main
   query had **no row filter** (companies/teams — the "looks-scoped-but-isn't" trap).
3. Confirmed the *singular* path was already gated (e.g. `events.rs::get_one` →
   `users_share_company`) — the asymmetry is the tell.

## RCA

The list queries had no caller-reach predicate. A `$1` feeding only a `my_role`
subquery makes the query *look* scoped in review while returning all rows. The
nests are ungated by design (regular users legitimately read their own tenant's
data), so the scope **must** live in the query — it wasn't there.

## Solution

**Pattern:** the list fn takes a `viewer: Option<&str>` (or principals) scope; the
route resolves the caller and passes `None` for platform admins (full feed) else
`Some(caller)`. The query gains a reach predicate mirroring the singular path's gate;
own + system/NULL rows always pass. Audit recognizes `viewer: Option<&…>` as
reach-aware (GREEN).

### Per-endpoint

| Endpoint | db fn | scope predicate | status |
|---|---|---|---|
| `GET /api/events` | `list_events(.., viewer)` | `EXISTS` over `memberships` sharing a `CMP_` object with the caller (mirrors `users_share_company`); own + NULL-user pass | ✅ done (2026-06-03) |
| `GET /api/companies` | `list_companies` | TBD — **pending Em product call** (cross-company discoverability vs. leak) | ⏳ |
| `GET /api/search` (users/companies/memberships) | inline SQL | scope each branch to caller reach, admin-bypass | ⏳ |
| `GET /api/teams` | `list_teams` | `EXISTS` membership on team or its company | ⏳ |

**Deferred:** the full non-admin→404/scoped HTTP matrix lands in `tests/rbac_matrix.rs`
(epic step 7).

## Post Checking

- `/events` (done): `cargo build -p api` green; **read-only DB partition check** against
  `redpash_prerelease` — a sample non-admin caller's scoped feed = 948 events, hidden
  cross-tenant set = 949, total = 1897 (948 + 949 = 1897, exact); 292 system events pass
  through. `node tools/list-endpoint-rbac-audit/audit.js` → `list_events` flips
  AMBIGUOUS→**GREEN** (reach-aware), `list_cases` unregressed, no new RED.
- **Watching:** `list_companies` + `list_teams` remain RED in the audit (correct — not yet
  fixed); `/search` remains a YELLOW tenant-nest (inline SQL). Epic
  `CAS_AF2690C0CD7F4B238A8B462DD08BF4A8` tracks the rest.
