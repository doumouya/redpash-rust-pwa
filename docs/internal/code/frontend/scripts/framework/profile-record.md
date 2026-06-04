---
title: frontend/scripts/framework/profile-record.js
source: ../../../../../../frontend/scripts/framework/profile-record.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/profile-record.js — the User record page

## Purpose

The User object's **record page** (CAS_37B2E1BF) — Em's reframe of Profile: "the
record page that should appear when clicking a row in the Users table on Home."
Composes (owns almost no markup) the Cases-detail record pattern + the form-control
set into one editable User record. CSS glue: `styles/framework/profile-record.css`.

## Public surface

- `mountProfileRecord(host, { user, memberships?, onPatch?, onAvatarFile?, onUpgrade? })`
  → `{ el }`. Self-registers as `"profile-record"`. `user` = a `UserProfile`
  (`shared/user.rs`); `memberships` = `UserMembership[]`.

## How it works (all reuse)

- **Header**: `rp-avatar-upload` (editable picture → `onAvatarFile`) + `rp-head`
  (the `USR_` rid mono-pill click-to-copy + click-to-edit display name → `onPatch`).
- **Details**: every `UserProfile` field as an `rp-field` — editable fields render an
  `rp-input` committing via `onPatch(key, value)`; server-assigned fields (handle/email)
  show a read-only value. The "edit all fields" the old UI never exposed.
- **Memberships**: the simple-`table` related list (company · role) from `memberships`.
- **Plan**: an `rp-field` whose control is the plan `badge` + an **Upgrade** `rp-btn`
  (`onUpgrade`) — the upgrade affordance the old Plan tab lacked.
- **Connections**: `rp-field` rows, future-proofed — Google (live) + MFA / SSO / Okta
  as "Soon" badges.

Render-first: `onPatch` / `onAvatarFile` / `onUpgrade` are the seams the live Profile
page wires to `PATCH /users` (the backend already accepts every field incl. `avatar_url`).
The `FIELDS` list mirrors `PATCH /users`; `field_perms` is the live editability authority.

## Drift-prone areas

- `host.classList.add("rp-profile-record")` (NOT `=`) so the page frame's `.rp-surface`
  chrome class survives (the record mounts *inside* the surface card).
- Tabs are **2** (Record / Usage) per the rebuild plan — the old 4 tabs (Plan/Connections)
  collapse into record sections. Usage (stats + charts) is the second tab, page-driven.
- Dedup: `set-account` is removed from Settings — account identity lives here.

## Related

- [head](head.md) · [field](field.md) · [avatar-upload](avatar-upload.md) · [badge](badge.md) · [select](select.md) · [page-assembly](page-assembly.md) (the `mount` hook fills the surface with this).
- Data contract: `backend/crates/shared/src/user.rs` (`UserProfile`/`UserMembership`), `routes/users.rs` (`PATCH /users`).
- Plan: `~/.claude/plans/hi-need-a-plan-golden-treasure.md` · brief: `docs/profile-settings-rebuild.md`.
