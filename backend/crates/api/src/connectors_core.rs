//! Purpose: the **shared connector core** — the security-load-bearing admission gate
//! (host / TLS + SSRF) and the engine-agnostic `ssl_mode`, lifted out of the
//! per-loader files so `mysql_loader` + `postgres_loader` (+ future engines) share
//! ONE reviewed copy instead of each carrying a divergence-prone duplicate. The
//! `connectors_core` seam, co-owned with the SQL-connector lane (the shapes here
//! mirror `mysql_loader`'s Slice-A `host_tls_gate` / `parse_ssl_mode`, made
//! engine-agnostic). Each loader maps the core `SslMode` to its sqlx type
//! (`MySqlSslMode` / `PgSslMode`).
//! Doc: docs/internal/code/backend/api/connectors_core.md
#![allow(dead_code)]

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Engine-agnostic SSL mode — each loader maps it to its sqlx enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SslMode {
    Disabled,
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

impl SslMode {
    /// Does this mode encrypt the wire? `Required` + the `Verify*` modes do;
    /// `Disabled` / `Preferred` may transport plaintext (Preferred falls back), so
    /// they stay loopback-only.
    pub fn encrypts(self) -> bool {
        matches!(self, SslMode::Required | SslMode::VerifyCa | SslMode::VerifyIdentity)
    }
}

/// Parse a config `ssl_mode` string → `SslMode`. Anything unknown → `Required` (the
/// safe encrypting default), so a typo never silently downgrades to plaintext.
pub fn parse_ssl_mode(s: &str) -> SslMode {
    match s.trim().to_ascii_lowercase().as_str() {
        "disabled" => SslMode::Disabled,
        "preferred" => SslMode::Preferred,
        "verify_ca" | "verify-ca" => SslMode::VerifyCa,
        "verify_identity" | "verify-identity" => SslMode::VerifyIdentity,
        _ => SslMode::Required,
    }
}

/// The IPv4 a host's IPv6 literal will actually route to, if any — so an IPv6
/// wrapper can't smuggle a blocked IPv4 past the gate. The gate must classify the
/// address the kernel `connect()`s to, not the textual form:
///  - IPv4-mapped     `::ffff:a.b.c.d`   (Linux routes straight to `a.b.c.d`)
///  - IPv4-compatible `::a.b.c.d`         (deprecated, still embeds the v4)
///  - NAT64 well-known `64:ff9b::a.b.c.d` (RFC 6052 — a NAT64 gateway translates it)
/// Returns `None` for a genuine IPv6 host (no embedded v4).
fn embedded_ipv4(v6: &Ipv6Addr) -> Option<Ipv4Addr> {
    let s = v6.segments();
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
    }
    v6.to_ipv4() // IPv4-mapped + IPv4-compatible
}

/// Strip a trailing FQDN dot and an RFC-4007 zone id (`fe80::1%eth0`) before parsing:
/// `std::net::IpAddr` rejects both, but `getaddrinfo` (what sqlx resolves through)
/// accepts them — so without this a zoned/dotted link-local literal would slip the
/// parse-fails-→-treated-as-hostname `Err` arm and reach a host the gate must refuse.
fn ip_literal(host: &str) -> &str {
    let h = host.strip_suffix('.').unwrap_or(host);
    h.split_once('%').map(|(base, _)| base).unwrap_or(h)
}

/// Is this host loopback? `localhost` + any loopback IP literal (127.0.0.0/8, ::1,
/// and IPv6 wrappers of loopback like `::ffff:127.0.0.1`) — NOT hostnames like
/// `127.evil.com` / `127.0.0.1.attacker.com` that a `starts_with("127.")` check would
/// let through (SSRF). Loopback may use any ssl_mode (plaintext never leaves the box).
pub fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    match ip_literal(host).parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || embedded_ipv4(&v6).is_some_and(|v4| v4.is_loopback()),
        Err(_) => false,
    }
}

/// Block hosts that are never a real DB and are classic SSRF pivots — refused
/// **always**, even over TLS:
///  - link-local / cloud-metadata: IPv4 `169.254.0.0/16` (incl. the
///    `169.254.169.254` metadata endpoint) and IPv6 `fe80::/10`, **including every
///    IPv6 wrapper** (`::ffff:` / `::` / NAT64) of a link-local IPv4 — classification
///    runs on the address the kernel routes to, not the textual encoding;
///  - the unspecified address (`0.0.0.0` / `::`), which `connect()` routes to the
///    local host.
/// Hostnames pass here (resolution-time DNS-rebinding is a v2 concern; the v1 metadata
/// vector is the IP literal — in all its encodings, which `embedded_ipv4` + `ip_literal`
/// canonicalize first).
pub fn is_blocked_host(host: &str) -> bool {
    match ip_literal(host).parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_link_local() || v4.is_unspecified(),
        Ok(IpAddr::V6(v6)) => {
            if let Some(v4) = embedded_ipv4(&v6) {
                if v4.is_link_local() || v4.is_unspecified() {
                    return true;
                }
            }
            (v6.segments()[0] & 0xffc0) == 0xfe80 || v6.is_unspecified()
        }
        Err(_) => false,
    }
}

/// The host/TLS admission gate — the single security-load-bearing decision for a
/// connector target, shared by every loader. Two rules:
///  1. link-local / cloud-metadata hosts are refused **always** (even over TLS) — an
///     SSRF pivot, never a real DB.
///  2. a **remote** host must **encrypt** (`ssl_mode.encrypts()`) — `Disabled` /
///     `Preferred` can transport credentials + data in plaintext, so they stay
///     loopback-only (plaintext on loopback never leaves the box).
///
/// Returns an engine-agnostic message on refusal; the caller wraps it
/// (`AppError::bad_request` / `anyhow`).
pub fn host_gate(host: &str, ssl_mode: SslMode) -> Result<(), String> {
    if is_blocked_host(host) {
        return Err(format!("host '{host}' is a link-local / metadata address — refused (SSRF guard)."));
    }
    if !is_loopback_host(host) && !ssl_mode.encrypts() {
        return Err(format!(
            "remote host '{host}' requires ssl_mode>=required (got {ssl_mode:?}) — plaintext \
             would leak credentials + data over the wire. Use ssl_mode=required (or verify_ca / \
             verify_identity), or connect via loopback."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_unknown_defaults_to_required() {
        assert_eq!(parse_ssl_mode("disabled"), SslMode::Disabled);
        assert_eq!(parse_ssl_mode("preferred"), SslMode::Preferred);
        assert_eq!(parse_ssl_mode("verify-ca"), SslMode::VerifyCa);
        assert_eq!(parse_ssl_mode("verify_identity"), SslMode::VerifyIdentity);
        assert_eq!(parse_ssl_mode("REQUIRED"), SslMode::Required);
        assert_eq!(parse_ssl_mode("typo"), SslMode::Required); // no silent plaintext downgrade
        assert_eq!(parse_ssl_mode(""), SslMode::Required);
    }

    #[test]
    fn encrypts_only_for_required_and_verify() {
        assert!(!SslMode::Disabled.encrypts());
        assert!(!SslMode::Preferred.encrypts());
        assert!(SslMode::Required.encrypts());
        assert!(SslMode::VerifyCa.encrypts());
        assert!(SslMode::VerifyIdentity.encrypts());
    }

    #[test]
    fn loopback_recognizes_only_real_loopback() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.5.5.5"));
        assert!(is_loopback_host("::1"));
        assert!(!is_loopback_host("127.evil.com"));
        assert!(!is_loopback_host("10.0.0.1"));
        assert!(!is_loopback_host("db.example.com"));
    }

    #[test]
    fn blocks_link_local_and_metadata() {
        assert!(is_blocked_host("169.254.169.254")); // cloud metadata
        assert!(is_blocked_host("169.254.0.1"));
        assert!(is_blocked_host("fe80::1"));
        assert!(!is_blocked_host("10.0.0.1"));
        assert!(!is_blocked_host("127.0.0.1"));
        assert!(!is_blocked_host("db.example.com"));
    }

    // Regression: the 12 compiler-grounded SSRF bypasses found by the gate-audit
    // workflow — IPv6 wrappers / zone-id / trailing-dot encodings of the cloud-metadata
    // IPv4 that `seg[0]&0xffc0 != 0xfe80` let through, but the kernel routes to
    // 169.254.169.254. classification must run on the address `connect()` reaches.
    #[test]
    fn blocks_every_ipv6_wrapper_and_encoding_of_metadata() {
        for v in [
            "::ffff:169.254.169.254",   // IPv4-mapped
            "::ffff:a9fe:a9fe",         // IPv4-mapped, hex form (parses to the same)
            "::169.254.169.254",        // IPv4-compatible
            "64:ff9b::169.254.169.254", // NAT64 well-known prefix (RFC 6052)
            "fe80::1%eth0",             // zoned link-local (IpAddr::parse rejects %zone)
            "169.254.169.254.",         // trailing-dot FQDN form (IpAddr::parse rejects .)
            "0.0.0.0",                  // unspecified → routes to the local host
            "::",                       // unspecified v6
        ] {
            assert!(is_blocked_host(v), "must block SSRF vector {v:?}");
        }
        // legit hosts the gate must NOT over-block:
        assert!(!is_blocked_host("::ffff:10.0.0.1")); // private over TLS — allowed
        assert!(!is_blocked_host("::1")); // loopback, not blocked (handled by is_loopback_host)
        assert!(!is_blocked_host("db.example.com.")); // trailing-dot hostname
        assert!(!is_blocked_host("2606:4700::1111")); // genuine global IPv6
    }

    #[test]
    fn loopback_recognizes_ipv6_wrappers_of_loopback() {
        assert!(is_loopback_host("::ffff:127.0.0.1")); // IPv4-mapped loopback
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(!is_loopback_host("::ffff:8.8.8.8")); // mapped non-loopback
    }

    #[test]
    fn gate_refuses_mapped_metadata_even_over_tls() {
        // policy-impact proof: a metadata/SSRF target must be refused ALWAYS, even with
        // an encrypting ssl_mode (host_gate checks is_blocked_host before the TLS rule).
        assert!(host_gate("::ffff:169.254.169.254", SslMode::VerifyIdentity).is_err());
        assert!(host_gate("64:ff9b::169.254.169.254", SslMode::Required).is_err());
        assert!(host_gate("fe80::1%eth0", SslMode::Required).is_err());
        assert!(host_gate("0.0.0.0", SslMode::Required).is_err());
        // a genuine remote over TLS still connects:
        assert!(host_gate("2606:4700::1111", SslMode::Required).is_ok());
    }

    #[test]
    fn gate_loopback_any_remote_must_encrypt_metadata_always_blocked() {
        // loopback: any mode ok
        assert!(host_gate("127.0.0.1", SslMode::Disabled).is_ok());
        assert!(host_gate("localhost", SslMode::Preferred).is_ok());
        // remote + plaintext: rejected
        assert!(host_gate("db.example.com", SslMode::Disabled).is_err());
        assert!(host_gate("10.0.0.1", SslMode::Preferred).is_err());
        // remote + encrypting: allowed
        assert!(host_gate("db.example.com", SslMode::Required).is_ok());
        assert!(host_gate("10.0.0.1", SslMode::VerifyIdentity).is_ok());
        // metadata: refused even over TLS
        assert!(host_gate("169.254.169.254", SslMode::VerifyIdentity).is_err());
        assert!(host_gate("fe80::1", SslMode::Required).is_err());
    }
}
