---
title: 0011 — object_kind rid-prefix mis-dispatch (TEM_/TEAM, CON_, dead DSH)
date: 2026-06-07
case: CAS_0FBF301F
area: backend/rbac + type_cache
---

# 0011 — object_kind rid-prefix mis-dispatch

## Symptom

`rbac::object_kind` mapped rid prefix `"TEAM"` → team and `"DSH"` → dashboard,
but teams are minted `TEM_` and dashboards `FIL_`. So `object_kind("TEM_…")`
returned `"unknown"` (the team contract-RBAC grant never fired) and the `"DSH"`
arm was dead (a dashboard rid resolved as `"file"`). Latent — contract-RBAC
(`require_action`) is the not-yet-converged gate, so live blast was low, but it
would surface when custom-type contracts land (Stage 3).

## Root cause

The prefix → type map was a hardcoded `match` that drifted from the actual
minted prefixes (`id::new` + `type_registry::builtin_meta` use `TEM_`/`FIL_`; the
match used `TEAM`/`DSH`). A closed code-side lookup with no single source of
truth — exactly the rigidity the object-registry arc removes.

## Fix (object-registry Stage 1, CAS_0FBF301F)

`object_kind` is now registry-driven: `type_cache::TypeDefCache::object_kind`
reads the seeded `type_definitions.rid_prefix` map (ordinal-ordered, so the
shared `FIL_` resolves to `file`). `TEM_` → team and `CON_` → connection now
dispatch correctly; the dead `DSH` arm is gone. Pinned by
`object_kind_is_registry_driven` (`type_cache.rs`). The behaviour change
(team/dashboard contract grants begin firing where they silently didn't) is
intentional and was Em's call (fix in-arc, not preserve).

## Verify

`cargo test -p api object_kind_is_registry_driven`; live: a team rid resolves to
`"team"` in `require_action` (was `"unknown"`).
