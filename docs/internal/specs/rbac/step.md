---
title: Step — permission catalog
section: Internal
order: 56
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Step (project_steps) — permissions

Permission keys + default grant matrix for the cleaning-Step object.
Derived from [step metadata](../object-metadata/step.md); see the
[catalog template](index.md) for the key scheme + role tiers.

**Steps are append-only + parent-scoped.** A Step has no standalone
read / update / delete endpoint and no `redpash_id`-addressable route
— it's surfaced as the `steps[]` array on the FileEnvelope and mutated
only through the file's cleaning endpoints. So Step carries **no scope
columns of its own**; every Step key inherits the parent **File's**
reach (`own` / `project` / `company` / `all` — see [file](file.md)),
resolved via the `memberships` edge on the file's `project_id`.
Practically: holding `file.create` (write to a file) on a file is what
lets you append its steps.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. A Step is never read on its own — `read` / `list`
are covered by the parent **File's** `file.view` (the `steps[]` array
rides on the FileEnvelope), so Step exposes a view atom only for the
field-level allow-list completeness, and a single write atom.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `step.view` | the step rows (the `steps[]` array on the FileEnvelope) | own · project · company · all | covered in practice by `file.view`; the step rows render wherever the parent file is viewable |
| `step.view.all` | every step | all | platform admin |
| `step.view.field.all` | every field | own · project · company · all | the "see the whole step row" atom; minted for completeness — there is no per-field subsetting on an immutable row |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `step.create` | object `step.view` (+ a create grant) | own · project · company · all | Append + apply a cleaning step. **The only write atom Step has** — see Notes. |

**No atoms for:** `update` / `delete` — **not supported** (append-only;
see Notes). No `<field>.update` keys (no settable fields post-create).
`redpash_id`, `applied`, `created_at` are auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at the file's project/company reach;
and `<obj>-mem` — a bare file/project membership (no company role),
which resolves at `own`. Steps inherit File's row reach, so the matrix
mirrors File's write row exactly — anyone who can write a file can run
its pipeline.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | <obj>-mem |
|---|---|---|---|---|---|---|
| `step.view` | all | company | company | company | company | own |
| `step.view.field.all` | all | company | company | company | company | own |
| `step.create` | all | company | company | company | — | own |

Reading the matrix: a **company viewer** views the file and its
`steps[]` but can't append a step (no write); a **company member** and
up can run the pipeline over company files. A bare **file/project
member** views and cleans *their* file — the `own` reach, granted by
the membership on the file itself.

---

## 3. Notes

- **Append-only — no `update` / `delete` atoms, by design.** Steps are
  **immutable once applied**: a step is never edited and never
  individually deleted. Re-running a step with new params **appends a
  new row**; the undo / redo / clear-filters cursor flips the `applied`
  flag, it never mutates or removes a row. The step ledger is
  *re-derived*, not edited — so there is nothing for an `update` or
  `delete` atom to gate, and minting one would imply a mutation path
  that doesn't exist. Rows leave only via the parent `file.delete`
  CASCADE.

- **No own scope columns — parent-scoped.** Step is the clearest case of
  a fully parent-derived object: its entire authorization is "can you
  write the parent File." A step's reach **is** its file's reach (the
  file's project), resolved through the same `memberships` edge — no
  separate Step membership exists. We still mint a discrete `step.create`
  key (rather than folding into `file.create`) so the catalog can name
  the pipeline-append grant explicitly, but today it resolves to the
  file's write reach.

- **Cursor operations are not separate atoms.** Undo / redo /
  clear-filters walk the `applied` cursor; they're view-and-write
  operations on the same step ledger, gated by the same `step.create`
  (file-write) reach — not distinct keys. They don't add or remove the
  capability to mutate, only which rows are currently applied.

- **`step.create` emits `step_apply` events** (per the metadata's
  audit-events section) — those events are read via [Event](event.md)'s
  atoms / the User-Activity feed, not a Step atom.
