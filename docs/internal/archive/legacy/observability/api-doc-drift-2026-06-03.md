---
title: API doc↔code drift report — 2026-06-03
section: Internal · Observability
owner: Torv
last modified date: 2026-06-03
---

# API doc↔code drift — 2026-06-03

> **RESOLVED 2026-06-03.** All 52 findings below were fixed the same day —
> `audit.run #243` is green (0 active findings, `52 fixed` vs the #241 baseline).
> New pages `docs/api/{teams,members,metrics}.md`; auth prose corrected on
> admin/monitoring; admin table + me/users/files/projects/companies blocks
> brought into parity; `INDEX.md` links reconciled. This snapshot is kept as the
> record of what drifted. Tracked in CAS_5FAB9871.

A point-in-time snapshot from [`tools/api-doc-audit`](../code/tools/audit-suite/api-doc-audit.md),
the new verifier that diffs the hand-written API docs against the served axum
routes (the single source of truth). Run `node tools/api-doc-audit/audit.js`
for the live `report.html`; this snapshot **seeds the remediation batch** — the
fixes themselves are a deliberate follow-up, not part of building the tool.

**52 active findings + 9 acknowledged** (zero false positives — every active
finding was hand-verified against the code). Captured against the post-merge
tree including `cf5c326` (`/metrics` gate) and `b8c0202`.

| Category | Count | Sev mix |
|---|---|---|
| `undocumented_endpoint` | 28 | 13 high · 15 med |
| `index_link_drift` | 8 | low |
| `method_mismatch` | 3 | med |
| `auth_mismatch` | 2 | high |
| `doc_missing` | 2 | med |
| `schema_field_undocumented` | 2 | med |
| `schema_field_missing_in_doc` | 6 | low |
| `path_param_mismatch` | 1 | low |

---

## High-severity (do first)

### auth_mismatch — docs understate the gate (RBAC has landed)
- **`docs/api/admin.md`** and **`docs/api/monitoring.md`** describe access as
  "Open today (solo/localhost); gate behind company-admin when RBAC lands."
  But the code now wraps `require_platform_admin_mw` on `/api/admin`,
  `/api/monitoring` (and `/api/metrics`) at the nest layer — the gate **has**
  landed. **Fix:** rewrite the access prose to "platform-admin only (404 on
  deny)"; drop the "open today" framing.

### undocumented_endpoint — whole subsystems with no docs (13 high)
- **`/api/teams/*`** — full CRUD (`GET·POST /teams`, `GET·PATCH·DELETE
  /teams/:rid`) is served but there is **no `docs/api/teams.md`** at all.
- **Generic object-members CRUD** — `GET·POST·PATCH·DELETE` on
  `/api/{projects,cases,teams}/:rid/members[/:member_id]` (the reach-aware
  `routes/members.rs` edge) is undocumented. (companies' members are partly
  documented — see `method_mismatch` + `path_param_mismatch`.)
- **`POST /api/files/:rid/steps/preview`** — served (state_ops), absent from `files.md`.

**Fix:** add `docs/api/teams.md`; document the generic members CRUD once
(it's one shape across all four parents) and link it from each parent doc.

---

## Medium-severity

### undocumented_endpoint — admin surface (admin.md table is incomplete)
`PUT /api/admin/fields` (high), plus `GET /api/admin/{audit-catalog, fields,
rbac, teams, teams/stats, types, types/:type}`. **Fix:** extend the admin.md
route table with these rows.

### undocumented_endpoint — misc
- `GET /api/me/avatar` — proxied avatar, missing from `me.md`.
- `GET /api/metrics` — now platform-admin-gated (`cf5c326`); has no doc page.

### method_mismatch — path documented, method not
- `GET /api/projects/:rid` — `projects.md` documents PATCH/DELETE + `/:rid/files`
  but not the `get_one` read.
- `PATCH /api/admin/users/:rid` — `admin.md` documents DELETE there but not the
  `patch_user_role` PATCH.
- `PATCH /api/companies/:rid/members/:member_id` — `companies.md` documents
  members GET/POST/DELETE but not the role PATCH.

### doc_missing
- **`teams`**, **`metrics`** — route modules with no `docs/api/<module>.md`.

### schema_field_undocumented — doc shows a field the struct doesn't have
- `GET /api/companies/:rid/members` doc shows **`user_redpash_id`**; the
  `CompanyMember` struct field is **`member_redpash_id`** (renamed in the
  polymorphic-members refactor). Doc is stale.
- `POST /api/files/:rid/cast-preview` doc request shows **`target`**; the
  `CastPreviewReq` field is **`dtype`**.

---

## Low-severity

### schema_field_missing_in_doc — required field absent from the doc block
- `GET /api/companies/:rid/members` — `member_redpash_id` (the rename above).
- `POST /api/files/:rid/cast-preview` — request `dtype`, response `total`.
- `GET /api/me` — response `is_platform_admin` (in `MeResponse`, not shown).
- `GET /api/users` — response `locale`, `prefs` (in `UserProfile`, not shown).

### path_param_mismatch
- `companies.md` documents `DELETE /api/companies/:rid/members/`**`:user_id`**;
  the route serves `…/`**`:member_id`**.

### index_link_drift — docs/INDEX.md API section
- **Omits** existing pages: `admin`, `cases`, `charts`, `companies`,
  `monitoring`, `search`, `users`.
- **Links the retired** `api/reports.md` as live `/api/reports/* CRUD`.

---

## Acknowledged (intentional gaps — in `tools/api-doc-audit/acks.json`)
- `POST /api/demo/{parse,avro-decode,validate}` — public landing-demo, no contract page.
- `GET /api/docs`, `GET /api/docs/*slug` — the docs viewer (meta).
- `POST /api/group/preview` — listed in `overview.md`, no per-page doc.
- `doc_missing`: `demo`, `docs`, `group`.

---

## How this was produced

`tools/api-doc-audit/audit.js` consumes the shared
[`tools/lib/rust-routes.js`](../code/tools/lib/rust-routes.md) extractor (code
side: method + path + nest-gate + request/response DTO fields) and parses the
four doc surfaces (`docs/api/*.md` headings + table rows + jsonc schema blocks,
the REDMAP API table, `api-routes.md`, `INDEX.md` links). Re-run any time:

```sh
node tools/api-doc-audit/audit.js     # → tools/api-doc-audit/report.html + audit.json
```

Once DB-ingested (audit-suite step), drift regressions gate CI via
`audit.run_diff` and surface on the Monitoring → Audit tab.
