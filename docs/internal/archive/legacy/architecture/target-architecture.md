# Target Architecture — Entity Registry + Unified Memberships

Agreed direction (Em, 2026-05-29). Companion to the current-state
[db-schema-snapshot.md](db-schema-snapshot.md). **Not migrated yet.** DDL is
illustrative of intent; sequencing is in §5. Supersedes the earlier
trigger-based `db-schema-with-memberships.md` — the Entity Registry makes
triggers unnecessary.

This is platform-layer DNA, not RedPash-only: the suite of apps shares the
same skeleton (Rust+Polars backend · Postgres with the **Entity Registry as
the first table** · vanilla-JS PWA). "Achieve more with less; organized
engineering; avoid unnecessary addition" — a performing monolith as the edge.

---

## The organizing rule (decides "what goes where")

1. **Entity** — gets a registry row. A top-level thing that can be shared,
   related to, or referenced polymorphically: **user · company · project ·
   file · case**.
2. **Edge / child / system** — no registry row. *References* entities, isn't
   one: memberships, comments, project_steps, sessions, user_preferences, and
   the logs/observability tables.
3. **Derived view** — no table at all. Report, Dashboard, chart: discriminator
   values or projections over entities, never their own object.

---

## 0. Entity Registry — the supertype (the FIRST table)

```sql
CREATE TABLE entities (
    id         TEXT        NOT NULL PRIMARY KEY,   -- USR_/CMP_/PRJ_/FILE_/CAS_
    type       TEXT        NOT NULL
               CHECK (type IN ('user','company','project','file','case')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every top-level entity table makes its PK a FK into the registry:

```sql
-- pattern applied to users, companies, projects, project_files, cases:
redpash_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE
```

**Two roles, one table:**
- **FK *target*** for polymorphic *associations* — `memberships.object_redpash_id`
  and any future edge (comments-on-anything, attachments, audit links,
  watchers) point at `entities.id` and cascade safely.
- **Supertype** for subtyped *entities* — the single-table-subtype pattern
  `project_files` already uses (`file_type` → csv/chart/dashboard). A file is
  an `entities` row of `type='file'`; `file_type` is a *second* level below it.

**Delete pattern (important):** delete through the registry —
`DELETE FROM entities WHERE id = $rid` cascades to the subtype row AND to every
edge that references it (memberships, future relations). One delete path for
all entities; no per-table cleanup, no triggers.

**Create pattern:** `INSERT INTO entities` first, then the subtype row (the FK
needs the registry row to exist). Wrap in one shared `create_entity(id, type)`
helper so no create path forgets it.

**Scale:** `entities` is the highest-cardinality table (sum of all entities,
dominated by files), but it's a thin id/type/created_at row, PK-indexed —
scale-neutral.

---

## 1. Org & Unified Membership

### companies  (PK `redpash_id` → `entities.id` CASCADE) — unchanged otherwise

### memberships — CONSOLIDATED (replaces company_memberships + project_memberships)
```sql
CREATE TABLE memberships (
    object_redpash_id      TEXT        NOT NULL
                           REFERENCES entities(id) ON DELETE CASCADE,  -- polymorphic parent, DB-enforced
    user_redpash_id        TEXT        NOT NULL
                           REFERENCES users(redpash_id) ON DELETE CASCADE,
    role                   TEXT        NOT NULL DEFAULT 'member'
                           CHECK (role IN ('owner','admin','member','viewer')),  -- see role-tier note
    display_name           TEXT,       -- descriptor VALUE   ("CEO", "System Administrator")
    relationship_attribute TEXT,       -- descriptor LABEL   ("Job Title", "Department")
    joined_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (object_redpash_id, user_redpash_id)        -- "who is in this object"
);
CREATE INDEX memberships_user_idx
    ON memberships (user_redpash_id, object_redpash_id);    -- "what objects is this user in" (per-user RBAC)
```
- **No triggers** — `object_redpash_id → entities.id ON DELETE CASCADE` gives the
  integrity the old per-table FKs had. Deleting any object (via its entities
  row) cascades its memberships away; deleting a user cascades the user side.
  Orphan rows — the phantom-access RBAC leak we were guarding against — are
  impossible at the DB level.
- **Descriptor stays cosmetic** (two fields keep the Job-Title-vs-Department
  split): nothing branches on `display_name`/`relationship_attribute`. All
  enforcement keys off `role`.
- **role-tier note (OPEN):** the table uses the 4-tier `owner/admin/member/viewer`
  (Em's draft). Alternative is 3-tier `owner/admin/member` + a future
  `(object_type, role)` role-grants table where "read-only" is `(project,
  member)` granting only `*.view`. 4-tier is simpler now; 3-tier+grants is more
  flexible later. Lane owner + Em to lock.

---

## 2. What does NOT move into memberships

`cases.assignee_id` and `cases.reporter_id` **stay typed FK columns on cases**.
They're 1:1 *workflow* references, not many-to-many *access* edges; folding them
into `memberships` as a free-text descriptor would (a) make a cosmetic field
load-bearing for "who's assigned?" queries, (b) lose the single-assignee
guarantee and FK/typo safety. Memberships earns its keep on m:n access grants.

`projects.owner_id` — ownership *is* an access relationship, so it CAN become a
`memberships` row with `role='owner'`. But that rewrites every owner-check, so
it is a **separate later migration** (§5), not part of the consolidation.

---

## 3. Cases — `case_categories` unique-constraint fix

The current single `UNIQUE(parent_id, name, company_id)` doesn't dedupe *root*
categories (NULL `parent_id` isn't equal to itself). Split:
```sql
CREATE UNIQUE INDEX ON case_categories (name, company_id) WHERE parent_id IS NULL;  -- roots
CREATE UNIQUE INDEX ON case_categories (parent_id, name, company_id);               -- sub-categories
```

---

## 4. Observability — partition by time

`events`, `request_log`, `db_query_log` → `PARTITION BY RANGE (occurred_at/at)`
(e.g. monthly). Data lifecycle becomes `DROP TABLE old_partition` — no VACUUM
bloat from `DELETE`. This supersedes `db_query_log`'s current DELETE-retention
job. Partition key must be in the PK (e.g. `events (redpash_id, occurred_at)`,
`request_log (id, at)`).

---

## 5. Sequencing — decompose, don't ship as one mega-migration

One migration touching every access/owner query is the "one wrong rule breaks
the system" risk. Stage it, each step independently verifiable:

1. **Entity Registry + memberships consolidation.** Create `entities`; backfill
   rows for existing users/companies/projects/files/cases; add the
   `redpash_id → entities.id` FKs; create `memberships`, migrate rows from the
   two old tables, drop them. Keep `owner_id`/`assignee_id`/`reporter_id` as-is.
2. **Ownership → memberships.** Drop `projects.owner_id`; represent owner as a
   `memberships` row; move default-project to `users.default_project_id`. Rewrites
   owner-checks (a `JOIN memberships … role='owner'`), project-create, "my
   projects".
3. **(Optional / deferred)** anything further.

Call sites to port (step 1): `search.rs` (project-membership EXISTS subqueries +
the membership UNION), `admin.rs` scope-branching, `db/mod.rs` + `db/users.rs`
membership queries, `companies.rs` member routes, `shared/company.rs` +
`shared/admin.rs` DTOs. The app-side cascade in `delete_project`/`delete_company`
becomes "delete the entities row."

---

## Appendix — FUTURE, deferred: role → permissions (NOT these migrations)

```sql
role_grants(object_type, role, capability)   -- (case, owner, 'case.update'); (company, owner, 'case.view.all')
```
Same role name resolves to different capabilities per scope — which is why
unifying the role *names* is safe. Effective access = **role ∪ membership**,
additive (positive-only) → order-independent set union, a pure testable
function. Precedence/deny only enters with SF-style restriction rules; stay
additive unless data demands exceptions. Parked until the surface is stable.
