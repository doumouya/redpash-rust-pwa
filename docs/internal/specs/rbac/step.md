---
title: Step — permission catalog
section: Internal
order: 56
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Step (project_steps) — permissions

Permission keys for the cleaning-Step object. Derived from
[step metadata](../object-metadata/step.md); scheme in the
[catalog template](index.md).

**Steps are append-only + parent-scoped.** A Step has no standalone
read / update / delete endpoint and no `redpash_id`-addressable route
— it's surfaced as the `steps[]` array on the FileEnvelope and mutated
only through the file's cleaning endpoints. So Step carries **no scope
columns of its own**; every Step key inherits the parent **File's**
scope (`@own` / `@project` / `@company` / `@all` — see [file](file.md)).
Practically: holding `file.update` on a file is what lets you operate
its steps.

---

## 1. Keys

Step's "verbs" are the cleaning-pipeline operations, not CRUD —
immutable rows whose `applied` flag the cursor walks.

| Key | Operation | Scopes | Notes |
|---|---|---|---|
| `step.create` | `POST /api/files/:rid/steps` | own · project · company · all | Append + apply a cleaning step. |
| `step.undo` | `POST /api/files/:rid/undo` | own · project · company · all | Walk the cursor back one (flip `applied=false`); row stays. |
| `step.redo` | `POST /api/files/:rid/redo` | own · project · company · all | Walk forward. |
| `step.clear_filters` | `POST /api/files/:rid/clear-filters` | own · project · company · all | Surgical un-apply of every `filter_rows` step (eraser). |

**No keys for:** `read` (steps surface on the FileEnvelope — covered by
`file.read`), `update`/`delete` (**not supported** — steps are
immutable; they leave only via `DELETE /api/files/:rid` CASCADE or the
un-apply flips above). No field-update keys (no settable fields post-
create).

---

## 2. Grant matrix

Steps inherit File's row scope, so the matrix mirrors File's mutate
row exactly — anyone who can `file.update` a file can run its
pipeline.

| Key | plat:admin | co:owner | co:admin | co:member | proj:collab | proj:viewer | @own |
|---|---|---|---|---|---|---|---|
| `step.create` | all | company | company | — | project | — | own |
| `step.undo` | all | company | company | — | project | — | own |
| `step.redo` | all | company | company | — | project | — | own |
| `step.clear_filters` | all | company | company | — | project | — | own |

Identical to `file.update`'s row — by design. A project viewer reads
the file (incl. its steps[]) but can't run the pipeline; a collaborator
can clean.

---

## 3. Notes

- **No own scope columns — parent-scoped.** Step is the clearest case
  of a fully parent-derived object: its entire authorization is "can
  you update the parent File." We still mint discrete `step.*` keys
  (rather than folding into `file.update`) so a future policy could
  allow, e.g., apply but not undo — but today they all resolve to
  `file.update`'s grant.

- **Append-only — no update/delete keys.** Re-running a step with new
  params appends a new row; it never edits an existing one. The
  cursor flips `applied`, never deletes. So there's nothing for an
  `update`/`delete` key to gate.

- **`step.create` emits `step_apply` events** (per the metadata's
  audit-events section) — those events are read via [Event](event.md)'s
  keys / the User-Activity feed, not a Step key.
