# 0011 — object_kind rid-prefix mis-dispatch

Historical reasoning record. The bug below lived in the **predecessor** codebase
(the original `redpash-rust-pwa`, the reference the lean rebuild ports from). The
lean tree closes it *by construction* — `object_kind` was registry-driven from the
first commit, so there is no open fix to apply here. This runbook preserves the WHY
because it is the incident that locked [day-one decision #1](../../decisions/day-one.md)
(RID prefixes unique per type) and it explains the shape of the lean resolver.

Ties directly to the RedPash-ID model: see
[redpash-id.md](../code/backend/redpash-id.md) (the prefix → type registry and the
two mint paths).

## Symptom (predecessor)

`rbac::object_kind` mapped rid prefix `"TEAM"` → team and `"DSH"` → dashboard, but
the predecessor minted teams `TEM_` and dashboards as `FIL_` rows. So
`object_kind("TEM_…")` returned `"unknown"` (the team contract-RBAC grant never
fired) and the `"DSH"` arm was dead (a dashboard rid resolved as `"file"`). Latent
rather than user-visible — contract-RBAC was the not-yet-converged gate — but it
would have surfaced the moment custom-type contracts landed.

## Root cause

The prefix → type map was a hardcoded `match` that drifted from the actual minted
prefixes: the mint sites used `TEM_`/`FIL_` while the `match` arms said
`TEAM`/`DSH`. A closed code-side lookup with no single source of truth — exactly
the rigidity that the object-registry arc removes, and exactly why two surfaces
disagreed without anything failing loudly. The predecessor compounded this by
sharing `FIL_` between file and dashboard and disambiguating by registry *ordinal*,
so a dashboard could not even be told apart from a file by its id.

## How lean closes it (by construction)

Two day-one decisions remove the failure class:

1. **Unique prefix per type** ([day-one #1](../../decisions/day-one.md)). Dashboards
   mint their own `DSH_` (not `FIL_`); teams mint `TEM_`; connections mint `CON_`.
   The seed in [`20260612000000_init.sql`](../../../backend/migrations/20260612000000_init.sql)
   declares every `rid_prefix` in `type_definitions` as `NOT NULL UNIQUE`, so no two
   types can share a prefix and no ordinal tie-break is needed.

2. **Registry-driven resolution.**
   [`type_cache.rs`](../../../backend/crates/api/src/type_cache.rs) loads
   `type_definitions` once after migrate and builds a plain
   `by_prefix: HashMap<String, String>` (prefix → `type_id`). `object_kind` is a
   single `split_once('_')` + map lookup with no disambiguation:

   ```rust
   // type_cache.rs — TypeDefCache::object_kind
   pub fn object_kind<'a>(&'a self, rid: &str) -> &'a str {
       rid.split_once('_')
           .and_then(|(prefix, _)| self.by_prefix.get(prefix))
           .map(|s| s.as_str())
           .unwrap_or("unknown")
   }
   ```

   The map comes from the DB seed, not a hand-written `match`, so the two surfaces
   (mint + parse) cannot drift: minting reads `rid_prefix` for the type
   (`TypeDefCache::rid_prefix`) and parsing reads the same column the other way.
   There is no `rbac.rs` copy of the dispatch — `rbac::require_action`
   ([`rbac.rs`](../../../backend/crates/api/src/rbac.rs)) calls
   `cache.object_kind(object)` and routes on the result.

An unknown prefix resolves to `"unknown"` and is default-denied downstream — the
leak-free path, not a silent mis-route.

## Why this is the right shape long-term

The predecessor's `match` is the textbook closed-enum the registry arc is built to
delete: a per-type list in code that the seed data already owns. Adding a type on
lean is a `type_definitions` seed row (its prefix Just Works in `object_kind` and at
mint) — never a new `match` arm to keep in sync. A shared prefix would reintroduce
the ordinal ambiguity day-one #1 closed; a hand-written dispatch would reintroduce
the drift this incident was.

## Verify (on lean)

- `cargo test -p api` — `object_kind` is exercised through the RBAC matrix and the
  IDOR guard (`tests/objects_idor.rs` resolves a parent rid via
  `cache.object_kind`); `type_cache.rs` carries
  `builtin_tables_dedupe_the_file_family`, which pins the other half of the
  file/chart/dashboard arrangement — that the three types share ONE table
  (`project_files`) and so contribute the cascade arm exactly once. (Their
  prefix *uniqueness* — the half this incident was about — is pinned at the DB
  by the `rid_prefix … NOT NULL UNIQUE` seed, not by a test.)
- Spot-check: a team rid (`TEM_…`) resolves to `"team"` and a dashboard rid
  (`DSH_…`) to `"dashboard"` — the two cases the predecessor's `match` got wrong.
