---
title: backend/crates/api/src/field_validate.rs
source: ../../../../../backend/crates/api/src/field_validate.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-05-31
---

# field_validate.rs

## Purpose

Registry-driven **write-validation** of a field value against its
TypeDefinition `data_type` (spec [type-definition](../../specs/type-definition.md)
§4.2, CAS_0FBF301F): a pure format check + an async rid-reference existence +
`rel.type` check.

**Deliberately unwired** (Em decision, 2026-05-31). The per-resource PATCH
handlers (cases / companies / projects / charts / dashboards / files) already
validate builtin writes with bespoke per-field logic + FK constraints + the
`require_fields` perm gate ([field_perms.md](field_perms.md)). Retrofitting this
generic validator into them would duplicate working validation (code debt) for
no payoff — there is **no generic object-field-write endpoint today**. This is
the reusable validator the FUTURE custom-object PATCH endpoint will call: a
custom type has no source-code handler to bake validation into, so its writes
*must* be registry-driven. Built ready; not retrofitted. The module-level
`allow(dead_code)` marks that staged state.

## Public surface

- `pub enum FieldError` — `BadValue(String)` → HTTP 400, `MissingRef(String)` →
  HTTP 404 (the §4.2 status mapping the caller applies).
- `pub fn validate_format(data_type, value, options) -> Result<(), FieldError>`
  — PURE, no DB. Covers `string`/`markdown` (any string), `int`/`float`
  (JSON number OR numeric string), `boolean` (bool OR "true"/"false"), `enum`
  (∈ `options`), `datetime` (RFC-3339), `json` (object/array, or a string that
  parses), `rid` (string shape only). JSON `null` = clear-the-field → ok.
  Unknown `data_type` → `BadValue`.
- `pub async fn validate_ref(pool, rel, rid) -> Result<(), FieldError>` — the
  cross-type rid check: prefix mismatch → `BadValue`/400, absent row →
  `MissingRef`/404, unmapped `rel.type` → ok (fail-open; FK is the backstop).

## Drift-prone areas

- **Values arrive as native JSON OR as strings.** The cell-editor reads
  `contenteditable` and PATCHes strings, so the numeric/bool/json arms accept
  both forms. If a write path ever sends strictly-typed JSON, tightening these
  is safe — but don't *remove* the string-acceptance or it breaks the editor.
- **`ref_target` table/prefix map** mirrors the live DB (verified 2026-05-31):
  `user`→USR_/users, `company`→CMP_/companies, `project`→PRJ_/projects,
  `case`→CAS_/cases, `team`→TEM_/teams, `case_category`→CAT_/case_categories,
  and `file`/`chart`/`dashboard` all → `project_files` discriminated by
  `file_type` (`csv`/`chart`/`dashboard`) — `file` & `dashboard` even share the
  `FIL_` prefix. When a new type lands, add its row or refs to it fail-open.
- Table names are hardcoded constants spliced into the EXISTS query (never user
  input) — same injection-safe posture as `sort_clause`. Keep them literal.
- `validate_format` is unit-tested (8 cases); `validate_ref` is verified by its
  table mapping, not yet exercised by a live caller (it has none by design).

## Related

- [shared/type_def.rs](../shared/type_def.md) — the `FieldDef` whose `data_type`/`options`/`rel` this validates against.
- [type_registry.rs](type_registry.md) — produces those FieldDefs for builtin types.
- [field_perms.rs](field_perms.md) — the `Rel` type + the perm gate that runs alongside.
- [specs/type-definition](../../specs/type-definition.md) §4.2 — the validation contract.
