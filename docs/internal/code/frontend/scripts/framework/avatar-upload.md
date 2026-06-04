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

Renders the `rp-avatar` (deterministic initials/colour) + a bare `rp-btn-icon`
camera button (opens the file input) + the input. The button carries no second
`rp-` class — per the one-class convention it is styled via the context selector
`.rp-avatar-upload .rp-btn-icon` (and the click handler targets it the same way,
`host.querySelector(".rp-btn-icon")`). `setSrc(url)` shows a picture.

## SECURITY

initials/name/colour are `esc()`'d. The picture URL is applied via the **style API**
(not interpolated into an HTML/inline-style string) and only when it is an `http(s)`
URL — so a hostile `avatar_url` can't inject CSS or markup.

## Drift-prone areas

- **Camera-button selector.** The button is a bare `rp-btn-icon` styled via the context
  `.rp-avatar-upload .rp-btn-icon`, and the click handler targets
  `host.querySelector(".rp-btn-icon")`. Adding a second icon button to the host breaks
  both the styling scope and the handler — keep it the only one, or reintroduce a scoped
  hook.
- **`rp-avatar--lg` is a SHARED atom.** The `--lg` size lives in `atoms.css` +
  `topbar.css` (other avatars use it), so it deliberately stays a `--modifier` here;
  converting it to `data-size` is the avatar-atom lane, not this component.
- **Picture URL** is applied via the style API with an `http(s)`-only guard — never
  interpolate `avatar_url` into markup / inline-style (see SECURITY).

## Related

- `styles/framework/avatar-upload.css` · `rp-avatar` atom · [field](field.md) · [component-registry](component-registry.md). Consumer: the Profile record header.
