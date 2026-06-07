---
title: backend/crates/api/src/connectors_core.rs
source: ../../../../../backend/crates/api/src/connectors_core.rs
owner: Torv
section: Internal · Code · backend · api
last modified date: 2026-06-07
---

# connectors_core.rs

## Purpose

The **shared connector core** — the one security-load-bearing admission decision a
connector makes about its source target, lifted out of the per-loader files so
[mysql_loader](mysql_loader.md) + [postgres_loader](postgres_loader.md) (+ future
engines) consume **one reviewed copy** instead of each carrying a divergence-prone
duplicate. Co-owned with the SQL-connector lane: the shapes mirror `mysql_loader`'s
Slice-A `host_tls_gate` / `parse_ssl_mode`, made **engine-agnostic** so each loader
maps the core `SslMode` to its own sqlx type (`MySqlSslMode` / `PgSslMode`).

This is the structural answer to *"both Torvs editing the same connector security
logic"* — the gate lives here once; the loaders are thin consumers.

## Public surface

- `enum SslMode { Disabled, Preferred, Required, VerifyCa, VerifyIdentity }` — the
  engine-agnostic TLS ladder. `SslMode::encrypts()` is true only for
  `Required` / `VerifyCa` / `VerifyIdentity` (the modes that **guarantee** an encrypted
  wire); `Disabled` / `Preferred` may transport plaintext (`Preferred` = try-TLS-then-
  silently-fall-back), so they are **loopback-only**.
- `parse_ssl_mode(&str) -> SslMode` — config string → mode. **Anything unknown →
  `Required`** (the safe encrypting default), so a typo can never silently downgrade a
  remote connection to plaintext.
- `is_loopback_host(&str) -> bool` — `localhost` + any loopback **IP literal**
  (127.0.0.0/8, ::1). Rejects hostnames like `127.evil.com` that a `starts_with("127.")`
  check would wave through (SSRF). Loopback may use **any** ssl_mode (plaintext never
  leaves the box).
- `is_blocked_host(&str) -> bool` — link-local / cloud-metadata IPs (IPv4
  `169.254.0.0/16`, incl. the `169.254.169.254` metadata endpoint; IPv6 `fe80::/10`).
  Never a real DB host, a classic SSRF pivot — refused even over TLS.
- `host_gate(host, ssl_mode) -> Result<(), String>` — **the gate.** Two rules:
  1. a **blocked** (link-local / metadata) host is refused **always**, even over TLS;
  2. a **remote** host must **encrypt** (`ssl_mode.encrypts()`) — `Disabled` / `Preferred`
     stay loopback-only. Returns an engine-agnostic message; the caller wraps it
     (`AppError::bad_request` / `anyhow`).

Each loader's `from_connection` reads the `ssl_mode` config key →
`parse_ssl_mode` (default: loopback→`Preferred`, remote→`Required`), calls
`host_gate`, then maps `SslMode` → its sqlx enum and sets `ssl_root_cert` for the
`Verify*` modes.

## Drift-prone areas

- **`encrypts()` is the plaintext firewall.** It must list exactly the modes that
  guarantee encryption. Adding a mode (e.g. a future `RequireNoVerify`) without deciding
  its `encrypts()` answer is how a remote plaintext path sneaks back in.
- **Unknown `ssl_mode` MUST fail safe to `Required`**, never `Disabled`/`Preferred` — the
  no-silent-downgrade invariant. The `_ => Required` arm is load-bearing.
- **The gate parses the host string; sqlx re-parses it independently.** They must agree on
  what a string *is* (loopback vs remote vs blocked). When you touch host classification,
  keep it to what `std::net::IpAddr` parsing yields, the same surface sqlx sees.
- **Host classification is IP-literal only** — hostnames pass `is_blocked_host`
  (resolution-time DNS-rebinding is a v2 concern; the v1 metadata vector is the IP literal).
  The IP-literal classification itself must be airtight (canonical forms, IPv4-mapped IPv6).

## Related

- [mysql_loader.md](mysql_loader.md) / [postgres_loader.md](postgres_loader.md) — the two
  consumers; each maps `SslMode` to its sqlx enum.
- [routes/connectors.rs](routes/connectors.md) — the `kind` dispatch the loader registry
  will eventually fold into the core.
- Plan: `~/.claude/plans/yes-assess-current-situation-cozy-flame.md`; memory
  [[connector-through-framework]] / [[build-for-unknown-failures]].
