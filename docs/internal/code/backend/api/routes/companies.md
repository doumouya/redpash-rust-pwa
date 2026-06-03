---
title: backend/crates/api/src/routes/companies.rs
source: ../../../../../../backend/crates/api/src/routes/companies.rs
owner: Gus
section: Internal · Code · backend · api · routes
last modified date: 2026-06-03
---

# companies.rs

## Purpose

`/api/companies` — companies + memberships.

A company is the multi-tenancy boundary: a user belongs to zero or
more companies via the unified `memberships` table. That table also IS
the access-control check — every handler resolves the caller's role and
404s (not 403) when they aren't a member, so company existence is
never leaked.

Member management (`/:rid/members`) is **no longer company-specific** — it's
nested from the generic [members.rs](members.md) module
(`.nest("/:rid/members", super::members::routes())`), so a company is just one
object type on the polymorphic edge. This file now owns only company CRUD +
slug logic; the read gate `members::require_member` is reused by `get_one`.

## Public surface

- `pub fn routes` — company CRUD (`/`, `/:rid`) + a nest of the generic member
  router at `/:rid/members`.

## Gates

- `list` — **see-down scoped** (CAS_AF2690C0, step-3): returns only companies the caller is a member of (`db::list_companies(.., viewer)`); platform admins get the full directory. Makes the Purpose's "company existence is never leaked" true for the *list* too (it leaked before — every company surfaced to every caller).
- `get_one` — any company member (`members::require_member`, platform-admin bypass).
- `patch` — `company.update`: company admin+ (direct) or platform admin
  (`require_grant`, 404 on deny).
- `delete_one` — `company.delete`: company owner only or platform admin.
- member CRUD — delegated to [members.rs](members.md)'s shared rules.
- **Field-level** (CAS_C4219F2B s3): `patch` then calls `field_perms::require_fields(.., "company", ..)` — narrows the coarse gate per field via the matrix (defaults ⊕ overrides).

## Drift-prone areas

- Wire shapes in `shared::` change in lockstep with this file when it consumes them; backend ↔ frontend ↔ DB seam.
- See the `//!` module documentation at the top of the source for the load-bearing invariants.
- **`POST /api/companies` accepts `avatar_url`** (added 2026-05-31, strand 2 of CAS_B846F28C). Optional at create — mirrors the existing `PatchCompanyBody.avatar_url` field so an admin can seat an avatar at company-create-time without a follow-up PATCH. `db::create_company` signature widened with `avatar_url: Option<&str>`; bootstrap canonical-internal-company creation passes `None`.

## Related

- [Backend pillar landing](../../index.md)
