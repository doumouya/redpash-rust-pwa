---
title: UserPreference — permission catalog
section: Internal
order: 61
last modified date: 2026-05-29
owner: Torv
status: draft — RBAC catalog sweep ([index](index.md))
---

# UserPreference — permissions

Permission keys + default grant matrix for the UserPreference object —
the per-user settings store. Derived from
[user-preference metadata](../object-metadata/user-preference.md);
scheme in the [catalog template](index.md).

**Always `@own`.** A UserPreference row is keyed on `user_redpash_id`
and the wire is always `(caller, prefs_object)` — `/api/me/prefs`
reads + writes the *caller's* prefs, never another user's. So every
UserPreference key is `@own` by construction; the only wider scope is
`@all` for platform-admin support reads. No company/project scope —
prefs are personal.

---

## 1. Keys

| Key | Verb | Scopes | Notes |
|---|---|---|---|
| `user_preference.read` | `GET /api/me` (prefs block) | own · all | The caller's prefs, seeded into the app at boot. |
| `user_preference.update` | `PATCH /api/me/prefs` | own | Sparse merge into the prefs JSONB (registered + unregistered keys). |
| `user_preference.delete` | per-key clear | own | Remove a key from the prefs object. |
| `user_preference.value.update` | `value` field | own | The prefs JSONB blob — same grant as `update`. |

**Not supported** (per metadata): `list` / `search` (no
`/api/admin/user-preferences`), per-row create/update/delete (the row
is the storage unit; the wire is always the whole prefs object). **No
keys for:** `user_redpash_id` (the identity, == caller), `updated_at`.

---

## 2. Grant matrix

| Key | plat:admin | @own |
|---|---|---|
| `user_preference.read` | all | own |
| `user_preference.update` | own* | own |
| `user_preference.delete` | own* | own |
| `user_preference.value.update` | own* | own |

`@own` is the whole story: a user reads + writes their own prefs.
Platform admin can `read@all` (support — "what's this user's locale /
rows-per-page set to") but **does not write** another user's prefs
(`own*` = even platform admin only writes their own — there's no
admin-writes-your-prefs path, and shouldn't be; prefs are the user's
voice). The `*` flags that the write keys have no genuine `@all` —
only the caller mutates their own.

---

## 3. Notes

- **Personal scope only.** No company/project dimension — prefs are
  per-user. `@own` = `user_redpash_id == caller`, which is the *only*
  way the row is ever addressed (`/api/me` resolves the caller).

- **Admin reads, never writes.** `user_preference.read@all` supports
  troubleshooting ("their density is set to compact, that's why the UI
  looks off"); there's deliberately no `update@all` — an admin
  silently changing your prefs would be a trust violation. The write
  keys top out at `@own`.

- **One JSONB value, not per-key keys.** The prefs are a single JSONB
  blob; `user_preference.value.update` covers the whole object. We
  don't mint per-pref-key permissions (`user_preference.theme.update`,
  …) — the prefs registry isn't a permission surface, it's the user's
  own settings. (Contrast: object *fields* get field-update keys; pref
  *keys* don't — they're all equally "yours.")

- **The `monitoringCharts` / `homeCharts` prefs** (the chart-picker
  layouts from the earlier Slice D work) live in this blob — so
  editing your saved chart layouts is `user_preference.value.update@own`,
  same as any other pref. No separate chart-layout permission.

- **Pref-change event (epic CAS_9A0C).** The user-prefs → activity-feed
  item needs a `pref_change` event emitted on `PATCH /me/prefs` (Gus's
  backend slice — none today). When it lands, those events read via
  [Event](event.md)'s `@own` key, not a UserPreference key.
