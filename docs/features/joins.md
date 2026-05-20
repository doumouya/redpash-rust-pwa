---
title: Joins
section: Features
order: 4
last modified date: 2026-05-16
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
matches, samples }`, enriched with up to 5 overlapping values so the
user can spot-check before applying.

## Filter-aware

Both endpoints accept a `filters` parameter (as URL-encoded JSON for
GET; in the request body for POST). When set, both frames are filtered
before detection / application via `data::parse::apply_filter` — the
same `FilterNode` tree used by reports and the cleaner.

This was added after the join detector kept returning the
unfiltered key set even when the user had narrowed the base file with
the filter panel.

## Apply

`POST /api/files/:rid/joins`: stream-writes the joined frame to disk.

- Polars `LazyFrame.join(other, left_on, right_on, JoinType::Left)`.
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

- Right / inner / outer joins (currently left only).
- Composite keys (multi-column join).
- Cross-project joins.
