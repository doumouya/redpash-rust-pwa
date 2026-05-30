---
title: tools/stack-version.sh
source: ../../../../../tools/stack-version.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# stack-version.sh

## Purpose

Prints installed versions of every runtime + dependency the project
relies on (Rust, cargo, sqlx-cli, Postgres, Node, wasm-bindgen,
wasm-opt, polars, axum, …). The *read-side* of the version contract —
[`install-stack.sh`](install-stack.md) writes; this script reads. The
seed for the planned dep-audit tool documented at
[`specs/dep-audit-design.md`](../../../specs/dep-audit-design.md).

## Public surface

- `sh tools/stack-version.sh` — table of probe-name + observed-version + expected-version.
- Returns non-zero if any version diverges from the project pin.

## Drift-prone areas

- **Version-probe catalog** (declared as `bash` associative arrays —
  hence the `exec bash` guard at the top) needs explicit additions for
  new deps.
- **Expected-version source** lives inline in this script; the
  dep-audit tool the design spec proposes will replace this with a
  pinned manifest in the repo.

## Related

- [Sibling: install-stack.sh](install-stack.md)
- [Spec: dep-audit-design](../../../specs/dep-audit-design.md) — the planned audit replaces this script's manual catalog
