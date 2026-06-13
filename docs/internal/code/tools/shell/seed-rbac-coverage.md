---
title: tools/seed-rbac-coverage/seed.sh
source: ../../../../../tools/seed-rbac-coverage/seed.sh
owner: Torv
section: Internal · Code · Tools · shell
last modified date: 2026-05-31
---

# seed-rbac-coverage/seed.sh

## Purpose

Seed test-fixture users + teams + memberships so the live UI has at
least one holder of each role tier (Owner / Admin / Member / Viewer)
on each object kind (company / team / project / case). Lets RBAC and
member-management UI surfaces be exercised against realistic data
without hand-clicking through the modal for every row.

Idempotent by name + handle: re-runs report `[exists]` instead of
duplicating.

## Usage

```sh
sh tools/seed-rbac-coverage/seed.sh
RP_API=http://localhost:8088/api sh tools/seed-rbac-coverage/seed.sh
```

Requires a backend with `REDPASH_DEV_LOGIN` enabled (the script
mints a session via `/auth/dev-login`). The backend logs a WARN at
startup when dev-login is on — that's the green light.

## What it creates

- 4 users: Alice Owner (alice), Bob Admin (bob), Carol Member
  (carol), Dave Viewer (dave). Picked by purpose-encoding display
  names so a glance at the redtable tells you which role each was
  seeded for.
- 3 new teams: Operations + Investors (RedPash), Analytics (Acme).
  Engineering reuses the team Phase B already created.
- 22 memberships across companies, teams, the first project, and
  the first case — every Owner / Admin / Member / Viewer slot
  filled.

## Drift-prone areas

- Allow-lists for `role` + `context_role` mirror `routes/admin.rs`
  exactly — drift = 400 from the validator. Keep this script in
  sync when those allow-lists change.
- `log`/`head` write to **stderr** so functions can `echo` the
  resolved rid on stdout. Adding `printf '%s\n'` to log without the
  `>&2` will silently corrupt the captured rids — re-introducing
  the "JSON parse: EOF" failures we hit the first time around.
- The script depends on the bootstrap RedPash + Acme companies +
  the dev-user's default project + an existing case. If
  `db-setup.sh` hasn't run, run it first.

## Related

- [POST /api/admin/memberships allow-lists](../../backend/api/routes/admin.md)
- [Tools landing](../index.md)

> Note: the `/api/teams` route + `routes/teams.rs` were removed in the lean
> single-user slim (CAS_C8A9); the `teams` table + db helpers remain.
