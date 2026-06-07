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

_(User · Company · Team · Membership · Project · File · Chart · Dashboard ·
Case · Step · Report · TypeDefinition — one doc each, Phase C.)_
