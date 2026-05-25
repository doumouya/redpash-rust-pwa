---
title: JS ↔ Rust boundary
section: Internal
order: 0
last modified date: 2026-05-25
---

# JS ↔ Rust boundary

The responsibility contract between the two halves of RedPash — what JS
owns, what Rust owns, and where they are allowed to meet. **Locked
2026-05-25 by Em.** Written because the JS and Rust refactor audits
both flagged the same blurred area (filter / sort / step): the audits
map each side's *internals*; this doc maps the *seam*. The rule and
the seam rulings below are now binding on new work; the audit triad
(`js-audit` + `rs-audit` + `crossing-audit`) is the linter that holds
the code to them.

## The rule

**Rust owns the data. JS owns the pixels.**

- **Rust** — anything that transforms, computes over, or persists the
  actual data: parse, encoding, the cleaner steps, type inference,
  dedup, joins, aggregation, cleanness scoring, filter, sort, export —
  plus HTTP, DB, auth. The `data` crate's charter already states it:
  *"anything that touches a row or a byte."* It has zero HTTP
  dependencies — the boundary is compiler-enforced.
- **JS** — anything that draws, lays out, or responds to a human:
  rendering, the redtable surface, panels and toolbars, routing,
  interaction, and building the ECharts option from data Rust supplied.
  *"Anything that touches a pixel."*

If a piece of logic transforms data → it is Rust, however convenient it
would be to do in JS. If it arranges pixels → it is JS, however
data-aware it looks.

## Where they cross

JS and Rust meet at exactly **two** kinds of endpoint — and nowhere
else:

1. **HTTP API routes** — `/api/…`. JS issues them; Rust serves them.
2. **`shared`-crate DTOs** — the request / response shapes. The
   `shared` crate *is* the contract: the single vocabulary both sides
   compile against.

Anything that crosses, crosses there. A piece of data logic living in
JS, or presentation logic living in Rust, is a boundary violation — a
crossing that bypasses the two legal endpoints.

This makes the crossing **auditable**: cross-reference the JS side's
`/api/…` calls against the Rust route table and the `shared` DTOs. A
call with no matching route, a DTO field written by one side and read
by neither — these are dangling endpoints, the exact equivalent of an
orphan CSS class. (See *Enforcement*.)

## Runtime is a free variable — the WASM caveat

"Rust owns the data" is about *concern*, not *location*. The
conventional split assumes Rust = server, JS = browser. Drop that
assumption.

The `data` crate is HTTP-agnostic, pure compute on DataFrames — it is
**portable by construction**. Its transform core (filter, sort, the
cleaner steps, scoring) is a credible WebAssembly target: compiled to
WASM it would run *in the browser*, on already-loaded data, at Rust
speed with zero network round-trip — the **identical code** that runs
natively on the server for the full dataset.

This is a *direction*, not a sprint (WASM-Polars is heavy; ingestion —
encoding sniff, xlsx decode — likely stays server-side). But it has a
binding consequence **today**:

> **There is one filter, one sort, one step engine — written once, in
> Rust. Never build a data engine in JS.**

The redtable prototype's client-side JS filter / sort is demo
scaffolding, not something to harden. Keep the `data` crate pristine —
no HTTP, no DB creep — so the WASM door stays open. (A client-side data
operation in JS would also simply not scale: it sees only the loaded
page, not the dataset.)

## Seam rulings

The three blurred spots both audits flagged, ruled:

| Seam | Ruling |
|------|--------|
| **Filter + sort** | **Rust.** They order / transform data. The `/page` endpoint (`sort` / `filters` params) is canonical. The redtable's controls send query params; they do not filter client-side. |
| **Edit + delete (cells / rows)** | **Rust**, as a cleaning **step** — it mutates data, so it is recorded in `project_steps` history like any other transform. |
| **`render.rs`** | **Delete it.** A fossil of an abandoned "render HTML in Rust" path. Rendering is JS — decided. Drop the 2-line stub + its 4 unused workspace deps (`maud`, `pulldown-cmark`, `syntect`, `gray_matter`). |

## Naming — the shared vocabulary

A concern with both a JS half and a Rust half is **one concern** and
carries **one name** on both sides. The `shared` crate is the anchor —
its DTO type names *are* the canonical concern vocabulary; the
complementary JS module and Rust module both adopt the name.

- the filter concern → `filter.rs`, `filter.js`, the `Filter` DTO.
- the steps concern → `steps.rs`, `steps.js`.

Two payoffs: the **file tree becomes the boundary map** — a name in
both `data/` and `scripts/` is a flagged seam, a name in one is clean —
and it is self-correcting. The two filter-predicate builders the Rust
audit found hid behind `filter_expr` and `build_filter_predicate`;
named plainly `filter` on both sides, the duplicate would have been
obvious the day it was written. This is the `rp → rp-rt → rp-rtp → 8
names` cleanup, applied across the language line.

## Enforcement

The doc is the spec; the audit tools are the linter that holds the code
to it:

- **`js-audit`** (built) — JS-internal: files, dead code, duplicate
  symbols.
- **`rs-audit`** (to build) — the Rust-internal counterpart, and
  crucially it must **emit the Rust route table + the `shared` DTO
  surface**.
- **the crossing diff** — `js-audit`'s `/api/…` call list diffed
  against `rs-audit`'s route + DTO surface. Every dangling endpoint, on
  either side, falls straight out.

`js-audit` + `rs-audit` + the crossing diff = the full boundary
picture — the JS↔Rust equivalent of what css-audit / html-audit do for
classes and ids.

## Status

**Locked 2026-05-25 by Em.** The rule and the three seam rulings are
binding on new work. Woz owns the frontend side of every seam ruling;
Torv owns `rs-audit` + the crossing diff. Open carry-over from the
draft: the redtable prototype's client-side JS filter / sort is demo
scaffolding to be replaced by the `/page` endpoint, not hardened; and
`render.rs` + its four unused workspace deps (`maud`, `pulldown-cmark`,
`syntect`, `gray_matter`) are scheduled for deletion.

— Gus (authored 2026-05-22), locked by Em 2026-05-25
