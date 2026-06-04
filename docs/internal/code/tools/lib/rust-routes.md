---
title: tools/lib/rust-routes.js
source: ../../../../../tools/lib/rust-routes.js
owner: Torv
section: Internal · Code · Tools · lib
last modified date: 2026-06-03
---

# rust-routes

## Purpose

The single code-side `/api` route extractor, shared by every tool that needs
the backend's served route surface. Before it, each tool rolled its own
regex: `crossing-audit` (JS↔Rust seam) and `list-endpoint-rbac-audit` (RBAC
posture) each had a private, shallower copy. Those copies silently
under-reported — `crossing-audit` read `routes/<mod>.rs` from top-level
`mod.rs` nests only, so it missed the whole `routes/files/` directory module,
every second-level `/:rid/members` nest, and never captured the HTTP method at
all. This lib centralises the extraction so a fix lands for every consumer at
once (the "one extractor, every consumer" framing), and is the source of truth
for `api-doc-audit`'s doc↔code parity diff.

## Public surface

- `rustRoutes(root)` — returns one record per `(method, path)` the backend
  serves: `{ method, path (raw), pathNorm (params→:_), file, line, handler,
  reqType, respType, rbac:{ source:'nest-layer'|'handler', hint:'platform_admin'|null } }`.
  `reqType`/`respType` are the `Json<T>` body types parsed from the handler signature.
  Resolves directory modules (`files`→`routes/files/mod.rs`), recurses
  `.nest()` to arbitrary depth (the generic members CRUD expands under each of
  projects/companies/cases/teams), captures every method in a `.route("/p",
  get(h).post(h2))` chain, and detects the platform-admin gate generically on
  any `.nest()` whose paren-matched span carries a `GATE_MW` `.layer(...)`.
- `norm(path)` — collapse param-ish segments to `:_`, strip `?query` + trailing
  slash (shared with `crossing-audit` so both compare paths identically).
- `stripQuery(path)` — depth-aware `?query` strip (a `${a?b:c}` ternary in a JS
  path is not mistaken for the query separator).
- `dtoFields(root, typeName, localText)` — resolve a DTO type to its wire field
  set `{ fields:[…], optional:{…}, listElem }`, honoring `#[serde(rename)]`,
  struct `rename_all`, `#[serde(flatten)]` (recursive), and the `{ items: Vec<T> }`
  list-wrapper. **Module-scoped**: pass `localText` (a module's source) so a struct
  name shared across modules (e.g. two `PatchUserBody`s) resolves to the handler's
  own one; falls back to the shared crate. Returns `null` when unresolvable
  (conservative — callers skip rather than guess).
- `moduleTextForFile(root, fileRel)` — the searchable source for a route file
  (`routes/users.rs` → users module; `routes/files/mod.rs` → the files/ dir),
  passed to `dtoFields` as `localText`.
- `GATE_MW` — the middleware names that gate a nest subtree (keep in sync with
  `backend/.../routes/mod.rs`).
- CLI: `node tools/lib/rust-routes.js [repoRoot]` dumps the route table.

## Internal contracts

- Comment/string-stripping is position-preserving (whitespace fill, newlines
  kept) so `lineOf()` byte indices map 1:1 back to the raw source.
- `parseTopNests` scans `mod.rs` only; deeper nests are found by recursion into
  each module file, with the accumulated prefix injected as an argument (never a
  global) so the same `members::routes()` expands distinctly per parent.
- Output is deduped by `(method, raw path)` and sorted by path then method.

## Drift-prone areas

- New router idioms — a macro-registered route, or a `.route()` whose method
  isn't one of get/post/put/patch/delete — would slip past the regex. The
  escalation path is a `syn`-based extractor emitting the same shape.
- `GATE_MW` is a hardcoded list; a new gate middleware must be added here or its
  subtree's `rbac.hint` will be wrong.
- Assumes a directory module registers all its `.route()`s in `mod.rs` (true
  today for `files/`); a dir module that split routes across sub-files would
  need the walk widened.

## Callers (downstream)

- `tools/api-doc-audit/audit.js` — the code side of the doc↔code diff.
- `tools/crossing-audit/audit.js` — migrating onto this lib (drops its private copy).
- `tools/list-endpoint-rbac-audit/audit.js` — its `parseNestGates` logic is
  absorbed here; migration is Torv-owned.

## Related docs

- [Audit-suite landing](../audit-suite/index.md)
- [api-doc-audit](../audit-suite/api-doc-audit.md)
- [Architecture: js-rust-boundary](../../../architecture/js-rust-boundary.md)
- [Subsystem: api-routes](../../../subsystems/api-routes.md)
