# The registry lives in Postgres; customer data lives client-side

RedPash's privacy posture is **bring compute to the data**: a customer's actual
rows (the CSV contents) stay on the device, in the wasm engine, and never need to
land on our servers. This record draws the line that posture must NOT cross, so a
future client-first push doesn't quietly move the wrong thing off the server.

## The decision (locked)

- **Customer DATA → client-side.** The cell values, the frames, the working tree —
  device-resident (Polars wasm; see [[client-data-engines]]). Governance moat: the
  raw data never has to leave.
- **The REGISTRY → Postgres.** Project ids, file ids, and their metadata
  (`projects`, `project_files`, `entities`, `memberships`, `project_steps`) live
  server-side as the redundancy / recovery store. Keeping the registry only on the
  client is too risky — a lost device or cleared browser would orphan a user's
  projects with no way to recover the structure. The registry is *about* the data,
  not the data itself; it carries no cell values.

## Why this is safe (no privacy cost)

The registry is ids + shape (filename, row/col counts, a cleanness score, a recipe
of steps) — never the contents. `project_steps` is the transform recipe, not the
rows it transforms; `cleanness_pct` is a single number. So the server can hold the
full registry for recovery while the data itself stays on the device. The two are
orthogonal: moving compute to the client never requires moving the registry off the
server, and vice-versa.

## What this enables

Because the registry is already in Postgres, it is directly browsable. The admin
**Data Registry** surfaces `file` + `project` (alongside the org builtins) as
redtable tables with a filter toolbar — read + filter + delete over the recovery
store, no new persistence. (Files/projects are created by their own flows — upload,
`/projects` — so the registry is read+delete only for them.)

## The guardrail

A change that moves the registry (ids/metadata) off the server, or that puts cell
VALUES into it, contradicts this record and is an Em-level decision, not a refactor.
