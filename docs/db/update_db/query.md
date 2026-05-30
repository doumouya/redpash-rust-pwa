# DB consolidation — single baseline (executed 2026-05-29)

Pre-launch, on localhost, with throwaway data, the migration history (38 files
of add-then-drop churn) was collapsed into **one clean baseline**. This doc
records what was done and why, so the decision is auditable.

> **Status: done.** The DB was rebuilt from the baseline and verified. The 38
> superseded migrations are archived in
> `backend/.migrations_archive_pre_baseline/` (recoverable; delete once you're
> happy). The live baseline is
> [`backend/migrations/20260529000000_init.sql`](../../../backend/migrations/20260529000000_init.sql).

## Why not the original hand-written script

The first draft of this doc hand-authored the baseline from memory of
`schema.md`. A review caught that it **silently dropped 8 live objects** the
code depends on — the `file_stages` and `global_sentinels` views, the
mtime-cascade triggers, the `audit.run_diff` function, `users.job_title`, most
indexes — and renamed `memberships` columns without touching the Rust that
reads them. Because this codebase uses **runtime-checked `sqlx::query` (not the
compile-time `query!` macro)**, none of that fails `cargo check`; it fails at
runtime when the endpoint is first hit. A hand-written baseline is exactly the
artifact where such omissions hide.

So the baseline is **derived from a verified `pg_dump --schema-only` of the
live DB** (snapshot kept at [`init.generated.sql`](init.generated.sql)), then
edited only where we deliberately wanted a change. Fidelity was then *proven*
by diffing a fresh dump of the rebuilt DB against that snapshot — every
difference was an intended change or cosmetic (plpgsql whitespace, column
order, auto-generated constraint names; none affect behaviour since decode is
by-name and no code references the constraint names).

We also **did not partition** the observability tables (the original draft
proposed it). It's premature pre-launch, it would have dropped the existing
indexes, and the `DEFAULT`-partition + monthly-cron maintenance is real
operational debt. `db_query_log` already has a retention sweep. Revisit when a
table actually crosses tens of millions of rows.

## The four intended changes (everything else is byte-faithful)

1. **`entities.type` CHECK gains `'team'`.**
2. **New `teams` table** — company-scoped, entity-registered so `memberships`
   can FK it. Unused by code today; pre-stages the RBAC team-inheritance model
   in [`rbac.md`](rbac.md). *(Needs a RedPash-ID prefix allocated before it's
   wired up — see [`../redpash-id.md`](../redpash-id.md).)*
3. **`users.status`** (`active` / `suspended` / `archived`) — pre-stages the
   account-lifecycle / scrub-retain work.
4. **`memberships`: `display_name` + `relationship_attribute` → one
   `context_role`** descriptor. The Rust that reads the old columns
   (`CASE_SELECT` case-people LATERALs, `list_cases`/`count_cases`,
   `set_case_person` in `db/mod.rs`) was updated in the same change; `cargo
   check` passes.

Plus one fix-along-the-way: **`case_categories`** now uses two partial-unique
indexes with `COALESCE(company_id,'')` (root vs child) instead of the single
`UNIQUE(parent_id,name,company_id)`. The old constraint let duplicate roots and
duplicate global categories through, because Postgres treats NULLs as distinct.

## How the rebuild was done (no sqlx-cli installed)

```bash
# 1. Archive the old migrations, leaving only the baseline in migrations/.
mkdir -p backend/.migrations_archive_pre_baseline
#   (move every backend/migrations/*.sql except 20260529000000_init.sql)

# 2. Drop + recreate the database (localhost prerelease).
psql "postgres://mansa:mansa@localhost:5433/postgres" \
  -c "DROP DATABASE IF EXISTS redpash_prerelease WITH (FORCE);" \
  -c "CREATE DATABASE redpash_prerelease OWNER mansa;"

# 3. Let the app apply the baseline. AppState::init runs
#    sqlx::migrate!(\"../../migrations\") at startup, so just boot it once —
#    this also writes the correct _sqlx_migrations checksum and runs bootstrap
#    (creates the dev user + default project).
( cd backend && cargo run )   # watch for "redpash-api listening", then stop

# 4. Verify fidelity: dump the rebuilt schema and diff against the snapshot.
pg_dump --schema-only --no-owner --no-privileges \
  "postgres://mansa:mansa@localhost:5433/redpash_prerelease" > /tmp/rebuilt.sql
diff <(grep -vE '^\\(un)?restrict|_sqlx_migrations' docs/db/update_db/init.generated.sql) \
     <(grep -vE '^\\(un)?restrict|_sqlx_migrations' /tmp/rebuilt.sql)
# → only the intended deltas above (+ cosmetic), nothing missing.
```

> If you install `sqlx-cli` later, `cargo sqlx database reset` is the one-liner
> equivalent of steps 2–3 and is the recommended path going forward.

## Result (verified on the rebuilt DB)

- migration `20260529000000 / init` applied, `success = t`
- 21 base tables (20 prior + `teams`); both views, both triggers, and
  `audit.run_diff` present; `users.job_title` retained, `users.status` added
- `memberships` columns: `object_redpash_id, user_redpash_id, role,
  context_role, joined_at`
- `entities_type_check` includes `'team'`; `case_categories_root_uq` +
  `case_categories_child_uq` present
- `cargo check` clean; app boots, bootstraps, and listens

## Follow-ups

- Allocate a `teams` RedPash-ID prefix and register `'team'` entities when
  teams get wired up.
- `schema.md` / `redpash-id.md` describe the *pre-consolidation* migration
  history. Refresh them to describe this single baseline + the new
  `teams`/`status`/`context_role` shape when convenient.
- `rbac.md` is a design spec, not yet-implemented behaviour — its `context_role`
  naming now matches the live column.
