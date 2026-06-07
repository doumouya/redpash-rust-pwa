---
title: 0012 — connector host gate misses IPv6-wrapper / zone-id / unspecified encodings of metadata IP (SSRF)
date: 2026-06-07
case: CAS_A0BDFCED37AC47579F18AEE45A161A37
area: backend/connectors_core (shared host/TLS gate)
---

# 0012 — connector gate SSRF via IP-literal encodings

## Symptom

The connector host admission gate (`is_blocked_host`) refused the cloud-metadata
endpoint `169.254.169.254` in its canonical IPv4 form, but **admitted the same
endpoint** written in any IPv6-wrapper / zoned / dotted encoding — even over
`ssl_mode=required`. An authenticated user with ≥Member write-reach on a project
could create a connector pointed at `::ffff:169.254.169.254` (or `0.0.0.0`, etc.)
and the loader would `connect()` to the metadata service the policy says is refused
**always**.

## Root cause

`is_blocked_host` classified on the *textual* form, not the address the kernel
routes to. Its IPv6 arm tested only `(segments()[0] & 0xffc0) == 0xfe80` (fe80::/10):

- An **IPv4-mapped** (`::ffff:169.254.169.254`), **IPv4-compatible**
  (`::169.254.169.254`), or **NAT64** (`64:ff9b::169.254.169.254`) literal has
  `segments()[0] == 0x0000`, so the fe80 mask is false — yet Linux routes
  `connect()` to the embedded IPv4 `169.254.169.254`.
- A **zone id** (`fe80::1%eth0`) or **trailing dot** (`169.254.169.254.`) makes
  `std::net::IpAddr::parse` return `Err`, so the gate fell through to the
  "treat as hostname, pass" arm — but `getaddrinfo` (what sqlx resolves through)
  accepts both and resolves to the blocked target. A gate-vs-resolver TOCTOU.
- The **unspecified** address (`0.0.0.0` / `::`) passed both the block and loopback
  checks, though `connect(0.0.0.0)` reaches the local host plane.

Found by an adversarial gate-audit **workflow** (3 attack lenses; every finding
ground-truthed by a compiled `rustc` classifier that printed the actual
`parse()` / `to_ipv4()` / `is_link_local()` results) — 12 confirmed, 3 correctly
rejected (numeric/octal localhost forms parse to `Err` → forced TLS, not a leak;
`::ffff:127.0.0.1`-as-remote → forces TLS, not exploitable).

## Fix (shared `connectors_core`, CAS_A0BDFCED)

Classification now runs on the address `connect()` actually reaches:

- `embedded_ipv4(v6)` folds an **IPv4-mapped / IPv4-compatible** (`Ipv6Addr::to_ipv4`)
  and the **NAT64 well-known prefix** `64:ff9b::/96` (RFC 6052) down to the embedded
  IPv4; `is_blocked_host`/`is_loopback_host` then run their `is_link_local` /
  `is_unspecified` / `is_loopback` tests on that canonical v4.
- `ip_literal(host)` strips a trailing FQDN dot and an RFC-4007 `%zone` **before**
  parsing, so a zoned/dotted link-local literal can't slip the `Err`→hostname arm.
- The unspecified address (`0.0.0.0` / `::`) is now blocked.

The gate is the **one shared copy**: `postgres_loader` consumes it, so the Postgres
connector is closed by this change. Pinned by
`blocks_every_ipv6_wrapper_and_encoding_of_metadata`,
`loopback_recognizes_ipv6_wrappers_of_loopback`, and
`gate_refuses_mapped_metadata_even_over_tls` in `connectors_core.rs` (regression
asserts on every confirmed vector).

## Still open — MySQL path

`mysql_loader.rs` carries its **own divergent** `is_blocked_host` (committed
`95d9634`, Slice A) and does **not** yet route through `connectors_core`, so the
MySQL connector keeps the hole. The fix is the migration to the shared core
(delete the four duplicated gate fns; call `connectors_core::{parse_ssl_mode,
host_gate, is_loopback_host}` + a `mysql_ssl_mode` map) — the same shape applied to
`postgres_loader`. Ready-to-apply patch broadcast to the SQL-connector lane; that
lane owns the `mysql_loader` edit. Close this case when the MySQL side lands.

## Verify

`cargo test -p api connectors_core::` (8 tests, incl. the three regression tests
above). The audit workflow's `rustc` classifier can be re-run on any new candidate
vector to ground-truth a future report.
