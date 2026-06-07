---
title: 0018 — Admin DB Console read-only query masks the real SQL error as "transaction is aborted"
date: 2026-06-07
case: CAS_DF1FB40749374EDDA88F11081105DC7A
area: backend/crates/api/src/postgres_loader.rs (query — Admin DB Console read-only SELECT)
---

# 0018 — DB Console query error masking

## Symptom

Found by **dogfooding our own connector against our own database** (the Admin DB
Console pointed at `127.0.0.1:5433/redpash_prerelease` — Em's directive: "even our
own database should be implemented through our current connector"). Any query that
referenced an unknown relation or column — e.g. `SELECT * FROM does_not_exist`,
`SELECT no_such_column FROM users`, or a cross-schema typo like `audit.events`
(the real tables are `audit.run` / `audit.finding`) — returned the useless error:

```
query failed: error returned from database: current transaction is aborted,
commands ignored until end of transaction block
```

instead of the real Postgres cause (`relation "..." does not exist` /
`column "..." does not exist`). A platform admin running ad-hoc SQL would get a
confusing, undebuggable message for the single most common mistake (a typo).

## Root cause

`postgres_loader::query` recovers the SELECT-list column ORDER from
`Connection::describe(sql)` (because `to_jsonb` object keys come back sorted and
can't carry order). That `describe` call ran **inside** the read-only transaction
(`BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout; describe(sql) …`)
and its `Result` was swallowed with `.unwrap_or_default()`. So on a bad query:

1. `describe(sql)` fails (Parse reports the real error) and **aborts the open
   transaction** — but the error is dropped by `unwrap_or_default()`.
2. The follow-up `SELECT to_jsonb(_q) FROM (sql) _q` then runs in the already-
   aborted txn, so Postgres returns the generic "current transaction is aborted",
   which is what surfaced — masking the real cause.

A two-statement (describe-then-fetch) flow where the first statement can fail
inside a transaction without its error being surfaced.

## Fix

Move `describe(sql)` to **before** `BEGIN` and surface its error instead of
swallowing it:

```rust
let ordered_cols: Vec<String> = (&mut pg)
    .describe(sql).await
    .map_err(|e| anyhow::anyhow!("query failed: {e}"))?   // real SQL error, no mask
    .columns().iter().map(|c| c.name().to_string()).collect();

pg.execute("BEGIN").await?;
pg.execute("SET TRANSACTION READ ONLY").await?;
pg.execute("SET LOCAL statement_timeout = '30s'").await?;
let fetched = sqlx::query(&wrapped).fetch_all(&mut pg).await; // first stmt in txn → clean error
```

`describe` is Parse+Describe only (no execution, no writes), so running it outside
the transaction is safe; the READ-ONLY transaction remains the execution guarantee
for the actual fetch. A bad-SQL describe now returns the real Postgres error and
never opens a transaction to poison; a valid describe yields the column order and
the fetch runs as the first statement in the txn, so any runtime fetch error is
also clean (not masked behind a prior failure).

## Verification

Live, against our own DB (`postgres_loader::tests::dogfood_query_our_own_db`,
`--ignored`):

- `SELECT * FROM does_not_exist_xyz` → `relation "does_not_exist_xyz" does not exist`
- `SELECT no_such_column FROM users` → `column "no_such_column" does not exist`
- `SELECT id FROM audit.run LIMIT 1` → rows (cross-schema query works)
- column ORDER still preserved (`SELECT redpash_id, username, role FROM users` →
  `[redpash_id, username, role]`, not alphabetised)

Regression assertion added to the dogfood test: a bad query's error must contain
`does not exist` and must **not** contain `transaction is aborted`.

## Related

- The cross-schema **browse** (the DB Console Tables explorer) is still single-
  schema per the connector's `schema` config — a known limitation, surfaced not
  hidden; cross-schema **query** works (schema-qualified SQL). Tracked separately.
- [postgres_loader.md](../code/backend/api/postgres_loader.md)
