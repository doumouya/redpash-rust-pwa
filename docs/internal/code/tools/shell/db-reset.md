---
title: tools/db-reset.sh
source: ../../../../../tools/db-reset.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# db-reset.sh

## Purpose

Dev-DB lifecycle: drop + recreate the `redpash_prerelease` database.
Use when migrations get tangled, when you want a clean
`events` / `audit.*` slate, or when iterating on a destructive schema
change. Re-execs under bash because it uses `[[ ]]` + here-strings.

## Public surface

- `sh tools/db-reset.sh` — drops and recreates the DB.
- Idempotent: handles the case where the DB doesn't exist.
- Does NOT run migrations afterward (call `db-setup.sh` for that).

## Drift-prone areas

- **DB name hardcoded** to `redpash_prerelease`; if the prerelease branch
  ever renames, this breaks until updated.
- **Connection** assumes a local Postgres on the default port with the
  dev user; not robust to alternative dev setups.

## Related

- [Sibling: db-setup.sh](db-setup.md) — the post-reset setup
- [Sibling: dev-setup.sh](dev-setup.md) — orchestrates both
