---
title: Case — object metadata
section: Internal
order: 41
last modified date: 2026-05-28
owner: Woz
status: pattern-lock — first worked example of the object-metadata template ([index](index.md))
---

# Case (CAS_)

Represents a unit of team-coordination or customer-ticket work. Used
for sprints (build features, debug the app), customer-reported bugs,
and the activity-feed thread per case. Cases follow the agile-canonical
status flow `backlog → todo → in_progress → in_review → done` (reopen
is allowed: `done → todo`).

**Backing table:** `cases` (migration `20260610000001_cases.sql`
+ follow-ups `20260611000001_cases_error_message.sql`
+ `20260612000001_case_categories.sql`).
**DTO:** `backend/crates/shared/src/case.rs`.
**Routes:** `backend/crates/api/src/routes/cases.rs`.

---

## Supported calls

| Verb | Wire | Notes |
|---|---|---|
| `create` | `POST /api/cases` | Server assigns `CAS_<32hex>`; `reporter_id` always set to caller; `status` always seeded `'backlog'` |
| `read` | `GET /api/cases/:rid` | Returns the full `CaseDetail` envelope: `{ case, comments[], activity[] }` — the case row + its comment thread + its `events.kind=case_*` activity feed |
| `update` | `PATCH /api/cases/:rid` | Sparse update — only declared fields write. Per-field-change events emit per the audit-trail discipline (one `case_<field>_change` row per changed enum field, one bundled `case_metadata_change` for quieter edits like title / description / project / company / error_message) |
| `delete` | `DELETE /api/cases/:rid` | Hard delete; comments CASCADE; events stay (the activity outlives the case for audit) |
| `list` | `GET /api/cases?status=&assignee=&project=&q=&source=&sort=&dir=&page=&size=` | Paginated; `source=internal\|external` filters by reporter's RedPash-company membership; `assignee=__unassigned__` sentinel matches `assignee_id IS NULL` |
| `search` | `GET /api/cases?q=…` | ILIKE substring on `title` + `description` |

---

## Fields

```
redpash_id
  Type:        TEXT / String — format CAS_<32 uppercase hex>
  Properties:  Layout
  Description: Primary key. Server-assigned via id::new("CAS").
               Never settable by clients.
```

```
type
  Type:        TEXT / String — enum (see "Enum constraints")
  Properties:  Create, Update, Sort, Layout
  Description: Differentiates work. The four-value set is Agile-
               canonical; narrow on purpose. Defaults to 'task'.
```

```
title
  Type:        TEXT / String — required, no length cap today
  Properties:  Create, Update, Sort, Search, Layout
  Description: One-line case title. Required on Create. Inline-
               editable in the detail panel head.
```

```
description
  Type:        TEXT / Option<String>
  Properties:  Create, Update, Nillable, Search
  Description: Markdown body (rendered as plain text in v1; markdown
               parser is v2 polish). Inline-editable in the sidebar
               Description section.
```

```
status
  Type:        TEXT / String — enum (see "Enum constraints")
  Properties:  Update, Sort, Layout
  Description: Workflow position. Always seeded 'backlog' on Create
               (NOT a Create-property). Status changes emit
               case_status_change events. Kanban cycle button
               advances backlog → todo → in_progress → in_review →
               done → backlog.
```

```
priority
  Type:        TEXT / String — enum (see "Enum constraints")
  Properties:  Create, Update, Sort, Layout
  Description: Defaults to 'medium'. 'critical' reserved for outages
               (will page oncall when notifications ship in v3).
               Priority changes emit case_priority_change events.
```

```
reporter_id
  Type:        TEXT / Option<String> — FK to users.redpash_id
  Properties:  Nillable, Layout
  Description: Who filed the case. Always set server-side to the
               caller on Create — never client-settable. Nullable
               only when the original user is deleted (FK ON DELETE
               SET NULL preserves the ticket).
```

```
assignee_id
  Type:        TEXT / Option<String> — FK to users.redpash_id
  Properties:  Create, Update, Nillable, Sort, Layout
  Description: Who's working on it. Sort uses the hydrated
               assignee_display_name (NULLS LAST in the SQL).
               Assignment changes emit case_assignee_change events.
```

```
project_id
  Type:        TEXT / Option<String> — FK to projects.redpash_id
  Properties:  Create, Update, Nillable, Sort
  Description: Optional project context. SET NULL on project delete
               so the case survives as company / personal.
```

```
company_id
  Type:        TEXT / Option<String> — FK to companies.redpash_id
  Properties:  Create, Update, Nillable, Sort
  Description: Optional company context. Drives the source=
               filter (internal vs external) — a case is internal iff
               its reporter shares a membership with the canonical
               RedPash company.
```

```
error_message
  Type:        TEXT / Option<String>
  Properties:  Create, Update, Nillable
  Description: Raw error payload for auto-triaged cases from error-
               class events (FE crashes / panics / 5xx). Distinct
               from `description` so dedup hashes over (kind,
               error_message) work cleanly. FE renders as a
               monospace <pre> block (the SHAPE matters); other
               fields render as prose.
```

```
category_id
  Type:        TEXT / Option<String> — FK to case_categories.redpash_id
  Properties:  Create, Update, Nillable, Sort
  Description: Optional taxonomy tag. Two-level hierarchy
               (parent/child) via case_categories.parent_id;
               cases.category_id usually points at a leaf
               (subcategory) but pointing at a parent is allowed.
               Sort uses the hydrated category_name.
```

```
created_at
  Type:        TIMESTAMPTZ / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-set on INSERT. Never client-settable.
```

```
updated_at
  Type:        TIMESTAMPTZ / chrono::DateTime<Utc>
  Properties:  Sort, Layout
  Description: Auto-bumped on every UPDATE (no DB trigger today;
               the route handler sets it explicitly on each PATCH).
               Never client-settable.
```

### Hydrated read-only fields

These appear on the wire (in the JSON response) but aren't columns
on `cases` — they're computed at SELECT time via `CASE_USER_JOINS`
in `db/mod.rs`. They have no Create / Update properties; the
underlying FK column is what gets written.

```
reporter_display_name
  Type:        TEXT / Option<String>
  Properties:  Nillable, Layout
  Description: users.display_name JOINed on reporter_id. NULL when
               reporter is null (deleted user).

assignee_display_name
  Type:        TEXT / Option<String>
  Properties:  Nillable, Layout
  Description: users.display_name JOINed on assignee_id. Drives the
               assignee chip in the rail + kanban card.

category_name
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: case_categories.name JOINed on category_id.

category_parent_id, category_parent_name
  Type:        TEXT / Option<String>
  Properties:  Nillable
  Description: Self-FK climb to the category's parent (single level —
               we surface up to 2 levels today).
```

---

## Enum constraints

`type ∈ { bug, feature, task, epic }`
Mirror the CHECK constraint in `migration 028` line 28.

`status ∈ { backlog, todo, in_progress, in_review, done }`
Mirror the CHECK constraint. The kanban board's 5 columns are
this exact set in this exact order — the order is load-bearing
for the cycle-status button (next-in-order).

`priority ∈ { low, medium, high, critical }`
Mirror the CHECK. Color tokens for the priority dot are in
`cases.css:.rp-cases-priority-dot.is-<level>`.

---

## Relationships

```
reporter_id → User (USR_)
  Cardinality:  N:1 (a User reports many Cases)
  On delete:    SET NULL (ticket survives the user's deletion)
  Hydrated as:  reporter_display_name
```

```
assignee_id → User (USR_)
  Cardinality:  N:1
  On delete:    SET NULL
  Hydrated as:  assignee_display_name
```

```
project_id → Project (PRJ_)
  Cardinality:  N:1
  On delete:    SET NULL
  Hydrated as:  — (project_id surfaced as-is on the wire today;
                hydration is a follow-up if a project_name field
                becomes useful in the case detail UI)
```

```
company_id → Company (CMP_)
  Cardinality:  N:1
  On delete:    SET NULL
  Hydrated as:  — (same as project_id today)
  Note:         Distinct from the source= filter. company_id pins
                a case to a specific company; source= reads the
                reporter's company memberships against the canonical
                RedPash company.
```

```
category_id → CaseCategory (CAT_)
  Cardinality:  N:1
  On delete:    SET NULL
  Hydrated as:  category_name, category_parent_id, category_parent_name
```

### Inverse relationships

```
Comment.case_id → Case (CAS_)
  Cardinality:   1:N (a Case has many Comments)
  On delete:     CASCADE (deleting a case drops its comments)
  Surfaced as:   the `comments[]` array in the CaseDetail GET response
```

```
Event.context.case = <CAS_…> → Case
  Cardinality:   1:N (a Case has many activity-feed events)
  On delete:     no FK (soft FK via context JSON; deleting a case
                 leaves the events in place for audit)
  Surfaced as:   the `activity[]` array in the CaseDetail GET response
```

---

## Audit events

Every mutation emits one `events.kind = 'case_*'` row via
`crate::event::record` (cat-3 audit-trail discipline). The activity
feed query is literally:
`SELECT * FROM events WHERE context->>'case' = $1`.

| `kind` | Emitted on | Context shape |
|---|---|---|
| `case_create` | `POST /api/cases` | `{ case, type, priority, assignee, project }` |
| `case_delete` | `DELETE /api/cases/:rid` | `{ case }` |
| `case_status_change` | `PATCH` when status changes | `{ case, field: 'status', old, new }` |
| `case_priority_change` | `PATCH` when priority changes | `{ case, field: 'priority', old, new }` |
| `case_type_change` | `PATCH` when type changes | `{ case, field: 'type', old, new }` |
| `case_assignee_change` | `PATCH` when assignee_id changes | `{ case, field: 'assignee', old, new }` |
| `case_category_change` | `PATCH` when category_id changes | `{ case, field: 'category', old, new }` |
| `case_metadata_change` | `PATCH` when title/description/project/company/error_message changes | `{ case, fields: [<names>] }` — bundled summary for quieter edits |
| `case_comment_post` | `POST /api/cases/:rid/comments` | `{ case, comment }` |
| `case_comment_edit` | `PATCH /api/cases/:rid/comments/:cmt_rid` | `{ case, comment }` |
| `case_comment_delete` | `DELETE /api/cases/:rid/comments/:cmt_rid` | `{ case, comment }` |

The split between per-field events (status / priority / type / assignee
/ category) and the bundled `case_metadata_change` is deliberate:
field-change events drive the per-field activity-filter chips
(`Comments` / `Status` / `Assignment` / `Edits` in the detail
panel's Activity tab), so we keep the high-signal ones discrete.
Quieter edits collapse into one row to keep the feed scannable.
