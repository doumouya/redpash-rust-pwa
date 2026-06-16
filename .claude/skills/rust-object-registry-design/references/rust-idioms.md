# Rust idioms behind the registry decisions

Each registry design choice rests on a specific Rust language feature. These are the Rust Book
(https://doc.rust-lang.org/stable/book/) chapters to consult when a choice is in question — not as
generic Rust review, but tied to the exact decision the registry forces. The compiler source
(`references/rustc-registry-patterns.md`) is the *applied* form; the Book is the *why it's sound*.

## Open vs closed — the central decision

- **Ch. 17 "Trait Objects" + Ch. 18 (patterns) + Ch. 20 "Advanced Traits"** → `dyn Trait` / function-pointer
  registries vs `enum match`. The whole registry idea is "prefer an open set of registered impls (a data
  table, a `HashMap<key, …>`) over an exhaustive `match` that must be edited for every new case." Read this
  when deciding *how* a capability registers (data row, trait object, or function pointer). In lean, the
  object registry IS this pattern in DATA form: `type_definitions` + `type_fields` rows drive the generic
  `builtin_list`/`builtin_view` + the `registry_display_fields` derive in `objects.rs` — a new type or field
  is a row, not a `match` arm. (See `docs/decisions/day-one.md`.)
- **Ch. 6 "Enums and Pattern Matching"** → when the set is a true, bounded invariant, an `enum` with an
  exhaustive `match` is *correct* and safer (the compiler forces you to handle every case). lean's RBAC
  `Role` tier (`rbac.rs`) is the example: a fixed axis, so the enum is right. The flip side done as data:
  the cases WORKFLOW (`cases.rs`) keeps the status transition map as a registry (workflows-as-data), NOT a
  hardcoded match — so a new status/transition is a data edit. Use this chapter to justify keeping something
  closed — not everything should be a registry.

## Making the registry sound

- **Ch. 10 "Generic Types, Traits, and Lifetimes"** → the generic builtin handler in `objects.rs` serves
  EVERY org-builtin type (user/company/team/file/project/case) without per-type code; `org_builtin(type)`
  + a shared reach predicate (`CASE_REACH`, the others) parameterize it. Bounded generics + shared SQL are
  how one handler serves every type.
- **Ch. 9 "Error Handling" (`Result`, `?`)** → lean's `AppError` gate pattern. Every registry lookup, RBAC
  check (`rbac::require_action` → leak-free 404), and the cases workflow ENFORCE (`AppError::unprocessable`
  → 422) returns `Result`; `?` threads failures to one fail-closed response. Distinguish a *value* failure
  (400 `bad_request`) from a *domain-rule* failure (422 `unprocessable` — e.g. an illegal status
  transition) — model new registry checks the same way.
- **Ch. 15 "Smart Pointers" (`Rc`/`Arc`, `Deref`)** + **Ch. 16 "Concurrency"** → the `Arc<TypeDefCache>` on
  `AppState` (`type_cache.rs`: cheap clones, shared read; the RBAC with-clause is generated once from
  `type_definitions.scope_parents`). rustc's `Interned` derefs to its inner value (Ch. 15's `Deref`) — the
  same ergonomics for a cached registry row.
- **Ch. 7 "Managing Growing Projects" (modules, paths, `pub use`)** → the registry lives in `objects.rs`
  + `types.rs` + `type_cache.rs`; the SEALED write path (`pipeline.rs` keeps `insert_file` / `insert_attachment`
  module-private — no public db inserter, the day-one seal). Consumers call the registry, never reach across
  modules into its internals.

## The rule of thumb

When you reach for a closed `match` / `enum` / `CHECK` in *framework* code, stop and ask the
Ch.17-vs-Ch.6 question: **is this a bounded invariant, or an open set that grows per vertical?** Open set
→ registry (data rows / the generic handler). Bounded invariant → enum. Getting this one call right is
most of the design. (lean's live doc⇄code map of where the registry lives: `docs/REDMAP.md`.)
