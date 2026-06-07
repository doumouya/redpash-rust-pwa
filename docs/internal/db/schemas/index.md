---
title: DB schemas — internal
section: Internal
last modified date: 2026-06-07
---

# DB schemas

One doc per object. Each is a **generated schema region** (column / type /
nullability / default, from the live DB via `information_schema` +
`pg_catalog`) plus **hand-written** field semantics + business-logic prose +
the per-object RBAC rows (merged in from the old `specs/rbac/<object>.md`).

> Phase B rewires `doc-gen --schema --out docs/internal/db/schemas`; Phase C
> ports the per-object prose + per-object RBAC here (replacing
> `specs/object-metadata/*`, `docs/db/schema.md`, `docs/objects/*`).

## Pattern (per object)

```markdown
# <object>

## Schema
<!-- doc-gen:schema:<table> START -->
_(generated table — do not hand-edit)_
<!-- doc-gen:schema:<table> END -->

## Fields (business logic)   ← hand-written, survives regeneration
## Access (RBAC)             ← hand-written, merged from specs/rbac/<object>
## Source files              ← links into code/ (the survival layer)
```

## Objects

<!-- doc-gen:schema:objects START -->
Generated 2026-06-07 — 28 objects from the live schema.

- [`audit.finding`](audit.finding.md)
- [`audit.run`](audit.run.md)
- [`public.case_categories`](public.case_categories.md)
- [`public.cases`](public.cases.md)
- [`public.comments`](public.comments.md)
- [`public.companies`](public.companies.md)
- [`public.company_rbac`](public.company_rbac.md)
- [`public.connectors`](public.connectors.md)
- [`public.db_query_log`](public.db_query_log.md)
- [`public.entities`](public.entities.md)
- [`public.events`](public.events.md)
- [`public.field_permissions`](public.field_permissions.md)
- [`public.file_stages`](public.file_stages.md)
- [`public.global_sentinels`](public.global_sentinels.md)
- [`public.memberships`](public.memberships.md)
- [`public.optimization_points`](public.optimization_points.md)
- [`public.project_files`](public.project_files.md)
- [`public.project_steps`](public.project_steps.md)
- [`public.projects`](public.projects.md)
- [`public.request_log`](public.request_log.md)
- [`public.sentinel_submissions`](public.sentinel_submissions.md)
- [`public.sessions`](public.sessions.md)
- [`public.teams`](public.teams.md)
- [`public.type_definitions`](public.type_definitions.md)
- [`public.type_fields`](public.type_fields.md)
- [`public.type_scope_roles`](public.type_scope_roles.md)
- [`public.user_preferences`](public.user_preferences.md)
- [`public.users`](public.users.md)
<!-- doc-gen:schema:objects END -->

Hand-written field semantics + per-object RBAC prose go IN each object's doc
around its generated `## Schema` region (Phase C).
