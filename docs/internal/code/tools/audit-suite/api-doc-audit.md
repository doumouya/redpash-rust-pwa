---
title: tools/api-doc-audit/audit.js
source: ../../../../../tools/api-doc-audit/audit.js
owner: Torv
section: Internal · Code · Tools · audit-suite
last modified date: 2026-06-03
---

# api-doc-audit

## Purpose

Verifies the hand-written API documentation against the code. The axum routes
in `backend/crates/api/src/routes/` are the single source of truth; the
`docs/internal/rest-api/*.md` per-resource pages can drift from them (the route
TABLE in `rest-api/index.md` is doc-gen-generated, so it can't — this tool
guards the hand-written per-resource WHY). This tool extracts both sides
and diffs them — the way [`crossing-audit`](crossing-audit.md) diffs JS calls
against routes, except here the doc surface is the other side. It closes a real
gap: [`doc-coverage-audit`](doc-coverage-audit.md) enforces
*atomic-doc-per-source-file* coverage, but nothing checked that a *documented
endpoint matches a served route* until this tool.

## Public surface

- Auto-discovered by [`audit.sh`](../shell/audit.md) as `api-doc`.
- Emits `report.html` (dark, tabbed by finding kind) + `audit.json`
  (DB-ingest shape) + a console summary. Exits 0 on a successful run (the
  suite convention — regression gating is `ci-audit`'s job via
  `audit.run_diff`, not this exit code).
- Finding kinds:
  - `undocumented_endpoint` — route served, no doc covers it.
  - `stale_doc_endpoint` — doc documents a path no route serves.
  - `method_mismatch` — same path, doc/code methods differ.
  - `path_param_mismatch` — same normalised path, raw `:param` name differs
    (e.g. `:user_id` vs `:member_id`).
  - `auth_mismatch` — code route is platform-admin-gated, the doc describes it
    as public/open (file-level).
  - `doc_missing` — a route module has no `docs/internal/rest-api/<module>.md`.

## Internal contracts

- Code side comes from [`tools/lib/rust-routes.js`](../lib/rust-routes.md);
  both sides normalise paths via its `norm()` so they compare identically.
- Doc side parses heading endpoints `` ## `METHOD /api/path` `` (incl. compound
  `` …/undo` and `/redo` `` / `` …/cleanness` and `DELETE` ``) **and** table-row
  endpoints `` | `GET /api/admin/users` | … `` (admin/monitoring document their
  surface as a table). Retired stubs (`title: … (retired)` or zero endpoints)
  contribute nothing and aren't flagged.
- Intentional gaps live in `tools/api-doc-audit/acks.json`, keyed by finding
  kind. `doc_missing` entries are module names; endpoint entries are exact
  paths, `/prefix/*` subtrees, or `:param`/`*slug` (normalised) matches.

## Drift-prone areas

- A new doc layout (endpoints expressed as neither `## ` heading nor `| ` table
  row) would be missed — the parser would false-report them as undocumented.
- `acks.json` is the false-positive valve; an intentional gap not listed there
  surfaces as a finding (by design).
- The auth heuristic is conservative (only the gated-code-vs-open-doc
  direction); it relies on prose keywords ("open today", "public") so reworded
  prose could slip past.
- Schema parity is field-name level (not type/nesting): doc jsonc blocks vs the
  request/response struct's wire fields, honoring serde rename/rename_all/flatten,
  and only flagging REQUIRED struct fields as missing. Nested object fields aren't
  recursed; the `syn` escalation path covers that if needed.
- Secondary surfaces (the old public `docs/REDMAP.md`, `docs/INDEX.md`,
  `subsystems/api-routes.md`) were deleted/archived in the docs rebuild
  (CAS_701CF65E) — those checks now self-skip (guarded `read() == null`). The
  single nav map is `docs/internal/redmap.md` + the generated route table; a
  follow-up can point the stale-entry check there if wanted.

## Dependencies (upstream)

- `tools/lib/rust-routes.js` (code route set + `norm`).
- `docs/internal/rest-api/*.md` (doc surface; `index.md` skipped — it's the
  generated route table, not a per-resource page), `tools/api-doc-audit/acks.json` (allowlist).

## Related docs

- [Shared extractor: rust-routes](../lib/rust-routes.md)
- [Audit-suite landing](index.md)
- [Master runner: audit.sh](../shell/audit.md)
- [REST API section](../../../rest-api/index.md)
