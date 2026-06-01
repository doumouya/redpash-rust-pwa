---
title: TypeDefinition — runtime-typed object contract
section: Internal
order: 67
last modified date: 2026-06-01
owner: Torv
status: spec v1 co-authored 2026-05-31 (Torv-FE writes; Torv-BE provides §3 + §4 tables; Em approves Q1/Q4/Q5) · **v2 field validation shipped 2026-06-01 (CAS_C7AEBE83, §8)** — two-tier validator, hand-rolled DSL, calibration gate. Coordination case CAS_0FBF301FDD0F4EF49AD6BF0E3FE105FC. Sibling-of CAS_9E4F134B (framework-layer epic); blocks every framework child case including CAS_8A210C7A (cell-editor).
---

# TypeDefinition — runtime-typed object contract

## 0. Why this exists

Em 2026-05-31 (saved as [[disposability-design-principle]] keystone memory):
*"what we are building now is already obsolete, we just don't know yet
at which point it is. We should be able to get rid of anything in the
codebase at minimal cost."* Decades-of-innovation strategy: parameterize
everything, design for cheap deletion + replacement, support user-defined
custom objects from day one.

The TypeDefinition interface is the runtime face of that principle for
data types. Every framework module (cell-editor, chip-render, list-page,
filter-builder, ...) consumes a TypeDefinition INSTEAD of hardcoded
object types. When a customer ships a `RealEstateListing` custom object,
zero framework source changes — the customer's TypeDefinition flows
through the same primitives as the 5 built-in types (user / company /
project / case / team).

Without this contract, every framework extraction bakes assumptions
about the 5 fixed object types into its parameters → invisible coupling
→ each future custom-object request demands a framework rewrite. With
it, framework code never needs to know whether it's rendering `case` or
`RealEstateListing`.

## 1. Scope of spec v1

What this spec defines:

- The TypeDefinition wire shape (§2).
- The Permissions Contract: `perm_class` derivation + override layering (§3).
- The Storage Contract: `data_type` ownership + write-validation rules (§4).
- The Presentation Contract: `editor` opacity + the FE editor-registry pattern (§5).
- An acceptance test the implementation must clear (§6).
- Implementation sequence across both lanes (§7).

What this spec does NOT define (deferred):

- The mechanism for end-users to CREATE custom TypeDefinitions
  through the UI (admin console design).
- The schema for the type-registry table that stores user-defined
  TypeDefinitions (lands with the first custom-objects feature).
- v2 editors (datetime, markdown, number, etc.) — each lands as its
  own child case when a TypeDefinition's `data_type` surfaces them.

## 2. The TypeDefinition shape

```ts
interface TypeDefinition {
  // ── identity ──────────────────────────────────────────
  type:                string;    // "user" | "case" | "<custom_type_id>"
  rid_prefix:          string;    // "USR_" | "CAS_" | "RES_" (3-char uppercase, collision-checked, user-chosen with auto-gen fallback per Em Q4)
  display_name:        string;    // "Case" / "Real Estate Listing"
  display_name_plural: string;
  is_builtin:          boolean;   // true for the 5 fixed types; false for user-defined
  source_origin?:      string;    // "schema" | "user_defined" | "external"

  // ── fields ────────────────────────────────────────────
  // Authoritative field catalog. Each entry carries STORAGE metadata
  // (data_type / required / default — §4) + PRESENTATION metadata
  // (editor / options / render / data_* render rules — §5) + PERMISSION
  // metadata (perm_class — §3). The fields[] entries on the wire ALSO
  // include the resolved per-role permission cells (owner / admin /
  // member / viewer) per §3, so the FE gets everything in one fetch.
  fields: FieldDef[];

  // ── relationships ─────────────────────────────────────
  // Cross-type pointers. Lets entity-pickers + introspection work
  // without hardcoding type → type edges.
  relationships?: RelationshipDef[];

  // ── UI hints (extensible) ─────────────────────────────
  // Default rail icon / column visibility / sort / chip rendering.
  // Consumed by the future generic list-page renderer to auto-build
  // a tab for any type.
  ui_hints?: UIHints;
}

interface FieldDef {
  key:           string;            // wire field name, also the data-edit-key
  label:         string;            // user-facing column label
  data_type:     "string" | "int" | "float" | "boolean" | "enum"
              | "datetime" | "rid" | "markdown" | "json";   // §4 BACKEND-owned
  required?:     boolean;
  default?:      unknown;

  // ── PRESENTATION (§5, FE-owned, opaque to backend) ──
  editable?:     boolean;
  editor?:       string;            // "text" | "chip-enum" | "entity-picker"
                                     // | "<custom-editor-id>"
                                     // Opaque to backend. FE editor-registry
                                     // looks up by id; falls back to "text"
                                     // on unknown id.
  options?:      string[];          // for enum data_type — also used by
                                     // chip-enum editor
  render?:       string;            // chipRenderFor key (e.g. "planChip")
  data_full?:    boolean;           // requires data-full source-of-truth attr
  data_trunc?:   number;            // display truncation length
  data_prefix?:  string;            // display prefix (e.g. "@")

  // ── PERMISSIONS (§3) ─────────────────────────────────
  perm_class?:   "standard"         // W·W·R·R (default)
              | "collaborative"     // W·W·W·R — member-writable content (e.g. case title/description, where participants edit)
              | "owner_grade"       // W·R·R·R — ownership transfer / re-scope
              | "personal"          // W·N·N·N — owner-only personal pin
              | "readonly";         // R·R·R·R — system / computed

  // ── per-row resolved permission cells (set by the SERVER on read,
  //    NOT specified by the FE on write) ────────────────────────────
  owner?:        "write" | "read" | "none";
  admin?:        "write" | "read" | "none";
  member?:       "write" | "read" | "none";
  viewer?:       "write" | "read" | "none";

  // ── relationships ────────────────────────────────────
  rel?:          { type: string; multi: boolean };  // e.g. {type:"user", multi:false} for case.assignee_id
  requires_admin?: boolean;         // FE-side gate hint (separate from perm_class)
}

interface RelationshipDef {
  field:  string;       // the field on THIS type
  to:     string;       // the OTHER type's `type` id
  multi:  boolean;      // single-rid (case.assignee_id) vs array (case.watchers)
  via?:   string;       // for memberships-style edges
}

interface UIHints {
  rail_icon?:        string;                          // "bi-card-list"
  default_columns?:  string[];                        // field keys shown by default
  default_sort?:     string;
  list_filters?:     string[];
  chip_render?:      Record<string, string>;          // field-key → chipRenderFor key
}
```

## 3. Permissions Contract

Permissions are NOT hand-authored per (object, field). The default permission
matrix DERIVES from `perm_class` generically — works for builtin AND custom
types with zero hand-authoring (a custom type's perms have to be derivable,
since there's no source code to author them in).

### 3.1 perm_class → default permission matrix

| perm_class    | owner | admin | member | viewer | meaning |
|---------------|-------|-------|--------|--------|---------|
| standard      | write | write | read   | read   | default editable field |
| collaborative | write | write | write  | read   | member-writable content (case title / description / comments; participants edit) |
| owner_grade   | write | read  | read   | read   | ownership transfer / re-scope / personal default |
| personal      | write | none  | none   | none   | owner-only personal pin (e.g. dashboard.is_favorite) |
| readonly      | read  | read  | read   | read   | computed / system-managed (is_editable=false) |

The `collaborative` class was added during v1 backend implementation (commit fbbb7cf, 2026-05-31) to cover member-writable case content that the original 4 classes couldn't represent without regressing case-member editing — surfaced by Torv-BE during slice 1 shipment, accepted as-named.

### 3.2 Override layering

- **Builtin types** set `perm_class` explicitly per field — migrated from
  today's hand-authored `default_registry()`.
- **Custom types**: every field defaults to `perm_class: "standard"`;
  admin tunes per cell via the EXISTING `PUT /api/admin/fields` (the
  `field_permissions` override table layers ON TOP of the
  perm_class-derived default — unchanged storage, sparse).
- **Served perms** = perm_class default ⊕ field_permissions overrides
  (the existing merge in `/admin/fields`, reused — no new perm store).
- The resolved per-role cells (`owner` / `admin` / `member` / `viewer`)
  are stamped onto each FieldDef in the `/admin/types` response so the
  FE gets render metadata + live perms in one fetch (§4.2).

### 3.3 Why this is disposability-true

Hand-authored per-instance defaults can't extend to types that don't
exist yet. `perm_class` lets a customer create a custom object whose
permissions resolve automatically: their fields default to "standard";
they tune anything sensitive to "owner_grade" or "personal" via the
existing Fields tab UI. Zero source-code defaults to author per custom
type.

## 4. Storage Contract

Backend OWNS `data_type` — it's the STORAGE + write-validation contract.
The backend stays authoritative on data integrity; the FE owns nothing
here (§5 covers presentation, which is opaque to backend).

### 4.1 GET /api/admin/types

```
GET /api/admin/types          → { types: TypeDefinition[] }
GET /api/admin/types/:type    → TypeDefinition
```

- **Gated** `is_platform_admin` (same as `/admin/fields`).
- Each TypeDefinition carries identity + fields[] + relationships[] +
  ui_hints.
- Each `fields[]` entry is a FieldDef PLUS the resolved per-role cells
  (owner / admin / member / viewer = perm_class-derived ⊕ overrides per §3.2).
- Source: builtin types from the expanded `field_perms` registry
  (`field_perms.rs` gains `data_type` / `editor` / `options` / `perm_class`
  / `rel` per field); custom types from a future type-registry table
  (entities-backed). **Both traverse the SAME serialization path** per
  Em Q5 — built-in types are "built-in custom objects" with a single
  code path.

### 4.2 data_type write-validation

The backend OWNS `data_type` and enforces it on every write. The
following table is the validation contract — any PATCH/PUT that
violates it returns `400` (or `404` for a missing rid):

| data_type | write validation (else 400, or 404 for a missing rid) |
|-----------|-------------------------------------------------------|
| string    | text (optional max-len) |
| int       | parses as i64 |
| float     | parses as f64 |
| boolean   | true / false |
| enum      | value ∈ options[] |
| datetime  | parses ISO-8601 |
| rid       | referenced entity exists (cross-type) |
| markdown  | text, stored raw |
| json      | valid JSON |

This split (backend owns `data_type`; FE owns `editor` per §5) is what
keeps the backend authoritative on data integrity while the FE owns
rendering — custom-object writes can't corrupt the DB.

## 5. Presentation Contract

FE OWNS rendering. The backend's `TypeDefinition.fields[].editor` string
is OPAQUE to the backend — it's served verbatim and never validated
against an FE-known list (validating editor IDs backend-side would
couple `/admin/types` to the FE editor inventory and break the
"customer ships a custom editor with no backend deploy" property).

### 5.1 Editor as opaque + FE fallback

- Backend stores + serves `editor` as an opaque string.
- FE's `editor-registry` has a universal fallback to `"text"` — when
  `cell-editor.js` looks up an editor by ID and gets nothing, it
  dispatches to the text editor. The cell stays editable, the PATCH
  still fires, the worst case is "no fancy widget."
- **Custom-editor consequence**: a customer ships a new editor by
  (a) adding `frontend/scripts/framework/editor-<id>.js` and
  (b) configuring their `TypeDefinition.fields[].editor: "<id>"`.
  No backend deploy needed. Disposability-true.

### 5.2 The editor-registry pattern

Each editor lives in its own framework module, registered into a
central registry on import:

```
frontend/scripts/framework/
  cell-editor.js              ← the orchestrator (decorate / save / undo)
  editor-registry.js          ← shared Map<editorId, EditorImpl>
                                + register(impl) / lookup(id, fallback) helpers
  editor-text.js              ← contenteditable, registers "text"
  editor-chip-enum.js         ← <select> swap, registers "chip-enum"
  editor-entity-picker.js     ← search-+-pick, registers "entity-picker"
  // future / customer editors land as new files. Zero edits to any
  // existing module to add an editor.
```

Each editor module exports a minimal interface:

```ts
interface EditorImpl {
  id:        string;                                    // "chip-enum"
  buildOn:   (td: HTMLElement, ctx: EditorContext) => void;  // build editing element on edit-mode start
  buildOff:  (td: HTMLElement, ctx: EditorContext) => void;  // tear down + restore display
  readValue: (td: HTMLElement) => string | unknown;          // read edited value (called by save)
}
```

### 5.3 v1 editor inventory

Three editors land at v1 to preserve current usage:

| Editor module               | Registers as     | Covers |
|-----------------------------|------------------|--------|
| `editor-text.js`            | `"text"`         | Plain contenteditable + `data-full` / `data-prefix` / `data-trunc` render rules. Users `display_name` / `email` / `handle`, Cases `title` / `description`, etc. |
| `editor-chip-enum.js`       | `"chip-enum"`    | `<select>` swap. Users `plan` / `role` (Platform), Cases `type` / `status` / `priority`, Teams `kind`. |
| `editor-entity-picker.js`   | `"entity-picker"`| Search + pick (rid resolution). Memberships modal `scope_id` picker. |

`"text"` is also the universal fallback per §5.1 — guaranteed to
exist for every framework consumer.

v2 editors (datetime, markdown, number, etc.) land as separate child
cases when a TypeDefinition's `data_type` actually surfaces them.

## 6. Acceptance test

The disposability principle made concrete: a "fake" custom-object
TypeDefinition the implementation has never seen must work end-to-end
with ZERO source changes.

### 6.1 Test TypeDefinition

```ts
const fakeListing: TypeDefinition = {
  type:                "real_estate_listing",
  rid_prefix:          "RES_",
  display_name:        "Real Estate Listing",
  display_name_plural: "Real Estate Listings",
  is_builtin:          false,
  fields: [
    { key: "address",      label: "Address",      data_type: "string",   editable: true, editor: "text",       perm_class: "standard" },
    { key: "list_price",   label: "List price",   data_type: "int",      editable: true, editor: "text",       perm_class: "standard" },
    { key: "status",       label: "Status",       data_type: "enum",
      options: ["active", "pending", "sold"],     editable: true, editor: "chip-enum",  perm_class: "standard", render: "stageChip" },
    { key: "listed_at",    label: "Listed at",    data_type: "datetime", editable: false, perm_class: "readonly" },
    { key: "agent_id",     label: "Agent",        data_type: "rid",      editable: true, editor: "entity-picker",
      rel: { type: "user", multi: false }, perm_class: "owner_grade" },
    { key: "description",  label: "Description",  data_type: "markdown", editable: true, editor: "text",
      data_full: true, data_trunc: 120, perm_class: "standard" },
  ],
};
```

### 6.2 What must work without any source change

- The cell-editor framework decorates editable cells for caller role
  permissions resolved by §3.
- Editors dispatch correctly: address/list_price/description → `text`,
  status → `chip-enum` with options, agent_id → `entity-picker` over
  the `user` type.
- `data_full` + `data_trunc` render rules on `description` survive
  edit-mode toggle.
- Writes to `list_price` with `"abc"` → 400 per §4.2; writes to
  `status` with `"draft"` → 400 (not in options); writes to
  `agent_id` with a non-existent rid → 404.
- `listed_at` is read-only at every tier per `perm_class: "readonly"`.
- `agent_id` is owner-write only per `perm_class: "owner_grade"`.

If any of those require a source change to make work, the
implementation has baked in a built-in-type assumption — the spec is
not yet satisfied.

## 7. Implementation sequence

### 7.1 Backend lane (Torv-BE)

1. `GET /api/admin/types` + `GET /api/admin/types/:type` endpoint per §4.1.
2. `field_perms.rs` registry gains `data_type` / `editor` / `options` /
   `perm_class` / `rel` per field (extends the existing FieldRow shape).
3. `default_registry()` rewrite: replace hand-authored per-(object,field)
   defaults with `perm_class` annotations + the generic derivation per §3.1.
4. `data_type` write-validation per §4.2 at every PATCH/PUT site
   (admin/fields PUT today; future generic type-PATCH endpoint).
5. Backfill the 5 builtin types as TypeDefinitions served through the
   same `/types` endpoint (Q5).

Tracked: a child of CAS_0FBF301F per [[refactor-decompose]].

### 7.2 FE lane (Torv-FE)

1. `frontend/scripts/framework/type-registry.js` — fetches `/admin/types`
   once at cold-start, caches in memory, exposes `getType(typeId)` /
   `getField(typeId, fieldKey)` accessors.
2. `frontend/scripts/framework/editor-registry.js` — the shared Map +
   `register()` / `lookup()` helpers per §5.2.
3. `frontend/scripts/framework/editor-text.js` + `editor-chip-enum.js` +
   `editor-entity-picker.js` — the v1 editor inventory per §5.3,
   factored out of `home.js`.
4. `frontend/scripts/framework/cell-editor.js` (CAS_8A210C7A resumes
   here): the orchestrator that consumes a TypeDefinition + dispatches
   to the editor-registry.
5. Acceptance smoke: feed the §6 fake `RealEstateListing` TypeDefinition
   into a minimal redtable test surface, verify §6.2 end-to-end.

Tracked: CAS_8A210C7A (cell-editor) + child cases per framework.

### 7.3 Coordination

- Spec v1 lands as this doc.
- Either lane can ship its slices in parallel — they meet at the
  TypeDefinition wire shape (§2) which this doc fixes.
- The acceptance test (§6) is the convergence point: both lanes
  smoke-feed it once their slices are in.

## 8. v2 — field validation (shipped 2026-06-01, CAS_C7AEBE83)

v1 §4.2 validates a value against its `data_type` (codec). v2 adds **field-level
rules** + a **two-tier model** that catches not just the edge cases we found in
adversarial testing but the ones we haven't — the architecture is the defense,
not an enumeration. It mirrors the CSV cleanness scorer's `value_quality ×
structural` model (`data/src/structure.rs`) at the field level.

### 8.1 Two tiers

- **Tier 1 — hard contract gate** → `errors[]`; non-empty ⇒ **400**. Gate 1a:
  the `data_type` codec (short-circuits). Gate 1b: each `ValidateRule`
  (collect-all). 400 body: `{error, field, rule_code, message}`.
- **Tier 2 — soft suspicion layer** → `warnings[]` + `confidence`; never blocks.
  Open `FieldDetector` registry runs on every shape-valid value even when Tier 1
  passes. Seeds: `coercion_loss` (raw-vs-parsed — `"07920"` typed int loses its
  zero) and `drift` (date in a string field). **This tier absorbs unknown
  cases** — a general detector, not a named rule, catches the smell. Warnings +
  `confidence` ride the 200 response (the `/api/demo/parse` `structure.reasons`
  pattern).

### 8.2 ValidateRule (extends §2 FieldDef)

`FieldDef.validate: ValidateRule[]`, each `{kind, params, code, message}`. `kind`
is an **OPEN string** resolved against a rule registry (never an enum — same
contract as `data_type`); `params` is **nested** (not flattened) so a param can't
collide with `kind`/`code`/`message`. Builtin kinds:

| kind | params | rejects when |
|------|--------|--------------|
| `range` | `min?`, `max?` | numeric value outside bounds |
| `length` | `min?`, `max?` | Unicode char count outside bounds |
| `enum_subset` | `values: [..]` | value ∉ values |
| `expression` | `expr: "<dsl>"` | the cross-field DSL is false (§9.3) |
| `decimal` | `scale?`, `currency?` | more fractional digits than `scale` (loss of precision; XOF `scale:0` rejects `1.5`) — the reborn money contract, an open param not a fixed type |
| `pattern` | `pattern: "<regex>"` | string value fails the regex (RE2 linear-time, no ReDoS; length + compiled-size capped) |

### 8.3 The expression DSL (hand-rolled, sandboxed)

A tiny boolean DSL: `==,!=,<,<=,>,>=,&&,||,!`, field refs, literals (number /
'string' / true / false / null). No functions, no arithmetic, no loops.
Bounded-by-construction (`MAX_EXPR_DEPTH=32`, `MAX_TOKENS=256` enforced at parse)
so a `((((…))))` bomb fails at parse — the `codec_avro` recursion-DoS lesson.
Deterministic (no I/O / clock / RNG). **Locked null/type truth table:**

- `x == null` / `x != null` test null explicitly (the only truthy null).
- ordered compare (`< <= > >=`) with a null operand ⇒ **false**.
- `==`/`!=`: coerce numeric then string; null ≠ non-null.
- ordered compare across incompatible types ⇒ **false** (a type-mismatch *smell*
  is a Tier-2 detector's job, not a hard 400).

### 8.4 The regression gate

`tools/wasm-bench/validate-calibration.py` — the field-level twin of
`score-calibration.py`. Two suites under one gate: **CORRECTNESS** (hard
bands — a value passes or rejects with a specific `rule_code`) + **TASTE** (Tier-2
warnings, Copilot/Gemini-authored). A future challenge is a new labelled row, not
a redesign. Target: `POST /api/demo/validate`. Disposability bar met:
`RealEstateListing` + `BankingAccount` (banking) pass with zero framework source
change — only their `validate[]` rules differ.

### 8.5 Locked decisions

- Two-tier (gate + suspicion), not flat binary reject — Em 2026-06-01.
- Hand-rolled DSL + i128/string money compare, **zero new crates** (no CEL, no
  `rust_decimal`) — Em 2026-06-01.
- Nested `params`, open `kind` string, `FieldOutcome` (not `Result<(),E>`).
- Builtin per-resource PATCH handlers NOT retrofitted (the pipeline proves on the
  future custom-object PATCH endpoint; retrofits are opt-in, additive).

### 8.6 Code

`shared/type_def.rs` (`ValidateRule`), `api/validate_rules.rs` (pipeline + rule +
detector registries), `api/validate_expr.rs` (DSL), `api/routes/demo.rs`
(`/validate`). Each has its atomic doc under `docs/internal/code/backend/...`.

## 9. Cross-references

- [[framework-layer]] — the parent epic this case is sibling-of.
- [[disposability-design-principle]] — the keystone memory that drove
  the spec.
- [[team-plan-over-personal-queue]] — process discipline applied during
  the co-author convergence.
- [Entity-Membership model](rbac/entity-membership-model.md) — the
  resolver / membership edge that `rel` fields point through.
- [Membership](rbac/membership.md) — the polymorphic membership edge
  TypeDefinition relationships ride over.
- [Field RBAC catalog](rbac/index.md) — the field-permissions matrix
  that `perm_class` derives + overrides layer on top of.

— Torv-FE writes; Torv-BE provides §3 + §4 tables verbatim; Em approves
Q1 (backend source-of-truth) + Q4 (user-chosen+auto-gen rid_prefix) +
Q5 (builtin-as-TypeDefinitions). Spec v1 ships 2026-05-31.
