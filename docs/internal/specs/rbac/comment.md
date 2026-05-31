---
title: Comment — permission catalog
section: Internal
order: 57
last modified date: 2026-05-31
owner: Torv
status: enforced 2026-05-31 — object-level gate live: create=require_grant(effective>=Member) on the case; update/delete=author (author_id==caller) OR case admin+ (scope>=Admin, moderation). RBAC catalog sweep ([index](index.md))
---

# Comment (CMT_) — permissions

Permission keys + default grant matrix for the Comment object — the
case-thread reply. Derived from [comment metadata](../object-metadata/comment.md);
see the [catalog template](index.md) for the key scheme + role tiers.

**View reaches Comment supports:** `author_id` → `@own` (you wrote it);
`case_id` → the comment inherits the parent **Case's** reach for
view/list (if you can view the case you can view its thread). `@all` =
platform admin. No direct project/company column — those resolve
transitively through the Case (`case.project_id` / `case.company_id`),
so a Comment's `company` reach is the parent case's `company` reach.

**`@own` for Comment is `author_id == caller`** — the writer of the
comment. View follows the **case** (you see a case's comments iff you
can view the case); edit/delete follow **authorship** (`@own`), with
moderators (company admin/owner) and platform admin also able to delete.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read`/`list`/`search` are all `comment.view` —
the reach decides *which* comments the list returns. A comment's view
is gated by the **parent case's view**: you see a case's comments iff
you can view the case.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `comment.view` | the comment (thread / single + the `comments[]` array on `CaseDetail`) | own · company · all | gated by the parent **case's view** — you see a case's comments iff you can view the case; `own` = `author_id == caller` |
| `comment.view.all` | every comment | all | platform admin |
| `comment.view.field.<name>` | one field | inherits the row reach | **allow-list**, one per readable field: `body` (+ read-only `author` name, `is_edited`, `created_at`, `updated_at`). Standard bundles hold `view.field.all`; *subsetting fields is a custom-role (v3) feature* |
| `comment.view.field.all` | every field | own · company · all | the "see the whole record" atom; **required to delete** |

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `comment.create` | object `comment.view` | — (no row yet) | post to a thread you can view; `author_id` forced to caller, `case_id` set from the route, `is_edited` seeded `false` |
| `comment.body.update` | `comment.view.field.body` | own · all | author rewrites their own words; sets `is_edited`. `body` is the only editable field |
| `comment.delete` | `comment.view.field.all` | own · company · all | author deletes own; company admin/owner moderates company-case threads; platform admin any — see Notes |

**No atoms for:** `redpash_id`, `case_id` (set at create, never
re-pointed — a comment can't move threads), `author_id` (server-forced
to caller), `is_edited` (server-set on PATCH), `created_at`,
`updated_at` — auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). Columns: platform `admin`; the membership bundles
`owner`/`admin`/`member`/`viewer` at company reach; and `cmt-mem` — a
bare comment authorship (`author_id == caller`, no company role), which
resolves at `own`. Wider reach wins on union.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | cmt-mem |
|---|---|---|---|---|---|---|
| `comment.view` | all | company | company | company | company | own |
| `comment.view.field.all` | all | company | company | company | company | own |
| `comment.create` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `comment.body.update` | all | — | — | — | — | own |
| `comment.delete` | all | company | company | — | — | own |

Reading the matrix: anyone who can view a case can post + view its
thread (`comment.view` / `comment.create` at `company`); you edit only
your own comments (`comment.body.update@own`); deletion is yours
(author, `own`) OR a moderator's (company admin/owner on company-case
threads, `company`) OR platform admin's (`all`). A bare comment author
with no company role views and edits/deletes *their own* comment — the
`own` reach, resolved by `author_id == caller`.

---

## 3. Notes

- **Comment view is gated with the parent case.** *View/create/list*
  follow the **case** (`comment.create@company` = "post to a case in my
  company"); seeing a case's comments iff you can view the case. The
  enforcement layer resolves create/view via the case's reach and
  update/delete via author equality (`@own`).

- **Edit is author-only; delete is author-OR-moderator.** You can only
  rewrite your own words (`comment.body.update@own`), but a company
  admin/owner can remove a comment from a company-case thread
  (moderation) without editing it — hence `comment.delete` carries
  `company` for admins but `comment.body.update` doesn't.

- **No thread re-pointing.** `case_id` is fixed at create — a comment
  belongs to one case forever, so there's no `comment.case_id.update`
  atom.

- **Comments CASCADE when the case is deleted.** A `case.delete`
  irreversibly removes the whole comment thread (the FK CASCADEs);
  there is no per-comment guard against that, which is part of why
  `case.delete` is an admin janitorial action.

- **All mutations emit `case_comment_*` events** (post/edit/delete per
  the metadata) into the activity feed — surfaced via [Event](event.md)
  atoms, not a Comment atom. This is the "comments already emit events"
  fact the [epic CAS_9A0C](index.md) leans on for the activity-feed
  surfacing.
</content>
</invoke>
