---
title: Joins
section: Features
order: 4
last modified date: 2026-05-30
---

# Joins

Two-file joins inside a project: pick a base file, the detector
scores candidate key pairs against every other file in the same
project, and the user accepts one to materialise a joined CSV as a
new file.

Port of clarna-django's `detect_join_keys` — same overlap-score
algorithm, ported to Polars in `data::joins`.

## Detect

`GET /api/files/:rid/joins?filters=<json>`:

1. For each column in the **base** frame, collect a `HashSet` of
   unique non-empty stringified values, capped at `MAX_UNIQUE = 5000`.
2. For each *other file in the same project*, repeat — limited to the
   first `MAX_UNIQUE` unique values per column.
3. Score every `(base_col, other_col)` pair by the **overlap
   coefficient**:

   ```
   score = |A ∩ B| / min(|A|, |B|)
   ```

   This favours subset relationships (FK → PK) over Jaccard, which
   penalises asymmetric sizes.

4. Drop pairs where either side has fewer than `MIN_UNIQUE = 1` unique
   values (`MIN_UNIQUE` was lowered from 5 — see the comment in
   `data/joins.rs` — to permit single-value joins produced by a narrow
   filter like `matricule = 1243`).
5. Sort descending by score, cap at `max_results`.

Result: a list of `JoinCandidate { this_col, other_col, score,
matches, this_uniques, other_uniques, samples }`. `score` is the sort
key (invisible to the user); the frontend renders raw counts —
`matches of this_uniques base values match (other file has
other_uniques unique)` — so coverage + cardinality read at a glance.
Up to 5 sample values per pair let the user spot-check before
applying.

## Filter-aware

Both endpoints accept a `filters` parameter (as URL-encoded JSON for
GET; in the request body for POST). When set, only the base file's
frame (the `this` side) is filtered before detection / application via
`data::parse::apply_filter` — the other frame is never filtered. It's
the same `FilterNode` tree used by reports and the cleaner.

This was added after the join detector kept returning the
unfiltered key set even when the user had narrowed the base file with
the filter panel.

## Apply

`POST /api/files/:rid/joins`: stream-writes the joined frame to disk.
Body: `{ other_file, this_cols: [], other_cols: [], join_type, name?,
filters? }` — `this_cols` and `other_cols` are arrays paired by
position, so single-key joins pass `len == 1` and **compound (multi-
column) joins pass `len == N`**. `join_type` is `inner | left |
right | outer` (default `inner`).

- Polars `LazyFrame.join(other, left_on, right_on, JoinType::<jt>)`.
- Both key columns are cast to `String` before joining — heterogeneous
  dtypes (e.g. int vs str matricules) would otherwise fail.
- Output is written via `CsvWriter::new(file)` directly to disk — no
  intermediate `Vec<u8>` — because OOM during a 400k×400k join was
  killing the API process.

## UI

Joins panel in the cleaner sidebar. Click "Detect joins" → shows the
candidate list with score, match count, sample values, and a "use" /
"apply" button per row.

## Future

- Cross-project joins.

> **Shipped since the original doc** (moved out of Future
> 2026-05-24): all four join types (`inner | left | right | outer`,
> default `inner`); compound (multi-column) keys via paired
> `this_cols` / `other_cols` arrays. The backend has supported these
> since the joins endpoint landed; the UI is the gap and a workspace
> Joins panel rewrite is queued (see `Internal-Slack/Torv.md` —
> 2026-05-24 design thread).
