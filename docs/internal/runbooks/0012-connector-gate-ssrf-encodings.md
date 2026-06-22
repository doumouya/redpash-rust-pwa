# 0012 — connector gate SSRF via IP-literal encodings

The connector host-admission gate refused the cloud-metadata endpoint
`169.254.169.254` in its canonical IPv4 form but **admitted the same endpoint**
written in any IPv6-wrapper / zoned / dotted encoding — a multi-vector SSRF. This
runbook records the root cause (a textual-form classifier vs. the address the
kernel actually routes to) and the fix that classifies on the routed address.

The gate is **LIVE on lean**: every encoding below is handled in
[`connectors_core.rs`](../../../backend/crates/api/src/connectors_core.rs) and
pinned by regression tests. This is the historical reasoning record for a closed
hole, not an open bug.

Source case: `CAS_A0BDFCED37AC47579F18AEE45A161A37`.

## Symptom

The shared host gate (`is_blocked_host`) refused `169.254.169.254` in canonical
IPv4 form but **admitted** the same metadata endpoint written as
`::ffff:169.254.169.254`, `::169.254.169.254`, `64:ff9b::169.254.169.254`,
`fe80::1%eth0`, `169.254.169.254.`, or the unspecified address `0.0.0.0` / `::` —
even over an encrypting `ssl_mode`. A connector configured by a user with write
reach on a project could point the loader at the metadata service the policy says
is refused **always**, and `connect()` would reach it.

## Root cause

`is_blocked_host` classified on the *textual* form, not the address the kernel
routes `connect()` to. Three independent failure modes:

- **IPv6 wrappers fell through the link-local test.** The IPv6 arm tested only
  `(segments()[0] & 0xffc0) == 0xfe80` (fe80::/10). An **IPv4-mapped**
  (`::ffff:169.254.169.254`), **IPv4-compatible** (`::169.254.169.254`), or
  **NAT64** (`64:ff9b::169.254.169.254`, RFC 6052) literal has
  `segments()[0] == 0x0000`, so the fe80 mask is false — yet Linux routes the
  connection to the embedded IPv4 `169.254.169.254`.
- **Zone id / trailing dot made `parse` fail → "treat as hostname, pass".** A
  zone id (`fe80::1%eth0`, RFC 4007) or trailing FQDN dot (`169.254.169.254.`)
  makes `std::net::IpAddr::parse` return `Err`, so the gate fell through to its
  hostname arm — but `getaddrinfo` (what the sqlx resolver goes through) accepts
  both and resolves to the blocked target. A gate-vs-resolver TOCTOU.
- **Unspecified address slipped both checks.** `0.0.0.0` / `::` passed the block
  test and the loopback test, though `connect(0.0.0.0)` reaches the local host
  plane.

Found by an adversarial gate-audit pass over three attack lenses (IPv6 wrappers,
zone-id/dotted parse-failure, unspecified). Every candidate vector was
ground-truthed by a throwaway compiled `rustc` classifier that printed the actual
`parse()` / `to_ipv4()` / `is_link_local()` / `is_unspecified()` result rather
than reasoning about the encoding on paper — 12 confirmed bypasses, 3 correctly
rejected (octal/numeric localhost forms parse to `Err` → forced TLS, not a leak;
`::ffff:127.0.0.1`-as-remote → forces TLS, not exploitable).

## Fix

Classification now runs on the address `connect()` actually reaches. The three
load-bearing helpers in
[`connectors_core.rs`](../../../backend/crates/api/src/connectors_core.rs):

- **`embedded_ipv4(v6)`** folds an **IPv4-mapped / IPv4-compatible**
  (`Ipv6Addr::to_ipv4`) and the **NAT64 well-known prefix** `64:ff9b::/96` down to
  the embedded IPv4. `is_blocked_host` / `is_loopback_host` then run their
  `is_link_local` / `is_unspecified` / `is_loopback` tests on that canonical v4.
- **`ip_literal(host)`** strips a trailing FQDN dot and an RFC-4007 `%zone`
  **before** parsing, so a zoned/dotted link-local literal can't slip into the
  `Err`→hostname arm.
- **The unspecified address** (`0.0.0.0` / `::`) is now blocked by an explicit
  `is_unspecified()` test in both the V4 and V6 arms of `is_blocked_host`.

The gate is **the one shared copy**. `is_blocked_host` is reached through
`host_gate(host, ssl_mode)`, which is the single security-load-bearing admission
decision: (1) link-local / metadata refused always, even over TLS; (2) any
non-loopback host must encrypt (Disabled / Preferred stay loopback-only, so
plaintext never leaves the box).

### MySQL path — closed on lean

The prerelease record left the MySQL loader open: it carried its **own divergent**
`is_blocked_host` and did not route through the shared core. On lean that is
**resolved**. [`mysql_loader.rs`](../../../backend/crates/api/src/mysql_loader.rs)
`Cfg::from_config` calls `connectors_core::parse_ssl_mode`,
`connectors_core::is_loopback_host`, and the shared
`connectors_core::host_gate(&host, ssl_mode)?` directly — there is no duplicated
gate to drift. It also refuses the legacy pre-built `conn` URL outright (forcing
discrete host / port / user / password / database components), closing the
URL-parse SSRF surface as well. The only loader-specific code is `mysql_ssl_mode`,
which maps the engine-agnostic `SslMode` to sqlx's `MySqlSslMode`. Any future
loader (Postgres, …) is forced through the same one reviewed copy.

> The gate module carries `#![allow(dead_code)]`: the conduit is built and tested
> but not yet wired to a route (the connector UI / HTTP endpoint lands in a later
> slice). The gate landed **first**, deliberately, so no loader re-derives the
> admission rules per engine. See [connectors.md](../code/backend/connectors.md).

## Verify

```
cd backend && cargo test -p api connectors_core::
```

Five tests, including the three that pin every confirmed vector:

- `blocks_every_ipv6_wrapper_and_encoding_of_metadata` — asserts `is_blocked_host`
  is true for all eight metadata encodings and false for legitimate remote v4/v6.
- `loopback_recognizes_ipv6_wrappers_of_loopback` — `::ffff:127.0.0.1` is
  loopback, `::ffff:8.8.8.8` is not.
- `gate_refuses_metadata_even_over_tls_and_requires_remote_encryption` — the
  metadata vectors are refused even with `VerifyIdentity` / `Required`, loopback
  is allowed at any mode, and a remote host is rejected on plaintext but allowed
  when it encrypts.

A new candidate vector can be ground-truthed the same way the originals were: a
small `rustc` program printing the actual `ip_literal(...).parse()` / `to_ipv4()`
result, then added as a row to `blocks_every_ipv6_wrapper_and_encoding_of_metadata`.

## Related guard (distinct)

`tools/connectors-audit/audit.js` is a separate connector-layer guard from
`CAS_A4448B94`: it fails CI if any connector calls a `db::` storage mutation
directly instead of routing through `pipeline::upload_csv` (RBAC + audit +
cascade bypass). It is **not** the SSRF gate-audit — it reads `connectors_core.rs`
and `mysql_loader.rs` as `yellow` (no mutation, no `pipeline::` — a primitive to
review). The SSRF gate's lasting guard is the regression test set above, not a
standing tool.
