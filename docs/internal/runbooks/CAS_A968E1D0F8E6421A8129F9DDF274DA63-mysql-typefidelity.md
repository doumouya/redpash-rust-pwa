---
title: "MySQL connector silent data loss: FLOAT truncation + spatial SRID drop"
order: 17
case_id: CAS_A968E1D0F8E6421A8129F9DDF274DA63
section: Internal
severity: Sev2
last modified date: 2026-06-07
owner: Torv
---

# CAS_A968E1D0 — MySQL connector type fidelity: FLOAT 6-digit truncation + spatial SRID drop

## Problem Statement

`mysql_loader::project_expr` projects every source column to UTF-8 text for the CSV
the connector hands to the framework. An empirical MySQL 8.4.9 bench audit (part of the
SQL-connector lane build-out) found two cases where that projection **silently loses
data** — the pull succeeds, the values look plausible, but they no longer represent the
source:

1. **FLOAT** columns rendered via `CAST(col AS CHAR)` show only ~6 significant digits —
   too few to round-trip a binary32 (24-bit mantissa needs 9). `CAST(1.0/3.0 AS FLOAT)`
   landed as `'0.333333'`, which re-parses to a *different* float. Value-dependent
   (simple decimals like `0.1` happen to survive), so it is easy to miss.
2. **Spatial** columns rendered via `ST_AsText` drop the **SRID** entirely. A `SRID=4326`
   geometry and a `SRID=0` geometry with identical coordinates projected to byte-identical
   text — the spatial reference system (the *meaning* of the coordinates) was lost.

## Troubleshooting steps

1. Built a scratch DB covering the full MySQL type surface with edge values (FLOAT `1/3`,
   BIGINT-UNSIGNED near 2^64-1, DECIMAL(38,10), DATETIME(6), JSON with key-order + unicode,
   POINT at SRID 4326 vs 0, BINARY/BLOB, CHAR vs VARCHAR with trailing spaces, SET, BIT).
2. For each column compared the loader's type-specific projection AND `CAST AS CHAR`
   against the inserted literal, round-tripping where possible.
3. Confirmed FLOAT loss: `CAST(CAST(CAST(1/3 AS FLOAT) AS CHAR) AS FLOAT) != CAST(1/3 AS FLOAT)`
   (round-trip = 0); the truth via DOUBLE is `0.3333333432674408`.
4. Confirmed SRID loss: `ST_AsText(pt@4326) = ST_AsText(pt@0)` → identical text; SRID only
   survives in `ST_SRID()` or the internal `HEX(geom)` prefix.
5. Cleared the rest: BIGINT-UNSIGNED max, DECIMAL full scale, all temporal microseconds,
   integers, binary-via-HEX, ENUM, VARCHAR/TEXT — all faithful. DOUBLE round-trips except a
   narrow DBL_MIN-subnormal edge.

## RCA

Both losses are at the **type→text conversion**, but of different kinds:

- **FLOAT**: MySQL's FLOAT→string conversion is precision-limited (~6 digits). The fix is
  to widen to DOUBLE first — every binary32 is exactly representable as binary64, and
  DOUBLE→string is shortest-round-trippable in MySQL 8 — then to CHAR (the loader decodes
  every column as `Option<String>`, so the projection must end in a string type).
- **Spatial**: `ST_AsText` is defined to emit plain WKT, which has no SRID slot. EWKT
  (`SRID=<n>;<WKT>`) carries it. `CONCAT` of a NULL geometry is NULL → empty CSV field, so
  NULLs are unaffected.

A third class surfaced that is **NOT projection-recoverable** — the loss happens at MySQL's
storage/retrieval layer before the projection ever sees the value, so it is documented as a
**contract**, not fixed: JSON is stored normalized (object keys reordered, duplicate keys
dropped at INSERT, `:`/`,` spacing inserted); CHAR(N) strips trailing spaces on read (PAD
SPACE); BIT emits the integer value (declared width not preserved); SET emits members in
definition order; TIMESTAMP renders in the session TZ (pinned UTC).

## Solution

`mysql_loader::project_expr` (Slice B):

- **FLOAT** → `CAST(CAST(col AS DOUBLE) AS CHAR)` — full shortest-round-trippable precision.
  DOUBLE stays on the default `CAST AS CHAR` arm (already faithful).
- **Spatial** (all 8 geometry types) → `CONCAT('SRID=', ST_SRID(col), ';', ST_AsText(col))`
  (EWKT) so the SRID survives. `projection_label` updated `WKT`→`EWKT`, added `float`→`double`.
- **Contract documented** in the loader header + atomic doc (JSON normalization, CHAR
  trailing space, BIT width, SET order, TIMESTAMP UTC) so downstream consumers know what is
  and isn't preserved. Axis-order caveat noted: 4326 WKT output from `ST_AsText` is long-lat
  even though MySQL stores 4326 lat-long.
- **Deferred:** VECTOR (MySQL 9) is unprobed — the open-ended default arm still extracts it;
  add a measured arm if a bench probe shows `CAST AS CHAR` mangles it.

## Post Checking

- `mysql_loader` unit tests pass (9), incl. `projects_spatial_as_ewkt_with_srid` and
  `projects_float_via_double_for_precision`; existing arms unchanged.
- Live bench (MySQL 8.4.9, scratch DB dropped same-turn): `CAST(CAST(1/3 AS FLOAT) AS DOUBLE)`
  → `0.3333333432674408` (full) vs old `0.333333` (lossy); `SRID=4326;POINT(2.5 49.1)` vs
  `SRID=0;POINT(2.5 49.1)` — the two identical-coord points now disambiguate.
- Discipline rule: a projection arm that returns a non-string SQL type (e.g. bare
  `CAST AS DOUBLE`) breaks `run()`'s `Option<String>` decode — every arm must end in CHAR /
  HEX / CONCAT (a string). The empirical mysql-CLI audit hides this (CLI prints all types as
  text); the Rust decode is the real constraint.
