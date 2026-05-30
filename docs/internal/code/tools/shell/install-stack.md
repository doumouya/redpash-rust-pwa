---
title: tools/install-stack.sh
source: ../../../../../tools/install-stack.sh
owner: Gus
section: Internal · Code · Tools · shell
last modified date: 2026-05-30
---

# install-stack.sh

## Purpose

Installs the runtime stack a fresh host needs to run RedPash — Rust
toolchain (via rustup), Postgres, Node, wasm-bindgen, wasm-opt. Sibling
of [`stack-version.sh`](stack-version.md): that script probes installed
versions; this one installs the versions the project is pinned against.

## Public surface

- `sh tools/install-stack.sh` — installs everything in dependency order.
- Idempotent: skips already-installed components.
- Logs version of each thing installed.

## Drift-prone areas

- **Version pins** must match the project's `rust-toolchain.toml`,
  `Cargo.toml`, `package.json`. `stack-version.sh` is the read-side
  source of truth — this script writes to match it.
- **Distro support** is implicit (Debian/Ubuntu-flavoured assumed); a
  fresh distro needs branches added.

## Related

- [Sibling: stack-version.sh](stack-version.md)
- [Spec: dep-audit-design](../../../specs/dep-audit-design.md)
