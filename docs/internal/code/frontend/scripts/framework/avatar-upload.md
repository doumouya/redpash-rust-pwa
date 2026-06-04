---
title: frontend/scripts/framework/avatar-upload.js
source: ../../../../../../frontend/scripts/framework/avatar-upload.js
owner: Torv
section: Internal · Code · Frontend · scripts · framework
last modified date: 2026-06-04
---

# framework/avatar-upload.js — editable avatar (picture upload)

## Purpose

The profile-picture edit affordance the UI never exposed (Em's brief): wraps the
`rp-avatar` atom with a camera button + hidden file input, so the User record can
change its picture (form-control set, CAS_37B2E1BF). Backend is ready — `avatar_url`
is a User field and `PATCH /users` accepts it. CSS: `styles/framework/avatar-upload.css`.

## Public surface

- `mountAvatarUpload(host, { name?, src?, color?, size?, onFile? })` → `{ el, setSrc(url) }`.
  `host` becomes `.rp-avatar-upload`; picking a file calls `onFile(file)` (the seam the
  Profile page wires to upload + `PATCH /users {avatar_url}`). Self-registers as `"avatar-upload"`.

## How it works

Renders the `rp-avatar` (deterministic initials/colour) + a `rp-btn-icon` camera
button (opens the file input) + the input. `setSrc(url)` shows a picture.

## SECURITY

initials/name/colour are `esc()`'d. The picture URL is applied via the **style API**
(not interpolated into an HTML/inline-style string) and only when it is an `http(s)`
URL — so a hostile `avatar_url` can't inject CSS or markup.

## Related

- `styles/framework/avatar-upload.css` · `rp-avatar` atom · [field](field.md) · [component-registry](component-registry.md). Consumer: the Profile record header.
