# Rust idioms behind the registry decisions

Each registry design choice rests on a specific Rust language feature. These are the Rust Book
(https://doc.rust-lang.org/stable/book/) chapters to consult when a choice is in question — not as
generic Rust review, but tied to the exact decision the registry forces. The compiler source
(`references/rustc-registry-patterns.md`) is the *applied* form; the Book is the *why it's sound*.

## Open vs closed — the central decision

- **Ch. 17 "Trait Objects" + Ch. 18 (patterns) + Ch. 20 "Advanced Traits"** → `dyn Trait` / function-pointer
  registries vs `enum match`. The whole registry idea is "prefer an open set of registered impls
  (`HashMap<key, Box<dyn …>>` / a `Providers`-style struct of `fn`s) over an exhaustive `match` that must
  be edited for every new case." Read this when deciding *how* a capability registers (trait object,
  function pointer, or data row). RedPash's `validate_rules::RuleRegistry` and `codec_registry` are this
  pattern; `register_type` extends it.
- **Ch. 6 "Enums and Pattern Matching"** → when the set is a true, bounded invariant, an `enum` with an
  exhaustive `match` is *correct* and safer (the compiler forces you to handle every case). The RBAC
  `Role` tier is the example: four tiers are a fixed axis, so the enum is right. Use this chapter to
  justify keeping something closed — not everything should be a registry.

## Making the registry sound

- **Ch. 10 "Generic Types, Traits, and Lifetimes"** → the generic `resource<T>(type)` / `generic_resource`
  handler. Bounded generics + trait bounds are how one handler serves every type without per-type code.
- **Ch. 9 "Error Handling" (`Result`, `?`)** → the `AppError` gate pattern. Every registry lookup,
  validation, and RBAC check returns `Result`; the `?` operator threads failures to one fail-closed
  response. The validator's `RuleCheck { Pass, Fail, Malformed }` (distinguishing a *value* failure from
  a *rule-authoring* failure) is this discipline applied — model new registry checks the same way.
- **Ch. 15 "Smart Pointers" (`Rc`/`Arc`, `Deref`)** + **Ch. 16 "Concurrency"** → the `Arc<TypeDefCache>`
  on `AppState` (cheap clones, shared read) and the read-guard-off-`.await` rule. rustc's `Interned`
  derefs to its inner value (Ch. 15's `Deref`) — the same ergonomics for a cached registry row.
- **Ch. 7 "Managing Growing Projects" (modules, paths, `pub use`)** → crate/module layout. The registry
  lives in one module re-exported from the crate root (mirror how `rustc_middle` re-exports `Providers`);
  consumers import the registry, never reach across modules into its internals.

## The rule of thumb

When you reach for a closed `match`/`enum`/`CHECK` in *framework* code, stop and ask the Ch.17-vs-Ch.6
question: **is this a bounded invariant, or an open set that grows per vertical?** Open set → registry
(trait objects / data rows). Bounded invariant → enum. Getting this one call right is most of the design.
