# CASE — Bug: build-fe ships frontend/wasm-src/ (≈381 MiB of Rust artifacts) into frontend-dist/

> **Filed on-disk** (the cases MCP backend is down — same as docs-reorg.md). Promote to a
> DB case via `case_create` when it's back. Filed 2026-06-16.

- **Type:** bug &nbsp;·&nbsp; **Priority:** medium &nbsp;·&nbsp; **Status:** backlog &nbsp;·&nbsp; **Source:** internal

## Why

`tools/build-fe.mjs` copies the whole `frontend/` tree into `frontend-dist/`, including
`frontend/wasm-src/` — the Rust SOURCE + its `target/` build artifacts for the wasm modules
(gluesql, data). That dir is ≈381 MiB, so the dist ballooned from **75 files / 23 MiB** (early
this session) to **1188 files / 402 MiB**. The compiled, shippable wasm is separate and fine:
`frontend-dist/wasm/` is 26 MiB (`data_bg` 23M + `gluesql` 2.8M). The 381 MiB of `wasm-src/` is
build INPUT — never served.

`build-fe` runs in `tools/ci.sh`, which gates the lean→prerelease/main promotion — so a 17×
bloated dist (carrying raw Rust source + `target/`) would ship on promotion. Caught during the
Cases rail verification (2026-06-16).

## Acceptance criteria

1. `build-fe` **excludes `wasm-src/`** from the dist copy (ignore list / glob), OR `wasm-src/`
   moves out of the `frontend/` copy root so it's never swept in.
2. `frontend-dist/` returns to the shippable footprint (~26 MiB wasm + the hashed JS/CSS bundle);
   no Rust source or `target/` artifacts present.
3. Regression guard — `build-fe` asserts no `wasm-src/`/`target/` in the output (or a dist
   size/file-count sanity check), failing the gate, not the user.
4. `sh tools/build-fe.sh` re-run confirms the slim dist AND the module-graph self-check still passes.

## Lanes / flow

Build-tooling lane (`tools/build-fe.mjs`). Diagnosed by Fable during the Cases rail slice; the FIX
is PARKED per Em ("wait — doc first"). Suggested next step: `/feature` on this case, or assign.
