---
title: Object metadata spec — template
section: Internal
order: 40
last modified date: 2026-05-29
owner: Torv
status: stable — all 13 objects landed (CAS_E2D56EC0CDAF44A39DEB4752D3F92351 closed). RBAC unblocked.
---

# Object metadata spec

A canonical metadata document per RedPash standard object, modelled on
Salesforce's SObject reference format. The goal: a single source-of-
truth that downstream surfaces (permission-key catalog, FE column
inference, API doc generation, schema audits) can read from instead
of re-deriving each one independently.

Em 2026-05-28: this is the **prep work for RBAC**. The permission
catalog has to be derived from a stable object model — we document
that model here first, then permissions, pages, and elements get
generated against it once pages + objects stabilize.

The narrative `docs/objects/*.md` docs stay — they explain *what an
entity means* for new contributors. These metadata docs live next to
the specs because they pin *what fields the wire actually carries +
which operations each field participates in*.

---

## Per-object document shape

Every standard object gets one `docs/internal/specs/object-metadata/<entity>.md`.
Each document carries these sections, in this order:

### 1. Header
- Object name + RID prefix (e.g. `Case (CAS_)`)
- One-line description: what the entity represents
- Tables backing it (e.g. `cases`, `project_files`)
- DTO file (e.g. `backend/crates/shared/src/case.rs`)
- Route file (e.g. `backend/crates/api/src/routes/cases.rs`)

### 2. Supported calls
The operations the API supports on this entity. RedPash's verb set is
smaller than Salesforce's:

| Verb | Wire | Meaning |
|---|---|---|
| `create` | `POST /api/...` | Insert new row, server-assigned RID |
| `read` | `GET /api/.../:rid` | Fetch by RID; may return a hydrated "Detail" envelope |
| `update` | `PATCH /api/.../:rid` | Sparse update — only declared fields write |
| `delete` | `DELETE /api/.../:rid` | Hard delete (note CASCADE / SET NULL behavior) |
| `list` | `GET /api/...?filters` | Paginated query with filters + sort |
| `search` | `GET /api/...?q=...` | ILIKE substring on the search-flagged fields |
| `describe` | `GET /api/.../describe` | Object + field metadata — this spec served at runtime |

Note which verbs are **NOT supported** explicitly when an entity lacks
some (e.g. "no `delete` — append-only audit log").

### 3. Fields

For each column on the backing table (and each hydrated read-only
field that appears on the wire), list:

```
field_name
  Type:        <postgres type> / <wire shape>
  Properties:  <comma-separated subset of the property vocab below>
  Description: <what it means + any constraint>
```

**Property vocabulary** (6 properties, smaller than Salesforce's 10):

| Property | Meaning | Source-of-truth check |
|---|---|---|
| `Create` | Field accepted on the POST body | The `<Entity>CreateRequest` struct in the DTO file |
| `Update` | Field accepted on the PATCH body | The `<Entity>PatchRequest` struct in the DTO file |
| `Nillable` | Column NULL-allowed (or `Optional<T>` on the wire) | Migration's `NULL` vs `NOT NULL` |
| `Sort` | Column in the route's `SORTABLE_*` allow-list | The `const SORTABLE_*` array in the route file |
| `Search` | Included in the `q=` ILIKE filter | The route's list handler's WHERE clause |
| `Layout` | Appears in the default-visible columns of the list view (FE) | The `defaultHidden` flag on the LIST_VIEWS column spec in `frontend/scripts/pages/home.js` |

Auto-generated (never settable) timestamps (`created_at`, `updated_at`)
carry no Create/Update properties — note that explicitly.

### 4. Enum constraints
Fields with CHECK constraints (e.g. `Case.status ∈ {backlog, todo,
in_progress, in_review, done}`) get a dedicated subsection listing
the allowed values. The CHECK constraint in the migration is the
authority; the FE and BE must both align.

### 5. Relationships

For each FK in the schema:

```
field_name → OtherObject
  Cardinality:    1:1 / 1:N / N:1 / N:N
  On delete:      CASCADE | SET NULL | RESTRICT
  Hydrated as:    <name>_display_name / <name>_<subfield> (joined at SELECT time)
```

Also list **inverse** relationships when meaningful (e.g. "Case has
many Comments" on the Case page even though the FK lives on Comment).

### 6. Audit events
Any `events.kind` rows this object emits via `crate::event::*`. Drives
the activity-feed display + the permission catalog for "who can see
which events."

---

## Conventions

- **File naming:** `docs/internal/specs/object-metadata/<entity>.md` — singular, lowercase, kebab-case if multi-word.
- **One canonical doc per entity, even when an entity is a derived view.** Chart, Dashboard, and Report are all `project_files` rows with a discriminator (`kind`); they each get their own metadata doc since the wire contract differs per kind.
- **Field order in the doc** matches the table's column order in the migration — easier to diff against the schema.
- **Property vocab is closed.** If a new property is genuinely needed (e.g. `Encrypted` for sensitive fields), update this index first; don't invent local properties per doc.
- **The doc IS the source-of-truth** for the permission catalog once we get to RBAC. A field with `Update: true` becomes the basis for a `<entity>.<field>.update` permission key — but only when permissions ship. Until then the doc is just a spec.

---

## Authoring order (Torv's sweep)

Worked example: [case](case.md) — locks the template shape.

Remaining objects, ordered by stability (most-locked first, derived
views last):

1. `user.md` — User (USR_)
2. `company.md` — Company (CMP_)
3. `project.md` — Project (PRJ_)
4. `file.md` — File (FIL_) — the locked-in canonical row, all file types
5. `step.md` — Step (project_steps, append-only log)
6. `comment.md` — Comment (CMT_)
7. `case-category.md` — CaseCategory
8. `membership.md` — Company / Project memberships (composite key)
9. `event.md` — Event (EVT_, append-only)
10. `user-preference.md` — UserPreference
11. `chart.md` — Chart (FIL_ row with kind=chart)
12. `dashboard.md` — Dashboard (FIL_ row with kind=dashboard)
13. `report.md` — Report (derived view of project_files)

Each doc should be 100–250 LOC depending on field count. Reuse the
Case doc's section ordering verbatim. When a property check needs
verification, the migration + DTO file + route file referenced in
the header are the three places to look — no guessing.
