---
title: tools/db-setup.sh
source: ../../../../../tools/db-setup.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# db-setup.sh

## Purpose

Creates the dev DB if it doesn't exist, then runs `sqlx migrate run`
against it. The "make the schema match the migrations dir" command.
Pairs with `db-reset.sh` (which drops + recreates the DB without
migrating). Re-execs under bash for `[[ ]]` + arrays + here-strings.

## Public surface

- `sh tools/db-setup.sh` — idempotent (skips create if DB exists).
- Reads `DATABASE_URL` from the backend `.env`.
- Returns non-zero if migrations fail.

## Drift-prone areas

- **`DATABASE_URL` env-var name** is the contract with backend code; if
  backend renames it, this script breaks.
- **Migration set** has been squashed into `20260529000000_init.sql` —
  the script doesn't care, but the LOGICAL history lives in REDMAP only.

## Related

- [Sibling: db-reset.sh](db-reset.md)
- [Sibling: dev-setup.sh](dev-setup.md) — orchestrates create + setup
- [Public: Getting started](../../../../../getting-started.md)
