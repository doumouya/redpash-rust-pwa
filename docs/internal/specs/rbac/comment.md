---
title: Comment — permission catalog
section: Internal
order: 57
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# Comment (CMT_) — permissions

Permission keys + default grant matrix for the Comment object — the
case-thread reply. Derived from [comment metadata](../object-metadata/comment.md);
scheme in the [catalog template](index.md).

**Scope columns Comment carries:** `author_id` → `@own` (you wrote it);
`case_id` → the comment inherits the parent **Case's** scope for
read/list (if you can read the case you can read its thread). `@all` =
platform admin. No direct project/company column — those resolve
transitively through the Case (`case.project_id` / `case.company_id`).

Editing + deleting a comment is author-gated (`@own`); reading the
thread is case-gated (you see a case's comments iff you can read the
case).

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `comment.create` | `POST /api/cases/:rid/comments` | (case-scoped) | Post to a thread you can read. Scope = the parent case's read scope. |
| `comment.read` | thread / single | own · company · all | Surfaced as the `comments[]` array on the CaseDetail — covered by reading the case. |
| `comment.update` | `PATCH /api/cases/:rid/comments/:cmt` | own · all | Author edits their own; platform admin any. Sets `is_edited`. |
| `comment.delete` | `DELETE /api/cases/:rid/comments/:cmt` | own · company · all | Author deletes own; company admin moderates company-case threads; platform admin any. |
| `comment.list` | thread | own · company · all | The thread per case — same scope as `comment.read`. |
| `comment.search` | `?q=` | company · all | ILIKE on body across readable cases. |
| `comment.body.update` | `body` field | own · all | The only editable field — same grant as `comment.update`. |

**No keys for:** `redpash_id`, `case_id` (set at create, never
re-pointed — a comment can't move threads), `author_id` (server-forced
to caller), `is_edited` (server-set on PATCH), `created_at`,
`updated_at`.

---

## 2. Grant matrix

| Key | plat:admin | co:owner | co:admin | co:member | @own (author) |
|---|---|---|---|---|---|
| `comment.create` | all | company | company | company | — |
| `comment.read` | all | company | company | company | own |
| `comment.list` | all | company | company | company | own |
| `comment.search` | all | company | company | company | — |
| `comment.update` | all | — | — | — | own |
| `comment.delete` | all | company | company | — | own |
| `comment.body.update` | all | — | — | — | own |

Reading it: anyone who can read a case can post + read its thread
(create/read/list at `@company`); you edit only your own comments
(`@own`); deletion is yours (author) OR a moderator's (company
admin/owner on company-case threads) OR platform admin's.

---

## 3. Notes

- **Comment scope is two-rooted, like its parent.** *Read/create/list*
  follow the **case** (`comment.create@company` = "post to a case in
  my company"); *update/delete* follow **authorship** (`@own` =
  `author_id == caller`). The enforcement layer resolves create/read
  via the case's scope and update/delete via author equality.

- **Edit is author-only; delete is author-OR-moderator.** You can only
  rewrite your own words (`comment.update@own`), but a company
  admin/owner can remove a comment from a company-case thread
  (moderation) without editing it — hence delete carries `@company`
  for admins but update doesn't.

- **No thread re-pointing.** `case_id` is fixed at create — a comment
  belongs to one case forever, so there's no `comment.case_id.update`
  key.

- **All mutations emit `case_comment_*` events** (post/edit/delete per
  the metadata) into the activity feed — surfaced via [Event](event.md)
  keys, not a Comment key. This is the "comments already emit events"
  fact the [epic CAS_9A0C](index.md) leans on for the activity-feed
  surfacing.
