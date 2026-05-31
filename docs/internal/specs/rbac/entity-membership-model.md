---
title: Entity-Membership model — RBAC foundation
section: Internal
order: 58
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — the §2 resolver is shipped in rbac.rs (resolve_grant / require_grant / require_view, Grant{direct,scope}); reach-aware gates live across all 5 object types + mutation gates broadened ensure_owner→require_grant. Supersedes the (scope,user) single-role assumption in [membership.md](membership.md). Design case CAS_A3B5D5F8E2A3483EA44EAA5B437A6A92; delivery/workstream of record case CAS_913220A003484841BF98250DD0FEF681
---

# Entity-Membership model — RBAC foundation

## 0. The keystone: users are entities

Every access-control question in RedPash reduces to **one self-referential
edge**: a *principal* (entity) holds a *role* on an *object* (entity).
That only works if **users are first-class entities** — same as
companies, projects, cases, and teams.

The original RBAC plan had this (`entities.type CHECK(user/company/project/
case/team)`). The **implemented** schema dropped it:

```
entities.type CHECK (company, project, case, team)      -- no 'user'
memberships.object_redpash_id → entities(id)            -- objects ARE entities
memberships.user_redpash_id   → users(redpash_id)       -- subjects are NOT
                  PK (object_redpash_id, user_redpash_id)
```

That asymmetry — **objects are entities, subjects are users** — is the
root cause of everything that felt hard:

- a **team can't be granted a role** (the subject FK only accepts users),
  so "give HR/Support access to X" had to become a hardcoded business rule;
- a user can hold only **one role per object** (the `(object, user)` PK),
  so owner+admin and reporter+assignee are impossible;
- team **nesting** has no expression.

Restore the symmetry and all three dissolve at once. `memberships`
becomes a pure **entity → entity → role** edge:

| edge | object | member | meaning |
|---|---|---|---|
| user → company | CMP | USR | employment / company role |
| **team → company** | CMP | **TEM** | team granted a role (was "impossible") |
| user → team | TEM | USR | you're in HR |
| **team → team** | TEM_parent | **TEM_child** | nesting (free) |
| user → case | CAS | USR | reporter / case-team |

One edge, one resolver, no special-cased FK, no "business rule" branch.
The PK widening and teams-as-subject are **not two features — they are
both just "the subject is an entity."**

## 1. Schema

```sql
-- (1) users rejoin the supertype
ALTER TABLE entities DROP CONSTRAINT entities_type_check;
ALTER TABLE entities ADD  CONSTRAINT entities_type_check
  CHECK (type IN ('user','company','project','case','team'));
INSERT INTO entities (id, type)                 -- backfill existing users
  SELECT redpash_id, 'user' FROM users ON CONFLICT DO NOTHING;
ALTER TABLE users
  ADD CONSTRAINT users_entity_fk
  FOREIGN KEY (redpash_id) REFERENCES entities(id) ON DELETE CASCADE;

-- (2) the membership subject becomes any entity
ALTER TABLE memberships RENAME COLUMN user_redpash_id TO member_redpash_id;
ALTER TABLE memberships DROP CONSTRAINT memberships_user_redpash_id_fkey;
ALTER TABLE memberships
  ADD FOREIGN KEY (member_redpash_id) REFERENCES entities(id) ON DELETE CASCADE;

-- (3) the key widens so one principal can hold many roles per object
UPDATE memberships SET context_role = '' WHERE context_role IS NULL;
ALTER TABLE memberships ALTER COLUMN context_role SET DEFAULT '';
ALTER TABLE memberships ALTER COLUMN context_role SET NOT NULL;
ALTER TABLE memberships DROP CONSTRAINT memberships_pkey;
ALTER TABLE memberships
  ADD PRIMARY KEY (object_redpash_id, member_redpash_id, role, context_role);
```

`teams` already exists (entity-registered, company-scoped) — no change.

Column meanings:

- **`object_redpash_id`** → any entity. What the role is *on*.
- **`member_redpash_id`** → any entity (user **or** team). *Who* holds it.
- **`role`** — the permission tier, `CHECK (owner·admin·member·viewer)`.
  This is what the resolver reads.
- **`context_role`** — free-text business label ("CEO", "Reporter",
  "Data Analyst"). UI only; never overrides `role`. `''` = no label.

`ON DELETE CASCADE` on the subject FK is harmless: Scrub-Retain (§4)
never hard-deletes a user entity, so the edges survive.

## 2. The resolver (one query, shared by every endpoint)

A principal's **effective role** on an object is the **highest** role
found across three sources, resolved in a single query — direct grant ∪
scope cascade (the object's company/project) ∪ team closure (the teams
the principal belongs to, recursively):

```sql
WITH RECURSIVE principals(pid) AS (
    SELECT $1::text                                  -- the requester (a user entity)
  UNION
    SELECT m.object_redpash_id                       -- + every team they're in (nested)
    FROM memberships m
    JOIN principals p ON p.pid = m.member_redpash_id
    JOIN entities  e  ON e.id  = m.object_redpash_id AND e.type = 'team'
),
scopes(oid) AS (
    SELECT $2::text                                  -- the target object
  UNION SELECT company_id FROM cases    WHERE redpash_id = $2
  UNION SELECT project_id FROM cases    WHERE redpash_id = $2
  UNION SELECT company_id FROM projects WHERE redpash_id = $2
)
SELECT max(CASE m.role WHEN 'owner' THEN 4 WHEN 'admin'  THEN 3
                       WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 END) AS rank
FROM memberships m
WHERE m.member_redpash_id IN (SELECT pid FROM principals)
  AND m.object_redpash_id IN (SELECT oid FROM scopes);
-- NULL rank → no edge anywhere → DEFAULT-DENY.
```

`max(rank)` *is* the "highest role wins" rule (Alice `viewer`-direct +
`owner`-of-company → 4 → owner). Team access (`team → company` row) and
company-admin access resolve through the **same** path — there is no
separate team branch and no magic team name.

This resolver is encoded **once** (one SQL function / shared fragment);
every CRUD endpoint calls it with `(requester, object)` and compares
`rank` to a threshold. Endpoints never re-implement membership joins.

## 3. CRUD matrix

`rank` thresholds (from §2):

| Op | Rule | Min effective rank |
|---|---|---|
| **Create** | evaluated against the **parent** object (a Case's company, a Project's company). Company creation is open to any authenticated user. | `member` (2) on parent |
| **Read** | additive; any edge that resolves ≥ viewer | `viewer` (1) |
| **Update** | standard edits (status, comment, file) | `member` (2) |
| **Update (destructive)** | rename company, change visibility, delete sub-resources | `admin` (3) |
| **Delete** | the object itself; company-owner cascades down via `scopes` | `owner` (4) |

**Auto-grant on create** (one transaction): registering an object also
writes the creator's edge.

- create Company → `(CMP, creator, owner, 'Owner')`
- create Project/Team/Case → `(obj, creator, owner, '…')`
- **report a Case → `(CAS, reporter, member, 'Reporter')`** — `member`,
  not `viewer`, so the reporter can comment on their own case (comments
  are an Update at `member`+). *This pins the reporter↔viewer ambiguity.*

Worked example (HR person files a case): they hold no case-bearing edge,
so they can't see other cases (default-deny); `case_create` mints their
`(CAS_7, USR_dave, member, 'Reporter')` edge → they now see and comment
on *that* case. The edge *is* the grant.

## 4. Scrub & Retain deletion

Policy unchanged ([scrub-retain, `api/users.md`](../../../api/users.md)): **tombstone PII in
place, retain all history, never hard-delete, never block, notify.**

```sql
BEGIN;
-- NO sole-owner blocker. NO membership deletes — the edges ARE the audit
-- trail and the "Deleted User" anchor (a deleted reporter must still
-- resolve as the case's reporter).

DELETE FROM sessions WHERE user_redpash_id = $1;       -- revoke auth only

UPDATE users SET                                        -- scrub PII in place
  email=NULL, google_sub=NULL, first_name=NULL, last_name=NULL,
  job_title=NULL, avatar_url=NULL,
  display_name='Deleted User', status='archived', updated_at=now()
WHERE redpash_id = $1;

INSERT INTO events (kind, context)                      -- notify + flag vacancies
  SELECT 'user_archived', jsonb_build_object('user',$1)
  UNION ALL
  SELECT 'owner_vacancy', jsonb_build_object('object', m.object_redpash_id)
  FROM memberships m
  WHERE m.member_redpash_id = $1 AND m.role = 'owner'
    AND NOT EXISTS (SELECT 1 FROM memberships o
                    WHERE o.object_redpash_id = m.object_redpash_id
                      AND o.member_redpash_id <> $1 AND o.role = 'owner');
COMMIT;
```

The sole-owner edge case is handled **without a blocker**: an
`owner_vacancy` event is emitted so an admin reassigns manually — honors
both "never block" and "never silently orphan." The archived user's
edges stay; active pickers filter on `users.status = 'active'`, and the
existing display-name JOINs render archived principals as "Deleted User".

## 5. Migration plan & blast radius

**Schema** — §1, one migration. Anchor of truth; the generated
`docs/db/update_db/init.generated.sql` (currently old PK, no `'user'`)
gets regenerated from it.

**Code touchpoints** (every `ON CONFLICT (object,user)` and user-keyed
membership query):

- `db::add_company_member` (`db/mod.rs:1219`) — `(object,user)` upsert
  "change role" no longer holds; a principal now holds multiple role
  rows → role management becomes add/remove specific `(member,role)`
  edges.
- `db::set_case_person` (`db/mod.rs:1696`) — the delete-then-`DO UPDATE
  context_role` overwrite goes away; reporter/case-owner become
  independent edges.
- `CASE_USER_JOINS` / `CASE_SELECT` (`db/mod.rs:1483`) — the single
  `reporter_id`/`assignee_id` LATERALs assume one holder; with co-
  reporters allowed they become lists (or the API picks a primary).
  **Open contract question** — see §6.
- bare membership inserts (`db/mod.rs:1086/1169`) — column rename +
  uniqueness review.

**Catalog ripple** — `specs/rbac/` (15 files) is written against the
`(scope,user)` single-role model and has **no teams-as-subject**. Each
per-object grant matrix needs a sweep to the entity-edge + role-set
model. This is the largest cost and is Torv-pool-owned territory →
coordinate on the RBAC lane before sweeping.

## 6. Decisions

**RESOLVED — department cardinality (Em 2026-05-31): Option B.** A
department is a *kind* of team (`teams.kind ∈ {team, department}`); a
user has **one department per company** but may sit on many ad-hoc
teams. Enforced by a `BEFORE INSERT/UPDATE` trigger on `memberships`
(`enforce_one_department_per_user`), **not** a unique index — the
widened key must keep allowing multiple roles on a user's *own*
department, which `UNIQUE(member, company)` would forbid. The trigger
takes a `pg_advisory_xact_lock` on `(member, company)` to close the
count→raise TOCTOU race. Built + validated in
[`init.reconciled.sql` §8](../../../db/update_db/init.reconciled.sql).
*Follow-up:* `teams.kind` promotion is not yet guarded (see that file).

**Still open:**

1. **Co-reporter API shape** — `reporter_id` → `reporter_ids[]`, or keep
   a single "primary" reporter + extras as case-team members? Decides
   the `CASE_SELECT` shape and the MCP `case_*` payloads.
2. **Team nesting now or later** — the resolver's `RECURSIVE` CTE
   supports it today; ship it, or flatten to one level until a real org
   needs depth? (Scale-neutral either way; recursion costs nothing until
   teams actually nest.)
3. **`context_role` 'Department'** — retire the text label now that
   departments are first-class team entities, or let both coexist
   during transition?

## 7. Relationship to the permission catalog

This document is the **data-model foundation**; the per-object grant
matrices in [membership.md](membership.md) and its siblings are the
**policy layer** that reads `role` via the §2 resolver. Where the catalog
states `composite PK (scope_id, user_redpash_id)` and "moving a
membership = delete + create", this model supersedes it: the key is
`(object, member, role, context_role)`, the subject is any entity, and a
principal holds many edges. The catalog sweep (§5) reconciles them.
