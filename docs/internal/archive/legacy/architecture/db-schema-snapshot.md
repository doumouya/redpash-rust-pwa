# DB schema snapshot — 2026-05-29

Point-in-time snapshot of the live `redpash_prerelease` schema, grouped by
domain to support the object-organization pass. **Source of truth is
`backend/migrations/` + the live DB, not this file** — regenerate the raw
DDL anytime with:

```
pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges \
  --no-comments --exclude-table=_sqlx_migrations
```

17 domain tables (excludes `_sqlx_migrations`). Conventions: domain entities
use a `TEXT redpash_id` PK with a typed prefix (`USR_/CMP_/PRJ_/CAS_/…`);
join tables use a composite PK; system/log tables use `bigserial id`.
`NN` = NOT NULL. FK annotations show the ON DELETE action.

---

## 1. Identity & Access

### users — the person  (PK `redpash_id` = USR_)
| column | type | null | default |
|---|---|---|---|
| redpash_id | text | NN | |
| username | text | NN | UNIQUE |
| email | text | | |
| display_name | text | NN | |
| avatar_url | text | | |
| job_title | text | | |
| organisation | text | | free-text bio |
| use_case | text | | |
| plan | text | NN | 'free' |
| locale | text | NN | 'en' |
| first_name / last_name | text | | |
| google_sub | text | | UNIQUE (partial, when not null) |
| created_at / updated_at | timestamptz | NN | now() |

### sessions  (PK `redpash_id`)
user_redpash_id NN → users **CASCADE** · expires_at NN · created_at

### user_preferences  (PK `user_redpash_id, key`)
value jsonb NN · updated_at · FK user **CASCADE** — k/v prefs (mig 023; replaced the dropped `users.prefs` column)

---

## 2. Org & Membership  (the RBAC substrate — CONSOLIDATION TARGET)

### companies  (PK `redpash_id` = CMP_)
name NN · slug NN UNIQUE · avatar_url · created_at · updated_at

### company_memberships  (PK `company_id, user_redpash_id`)
role NN default 'member' **CHECK(owner/admin/member)** · joined_at
FK company → companies **CASCADE** · FK user → users **CASCADE**

### project_memberships  (PK `project_redpash_id, user_redpash_id`)
role NN default 'viewer' **CHECK(owner/collaborator/viewer)** · joined_at
FK project → projects **CASCADE** · FK user → users **CASCADE**

> **Pending consolidation (case CAS_DC7EDAF82F1E494F846D83FA71C411A2):** these
> two (+ a planned case-memberships table) collapse into ONE polymorphic
> `memberships(object_redpash_id, user_redpash_id, role, display_name,
> relationship_attribute, joined_at)`. `role` becomes a unified enum
> (owner/admin/member); object-side cascade moves to per-parent BEFORE DELETE
> triggers (a bare polymorphic FK can't reference 3 tables); `display_name` +
> `relationship_attribute` are cosmetic descriptor fields ("CEO" / "Job Title").
> Note the two tables today have **divergent role vocabularies** — unify in the
> migration.

---

## 3. Projects & Files  (core domain — the 2 locked entities)

### projects  (PK `redpash_id` = PRJ_)
owner_id NN → users **CASCADE** · name NN · description · is_default NN false
· company_id → companies **SET NULL** · status NN default 'draft'
**CHECK(draft/active/archived)** · created_at · updated_at
UNIQUE partial `(owner_id) WHERE is_default` (one default project per user)

### project_files — POLYMORPHIC (one table, `file_type` discriminator)  (PK `redpash_id`)
project_redpash_id NN → projects **CASCADE** · filename NN · display_name ·
**file_type** NN default 'csv' (csv / chart=CHT_ / dashboard — derived views) ·
row_count · col_count · file_size_bytes · cleanness_pct · encoding ·
delimiter default ',' · storage_path NN · columns_meta jsonb NN '[]' ·
spec jsonb NN '{}' · source_file_id → project_files(self) **CASCADE** ·
is_public NN false · is_favorite NN false · folder · description ·
created_at · updated_at

> This is the precedent the membership consolidation follows: one table, type
> read off the row — Report/Dashboard are derived views, not their own tables.

### project_steps — cleaning-op audit trail  (PK `redpash_id`)
file_redpash_id NN → project_files **CASCADE** · ordinal NN · kind NN ·
params jsonb NN '{}' · applied NN true · created_at

---

## 4. Cases  (ticketing / CRM dogfood)

### cases  (PK `redpash_id` = CAS_)
type NN 'task' **CHECK(bug/feature/task/epic)** · title NN · description ·
status NN 'backlog' **CHECK(backlog/todo/in_progress/in_review/done)** ·
priority NN 'medium' **CHECK(low/medium/high/critical)** · error_message ·
created_at · updated_at
FKs (all **SET NULL**): reporter_id → users · assignee_id → users ·
project_id → projects · company_id → companies · category_id → case_categories

### comments  (PK `redpash_id`)
case_id NN → cases **CASCADE** · author_id → users **SET NULL** · body NN ·
is_edited NN false · created_at · updated_at

### case_categories  (PK `redpash_id`)
parent_id → case_categories(self) **CASCADE** · name NN · company_id →
companies **CASCADE** · created_at · UNIQUE `(parent_id, name, company_id)`

---

## 5. Observability & System  (instrumentation — NOT domain objects)

### events — error/action/panic capture  (PK `redpash_id`)
occurred_at · origin NN 'backend' **CHECK(backend/frontend)** · level NN 'info'
**CHECK(debug/info/warn/error)** · kind NN · message NN · source ·
user_redpash_id → users **SET NULL** · session_id · request_id · http_method ·
http_path · http_status · duration_ms · context jsonb NN '{}'

### request_log — per-HTTP-request  (PK `id` bigserial)
at · method NN · route NN · status(smallint) NN · duration_ms NN · request_id ·
user_redpash_id · session_id

### db_query_log — per-DB-query (new 2026-05-29)  (PK `id` bigserial)
at · query_template NN · duration_ms NN · rows · status(smallint) NN 0 ·
error_kind · request_id · user_redpash_id · route

### optimization_points — known opt opportunities × live measurements  (PK `id` bigserial)
subsystem NN · phase NN · current_cost NN · horizon NN · status NN 'open'
**CHECK(open/planned/done/wontfix)** · measurement_kind · measurement_key ·
threshold_value · threshold_unit · notes · created_at · updated_at ·
UNIQUE `(subsystem, phase)`

### sentinel_submissions — shared cleanness vocabulary  (PK `canonical, user_id`)
submitted_at · FK user → users **CASCADE**

---

## Structural observations (factual, for the organization pass)

- **Three table classes today:** domain entities (users, companies, projects,
  project_files, cases, case_categories) · join/relationship tables
  (company_memberships, project_memberships, comments, project_steps,
  user_preferences, sentinel_submissions, sessions) · system/observability
  (events, request_log, db_query_log, optimization_points).
- **No unified object/entity registry** — PRJ_/CMP_/CAS_ live in separate
  tables. Relevant to whether the polymorphic `memberships.object_redpash_id`
  ever gets a real FK target (today: triggers; if a registry lands: CASCADE).
- **One polymorphic precedent already in prod:** `project_files` (file_type).
  The membership consolidation is the second application of the same pattern.
- **Ownership lives two ways today:** `projects.owner_id` (a column) vs
  `*_memberships.role='owner'` (a row). The brainstorm "membership acts as
  ownership" would unify these — deliberately out of scope for the membership
  consolidation migration.
