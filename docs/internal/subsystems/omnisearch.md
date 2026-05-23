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
 WHERE (p.owner_id = $1
        OR EXISTS (SELECT 1 FROM project_memberships m
                    WHERE m.project_redpash_id = p.redpash_id
                      AND m.user_redpash_id    = $1))
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
    WHERE (p.owner_id = $1
           OR EXISTS (SELECT 1 FROM project_memberships m ...))
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
