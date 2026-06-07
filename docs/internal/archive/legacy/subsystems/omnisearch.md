---
title: Omnisearch
section: Internal
order: 25
last modified date: 2026-05-24
owners: Gus (backend) + Torv (dropdown UI)
status: filled
---

# Omnisearch

The topbar's search input (every authed page has it; `Ctrl/Cmd+K`
focuses it) backed by a single `/api/search` endpoint. One flat
result list, kind-discriminated, with pre-built navigation hashes
per result so the dropdown's click handler is a one-liner.

Source of truth: `backend/crates/api/src/routes/search.rs`,
`backend/crates/shared/src/search.rs`,
`frontend/scripts/topbar.js`.

## Endpoint — `GET /api/search`

```
GET /api/search?q=<text>&limit=<int>   (limit default 20, max 100)
```

Auth: session required (401 without). The topbar is only rendered
on authed pages; calling unauthenticated returns 401 cleanly.

Wire shape (`shared::search::SearchResponse`):

```json
{
  "q": "cata",
  "ms": 7,
  "results": [
    { "kind": "project", "rid": "PRJ_…", "label": "catalog produits",
      "sub": "",                 "hash": "#/workspace?project=PRJ_…" },
    { "kind": "file",    "rid": "FIL_…", "label": "catalogue_produits_clean",
      "sub": "in catalog produits", "hash": "#/workspace?file=FIL_…" },
    { "kind": "chart",   "rid": "CHT_…", "label": "chart-002",
      "sub": "in test",          "hash": "#/workspace?file=CHT_…" }
  ]
}
```

Fields:

- `kind` — `project | file | chart | dashboard` today. String, not
  enum, so the wire stays additive (slice 4 + future command-
  palette kinds appear without a wire shape change).
- `rid` — the entity's RedPash-ID. Stable URL identifier.
- `label` — main display string (project name / file display_name
  fallback to filename / chart filename).
- `sub` — contextual sub-line. Project: description (or empty);
  file/chart/dashboard: `"in <project_name>"`.
- `hash` — pre-built navigation target. The dropdown does
  `location.hash = r.hash;` — no `kind → route` switch in JS.
  Backend owns the routing rule per kind so adding a new kind
  doesn't require a frontend update.

Empty / whitespace `q` short-circuits to `{ q, results: [], ms }`
with no DB hit — lets the frontend fire on every keystroke without
worry.

## Backend — query strategy

Two SQL queries per request, both user-scoped:

**1. Projects** — `name` + `description` ILIKE `%q%`, owner OR
project_membership:

```sql
SELECT p.redpash_id, p.name, COALESCE(p.description, '')
  FROM projects p
 WHERE (EXISTS (SELECT 1 FROM memberships m
                    WHERE m.object_redpash_id = p.redpash_id
                      AND m.member_redpash_id    = $1))
   AND (p.name ILIKE '%' || $2 || '%' OR
        COALESCE(p.description, '') ILIKE '%' || $2 || '%')
 ORDER BY (CASE WHEN p.name ILIKE $2 || '%' THEN 0 ELSE 1 END),
          p.updated_at DESC
 LIMIT 5
```

The `CASE` is the **prefix-match boost** — names *starting* with
the query rank above substring matches. So `q = "cata"` puts
`"catalog produits"` before any `"product-catalog-archive"`-style
hit.

**2. Files / charts / dashboards** — one query, three kinds. A CTE
with `ROW_NUMBER() OVER (PARTITION BY file_type)` caps each kind
at 5 inside SQL, so a chatty file_type can't monopolize the
result set:

```sql
WITH ranked AS (
   SELECT f.redpash_id, f.filename, f.display_name, f.file_type,
          p.name AS project_name, f.project_redpash_id,
          ROW_NUMBER() OVER (
            PARTITION BY f.file_type
            ORDER BY (CASE WHEN COALESCE(f.display_name, f.filename) ILIKE $2 || '%' THEN 0 ELSE 1 END),
                     f.updated_at DESC) AS rn
     FROM project_files f
     JOIN projects p ON p.redpash_id = f.project_redpash_id
    WHERE (EXISTS (SELECT 1 FROM memberships m
                   WHERE m.object_redpash_id = p.redpash_id AND m.member_redpash_id = $1))
      AND (f.filename ILIKE '%' || $2 || '%'
           OR COALESCE(f.display_name, '') ILIKE '%' || $2 || '%')
)
SELECT * FROM ranked WHERE rn <= $3
 ORDER BY file_type, rn
```

Results land in the response in this order: projects first, then
files/charts/dashboards by `file_type` ascending. Per-kind cap (5)
+ overall cap (`limit`, default 20) bound the response.

## User scoping (today's posture)

Both queries filter on `owner_id = caller OR ∃ project_membership`.
For solo-dev today, that's effectively "all rows the caller can
see"; when RBAC ships, the same predicate naturally extends to
"any project the caller has access to."

`?scope=admin` (slice 4) is reserved for the RBAC-gated org-wide
search adding `kind = "user" | "company" | "membership"` to the
result set. Wire shape stays additive — new `kind` values, same
DTO.

## Frontend — the dropdown (Torv's lane)

Wired in `frontend/scripts/topbar.js` per Torv's `085e7f9`. Key
behaviors:

- **Debounce 200ms** — every keystroke schedules a fetch; the
  prior is cancelled if a new keystroke lands inside the window.
- **AbortController on each call** — out-of-order replies can't
  overwrite a more-recent search. Stale replies are silently
  dropped.
- **Group by kind on render** — backend's order is already
  kind-grouped (projects → files → charts → dashboards), so the
  dropdown iterates once with a section header on transitions.
- **Per-kind icons** — `kindIcon(kind)` map in `topbar.js`:
  project → folder, file → file-earmark, chart → bar-chart,
  dashboard → grid. Unknown kind (future-proof for slice 4)
  falls back to `bi bi-dot`; section label auto-pluralizes
  (`<Kind>s`) so a new server-side kind needs zero frontend
  change.
- **Match highlight** — first case-insensitive substring of `q`
  wrapped in `<span class="rp-omni-hl">`. Lightweight; server
  doesn't ship match positions today. If FTS-style scattered
  matches matter later, the API can grow optional
  `match_positions: [start, end][]` on each result — additive,
  the highlight code slots it in.
- **Keyboard** — ↓/↑ cycle (wrap), Enter →
  `location.hash = r.hash`, Esc → close + blur. Active row uses
  `scrollIntoView({ block: "nearest" })` on each cycle.
- **Outside `mousedown` closes** — `mousedown` (not `click`)
  inside the dropdown fires before the outside-handler so
  navigation isn't swallowed.

## Wire DTO module — `shared::search`

```rust
pub struct SearchResult {
    pub kind:  String,                 // additive — no enum
    pub rid:   String,
    pub label: String,
    pub sub:   String,                 // empty if no context
    pub hash:  String,                 // navigation target
}

pub struct SearchResponse {
    pub q:       String,               // echoed for correlation
    pub results: Vec<SearchResult>,
    pub ms:      u32,                  // server time
}
```

`q` is echoed back so the frontend can correlate a late response
to its current input value (drop the response if the user has kept
typing past it — though AbortController catches most of those).
`ms` lets the dropdown show a quiet "12ms" if that ever becomes
useful UX.

## Adding a new searchable kind

| Where to source | Path |
|---|---|
| `routes/search.rs` | new SQL block — same ILIKE + prefix-boost pattern, per-kind LIMIT |
| The pushed `kind` string | `"user" | "company" | "membership" | …` (snake_case if compound) |
| `hash` per kind | the natural deep-link for that kind's detail surface |
| Frontend `topbar.js::kindIcon` | optional — unknown falls back to `bi bi-dot`, label pluralizes |

No DTO change; no frontend code change required if the icon
fallback is acceptable. That's the whole point of the
kind-as-string + hash-baked-server-side design.

## Slice 4 (deferred) — admin scope

`GET /api/search?q=...&scope=admin` extends the search to
admin entities (users / companies / memberships) when the caller
holds the company-admin role. Gated on RBAC landing — same posture
as the rest of `/api/admin/*`.

Slice 3 (command palette — nav shortcuts, actions like *Toggle
theme*) is deferred until Torv's slice 2 has soaked and we know
the dropdown's interaction model.

## Cross-cuts

- **Self-observation filter doesn't apply** to `/api/search` —
  search-the-search isn't a meaningful use case, and the
  request_log isn't read by this endpoint. Per the [api-routes](api-routes.md)
  pattern though, `capture_mw` does record every `/api/search`
  call in `request_log` and any error in `events` — same as
  every other endpoint.
- **WASM doesn't reach this**. Search is server-side by definition
  (the database is on the server). The wasm engine has no
  equivalent. If a future requirement wants offline search over a
  loaded project, that's a separate index built in the browser
  from the project's loaded data — a different feature.
- **Latency target**: <50ms p95 at solo-dev scale; ILIKE on
  indexed columns + small per-kind caps + a hard `LIMIT 5` per
  CTE row-number make this trivially achievable. If a workspace
  ever grows past tens of thousands of files-per-user, the right
  next step is a `tsvector` GIN index per searchable column, not
  pagination of the search results.

## Rust internals — query plan + ranking

### Projects query — algorithm + index path

```sql
SELECT p.redpash_id, p.name, COALESCE(p.description, '')
  FROM projects p
 WHERE (EXISTS (SELECT 1 FROM memberships m
                    WHERE m.object_redpash_id = p.redpash_id
                      AND m.member_redpash_id    = $1))
   AND (p.name ILIKE '%' || $2 || '%'
        OR COALESCE(p.description, '') ILIKE '%' || $2 || '%')
 ORDER BY (CASE WHEN p.name ILIKE $2 || '%' THEN 0 ELSE 1 END),
          p.updated_at DESC
 LIMIT 5
```

**WHERE clause structure** is OR-of-(owner OR member),
AND-of-(name OR description). Postgres' planner builds the
predicate set and chooses a plan:

- Small workspace (today's solo-dev): seq-scan + filter. Fast.
- Larger: the membership `EXISTS` (ownership + membership are one
  unified `memberships` table now) pushes down to `memberships_user_idx`.
  The index already exists for non-search reasons.

**ILIKE on `name`**: no `tsvector` / GIN index today. ILIKE with
both-side wildcards (`%q%`) can't use a B-tree even on a typed
expression. At solo-dev scale that's fine; it's a 30-row seq-scan.
The optimization horizon: `CREATE INDEX projects_name_trgm ON
projects USING gin (name gin_trgm_ops)` when row counts climb,
then ILIKE becomes index-scannable.

**ORDER BY CASE**: the prefix-boost trick. `CASE WHEN ... THEN 0
ELSE 1 END` evaluates per row at no extra index cost; sort key
is a tiny int. Cheap.

**LIMIT 5**: the per-kind cap. Hard-coded in `routes/search.rs`
as `PER_KIND_LIMIT`.

### Files query — the CTE + ROW_NUMBER trick

```sql
WITH ranked AS (
    SELECT f.redpash_id, f.filename, f.display_name, f.file_type,
           f.project_redpash_id, p.name AS project_name,
           ROW_NUMBER() OVER (
             PARTITION BY f.file_type
             ORDER BY (CASE WHEN COALESCE(f.display_name, f.filename) ILIKE $2 || '%' THEN 0 ELSE 1 END),
                      f.updated_at DESC
           ) AS rn
      FROM project_files f
      JOIN projects p ON p.redpash_id = f.project_redpash_id
     WHERE (EXISTS (SELECT 1 FROM memberships m
                   WHERE m.object_redpash_id = p.redpash_id AND m.member_redpash_id = $1))
       AND (f.filename ILIKE '%' || $2 || '%'
            OR COALESCE(f.display_name, '') ILIKE '%' || $2 || '%')
)
SELECT redpash_id, filename, display_name, file_type,
       project_redpash_id, project_name
  FROM ranked
 WHERE rn <= $3
 ORDER BY file_type, rn
```

**Why one query, not three** (one per file_type): the CTE
materializes all matching rows once, then ROW_NUMBER caps each
`file_type` partition at 5. Three separate queries would walk
the table three times; this walks it once.

**`PARTITION BY file_type`**: applies the LIMIT-per-kind logic
inside SQL. A chatty file_type (say, hundreds of charts matching
`"chart"`) can't crowd out files / dashboards.

**Sort key**: same prefix-boost CASE + `updated_at DESC` tiebreak.
The most recently updated matching entries surface first within
each kind.

**`COALESCE(f.display_name, f.filename)`** for the prefix check —
files may carry an explicit display_name (sometimes rare), fall
back to the filename otherwise.

### Why no full-text index

`tsvector` + GIN index is the standard answer for "search this
column fast." We don't use it because:

1. **Per-language config**: `to_tsvector('english', name)` needs
   a config. RedPash supports multiple locales; a one-config
   index would penalize the wrong ones. Multi-config indexes
   are doable but add operational overhead.
2. **ILIKE is fast enough today**. Solo-dev plus small
   workspaces means the seq-scan cost is unmeasurable. We have
   no `EXPLAIN ANALYZE` showing search as a hot path.
3. **Substring vs token match semantics**. `tsvector` matches
   on word boundaries; ILIKE matches mid-word. The "cata" → "catalog"
   demo case works with ILIKE but would miss with default tsvector
   tokenization (since "cata" isn't a token, and a `:*` prefix
   match would catch it but loses mid-word like "incatalog").

When search becomes a real cost: switch to `pg_trgm`'s gin index
(handles ILIKE-style mid-word matches in index time) before
considering full-text.

### Rust assembly — `routes::search::search`

```rust
pub async fn search(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<SearchQuery>,
) -> Result<Json<SearchResponse>, AppError> {
    let started = Instant::now();
    let user = super::resolve_user_rid(&state, &headers).await?;

    let q_raw = q.q.unwrap_or_default();
    let q_trim = q_raw.trim();
    let total_cap = q.limit.unwrap_or(DEFAULT_TOTAL_LIMIT).clamp(1, MAX_TOTAL_LIMIT);

    if q_trim.len() < MIN_Q_LEN {
        return Ok(Json(SearchResponse {
            q: q_trim.into(),
            results: Vec::new(),
            ms: started.elapsed().as_millis() as u32,
        }));
    }

    let q_owned = q_trim.to_string();
    let mut results: Vec<SearchResult> = Vec::with_capacity(total_cap as usize);

    // Projects query → push results
    // Files/charts/dashboards CTE → push results

    results.truncate(total_cap as usize);
    Ok(Json(SearchResponse {
        q: q_owned, results,
        ms: started.elapsed().as_millis() as u32,
    }))
}
```

**Constants** (top of file):

```rust
const PER_KIND_LIMIT:     i64 = 5;
const DEFAULT_TOTAL_LIMIT: u32 = 20;
const MAX_TOTAL_LIMIT:     u32 = 100;
const MIN_Q_LEN:           usize = 1;
```

- `MIN_Q_LEN = 1` — single-char queries are accepted; the per-
  kind LIMIT bounds the result count. Bumping to 2 would skip
  the "type one letter" feedback users sometimes want.
- `DEFAULT_TOTAL_LIMIT = 20` — at most 20 rows across 4 kinds
  with 5 per kind. A typical dropdown shows the full count
  without scrolling.
- `MAX_TOTAL_LIMIT = 100` — hard cap from the caller; clamps
  the `?limit=` param.
- `PER_KIND_LIMIT = 5` — the partition limit. Chosen because
  the dropdown's section header + 5 rows + headroom for 4 kinds
  ≈ 20 visible items; matches `DEFAULT_TOTAL_LIMIT`.

**No early return on empty filter**: even when one query
returns 0 results, the other still runs. Two round-trips to the
DB regardless. Could be parallelized via `tokio::join!` for ~2x
speedup on the wall clock — open optimization horizon. At
current latencies (~5-15ms total) the gain is marginal.

### `hash` field — backend-owned routing

The wire `hash` per result is computed server-side per kind:

```rust
// Project
SearchResult {
    kind:  "project".into(),
    hash:  format!("#/workspace?project={rid}"),
    ...
}
// File / chart / dashboard
let hash = format!("#/workspace?file={rid}");
let kind = match file_type.as_str() {
    "chart"     => "chart",
    "dashboard" => "dashboard",
    _           => "file",
}.to_string();
```

**Backend names the destination**. The frontend's click handler
is `location.hash = r.hash` — no JS-side `switch (kind)` mapping
to URL. Adding a new kind requires only that the backend ship a
`hash` that the frontend's router knows how to handle; the
dropdown code is unchanged.

## Optimization map

| Phase | Cost | Optimization horizon |
|---|---|---|
| Auth resolve (session lookup) | ~1ms DB call | already on every endpoint; cached future via JWT or in-memory session map |
| Empty-q short-circuit | constant | already optimal |
| Projects + files queries | ~5-10ms each at solo scale | parallelize via `tokio::join!` for 2x; pg_trgm index when scale demands |
| Result assembly | µs | n/a |
| Wire size (typical 20 rows) | ~3-5 KB | n/a |

**Slice 4 (admin scope)** will need a third query path for
admin entities (users / companies / memberships). Same shape;
adds ~5-10ms when invoked. Gated behind RBAC, so most callers
will never trigger it.

**Slice 3 (command palette)** — nav shortcuts ("Settings",
"Toggle theme") + actions — adds *no* SQL. The matching happens
client-side against a small static command list, results
interleave into the existing dropdown. Backend stays as-is.
