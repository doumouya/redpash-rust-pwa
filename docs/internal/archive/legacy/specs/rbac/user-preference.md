---
title: UserPreference — permission catalog
section: Internal
order: 61
last modified date: 2026-05-31
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# UserPreference — permissions

Permission keys + default grant matrix for the UserPreference object —
the per-user settings store. Derived from
[user-preference metadata](../object-metadata/user-preference.md);
scheme in the [catalog template](index.md).

**Always `@own`.** A UserPreference row is keyed on `user_redpash_id`
(its own table column — *not* renamed in the membership migration; ==
the caller's identity) and the wire is always `(caller, prefs_object)`
— `/api/me/prefs` reads + writes the *caller's* prefs, never another
user's. So every atom is `own`-only **by construction**: there is no
cross-user reach at all — not even platform admin reads another user's
prefs. No company / project / all rungs exist.

---

## 1. Atoms

View-rooted (per [index](index.md#key-scheme)): `view` is the root,
writes derive from it. `read` is `userpreference.view` — and the only
reach the object ever has is `own`.

### View atoms

| Atom | Covers | Reach | Notes |
|---|---|---|---|
| `userpreference.view` | the prefs object (`GET /api/me`, prefs block) | own | the caller's prefs, seeded into the app at boot; `own` = `user_redpash_id == caller` |
| `userpreference.view.field.all` | every field | own | the whole prefs object; **required to delete** |

There is no `userpreference.view.all` — prefs are personal, no
cross-user row breadth exists for any role.

### Write atoms (derive from a view atom)

| Atom | Derives from | Reach | Notes |
|---|---|---|---|
| `userpreference.create` | object `userpreference.view` | own | upsert of the caller's prefs row (`PATCH /api/me/prefs` creates on first write) |
| `userpreference.value.update` | `…view.field.all` | own | sparse merge into the prefs JSONB blob (registered + unregistered keys); one value covers the whole object |
| `userpreference.delete` | `userpreference.view.field.all` | own | per-key clear / remove a key from the prefs object |

**No atoms for:** `user_redpash_id` (the identity, == caller, server-
forced), `updated_at` — auto / server-assigned.

---

## 2. Grant matrix

Default role-bundle → atom mapping. Cell = the **reach** the bundle
grants (or `—`). The matrix is trivial: only the owner (the caller, at
`own` reach) holds anything; every other column — including platform
admin — is `—`, because there is no cross-user reach for prefs at all.

| Atom | plat:admin | co:owner | co:admin | co:member | co:viewer | own |
|---|---|---|---|---|---|---|
| `userpreference.view` | — | — | — | — | — | own |
| `userpreference.view.field.all` | — | — | — | — | — | own |
| `userpreference.create` | — | — | — | — | — | own |
| `userpreference.value.update` | — | — | — | — | — | own |
| `userpreference.delete` | — | — | — | — | — | own |

`own` is the whole story: a user reads + writes their own prefs, and
**no one else can**. Not even platform admin reads another user's
prefs — prefs are the user's voice, and there is deliberately no
admin-reads-your-prefs or admin-writes-your-prefs path.

---

## 3. Notes

- **Personal scope only.** No company/project/all dimension — prefs are
  per-user. `own` = `user_redpash_id == caller`, which is the *only*
  way the row is ever addressed (`/api/me` resolves the caller). The
  `user_redpash_id` column is UserPreference's own table column and was
  **not** renamed to `member_redpash_id` in the membership migration —
  it stays the caller's direct identity.

- **No admin read or write.** Unlike most objects, there is no `@all`
  support read here — an admin silently reading (or changing) your
  prefs would be a trust violation. Every atom tops out at `own`; the
  matrix has no non-empty cell outside the owner column.

- **One JSONB value, not per-key keys.** The prefs are a single JSONB
  blob; `userpreference.value.update` covers the whole object. We
  don't mint per-pref-key permissions (`userpreference.theme.update`,
  …) — the prefs registry isn't a permission surface, it's the user's
  own settings. (Contrast: object *fields* get field-update keys; pref
  *keys* don't — they're all equally "yours.")

- **The `monitoringCharts` / `homeCharts` prefs** (the chart-picker
  layouts from the earlier Slice D work) live in this blob — so
  editing your saved chart layouts is `userpreference.value.update@own`,
  same as any other pref. No separate chart-layout permission.

- **Pref-change event (epic CAS_9A0C).** The user-prefs → activity-feed
  item needs a `pref_change` event emitted on `PATCH /me/prefs` (Gus's
  backend slice — none today). When it lands, those events read via
  [Event](event.md)'s `own` reach, not a UserPreference atom.
