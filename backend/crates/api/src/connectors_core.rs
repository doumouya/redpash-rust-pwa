//! Purpose: the SSRF/TLS admission gate every connector MUST route through —
//! the single security-load-bearing decision for a remote DB target. Ported
//! VERBATIM (mature, well-tested code; the calibration of what to block is the
//! moat). Classification runs on the address the kernel connect()s to, not the
//! textual form, so no IPv6 wrapper / zone-id / trailing-dot encoding smuggles
//! a blocked IPv4 past it.
//!
//! No connector loader exists in this tree yet (the Postgres/MySQL pull lands
//! with the connector UI in a later slice) — but the gate lands first so every
//! future loader is forced through one reviewed copy, not a per-loader
//! divergence. Hence the module-level allow(dead_code).
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
    /// Does this mode encrypt the wire? Required + Verify* do; Disabled /
    /// Preferred may transport plaintext, so they stay loopback-only.
    pub fn encrypts(self) -> bool {
        matches!(self, SslMode::Required | SslMode::VerifyCa | SslMode::VerifyIdentity)
    }
}

/// Parse a config ssl_mode string. Anything unknown → Required (the safe
/// encrypting default), so a typo never silently downgrades to plaintext.
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
/// wrapper can't smuggle a blocked IPv4 past the gate (IPv4-mapped,
/// IPv4-compatible, NAT64 well-known RFC 6052). None for a genuine IPv6 host.
fn embedded_ipv4(v6: &Ipv6Addr) -> Option<Ipv4Addr> {
    let s = v6.segments();
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
    }
    v6.to_ipv4()
}

/// Strip a trailing FQDN dot and an RFC-4007 zone id before parsing: IpAddr
/// rejects both but getaddrinfo accepts them, so without this a zoned/dotted
/// link-local literal would slip the parse-fails arm and reach a blocked host.
fn ip_literal(host: &str) -> &str {
    let h = host.strip_suffix('.').unwrap_or(host);
    h.split_once('%').map(|(base, _)| base).unwrap_or(h)
}

/// localhost + any loopback IP literal (incl. IPv6 wrappers of loopback) — NOT
/// hostnames like 127.evil.com that a starts_with("127.") check would let
/// through. Loopback may use any ssl_mode (plaintext never leaves the box).
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
/// ALWAYS, even over TLS: link-local / cloud-metadata (169.254.0.0/16 incl.
/// 169.254.169.254, fe80::/10, and every IPv6 wrapper of a link-local v4) and
/// the unspecified address (0.0.0.0 / ::, which connect() routes to local).
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

/// The host/TLS admission gate. (1) link-local / metadata refused always; (2) a
/// remote host must encrypt (Disabled/Preferred stay loopback-only).
pub fn host_gate(host: &str, ssl_mode: SslMode) -> Result<(), String> {
    if is_blocked_host(host) {
        return Err(format!("host '{host}' is a link-local / metadata address — refused (SSRF guard)."));
    }
    if !is_loopback_host(host) && !ssl_mode.encrypts() {
        return Err(format!(
            "remote host '{host}' requires ssl_mode>=required (got {ssl_mode:?}) — plaintext \
             would leak credentials + data over the wire."
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
        assert_eq!(parse_ssl_mode("verify-ca"), SslMode::VerifyCa);
        assert_eq!(parse_ssl_mode("typo"), SslMode::Required); // no silent plaintext downgrade
        assert_eq!(parse_ssl_mode(""), SslMode::Required);
    }

    #[test]
    fn loopback_recognizes_only_real_loopback() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("127.5.5.5"));
        assert!(is_loopback_host("::1"));
        assert!(!is_loopback_host("127.evil.com"));
        assert!(!is_loopback_host("db.example.com"));
    }

    /// The 12 compiler-grounded SSRF bypasses the gate-audit found — IPv6
    /// wrappers / zone-id / trailing-dot encodings of cloud-metadata that the
    /// kernel routes to 169.254.169.254.
    #[test]
    fn blocks_every_ipv6_wrapper_and_encoding_of_metadata() {
        for v in [
            "::ffff:169.254.169.254",
            "::ffff:a9fe:a9fe",
            "::169.254.169.254",
            "64:ff9b::169.254.169.254",
            "fe80::1%eth0",
            "169.254.169.254.",
            "0.0.0.0",
            "::",
        ] {
            assert!(is_blocked_host(v), "must block SSRF vector {v:?}");
        }
        assert!(!is_blocked_host("::ffff:10.0.0.1"));
        assert!(!is_blocked_host("::1"));
        assert!(!is_blocked_host("db.example.com."));
        assert!(!is_blocked_host("2606:4700::1111"));
    }

    #[test]
    fn loopback_recognizes_ipv6_wrappers_of_loopback() {
        assert!(is_loopback_host("::ffff:127.0.0.1"));
        assert!(!is_loopback_host("::ffff:8.8.8.8"));
    }

    #[test]
    fn gate_refuses_metadata_even_over_tls_and_requires_remote_encryption() {
        // metadata/SSRF refused always, even with an encrypting mode:
        assert!(host_gate("::ffff:169.254.169.254", SslMode::VerifyIdentity).is_err());
        assert!(host_gate("64:ff9b::169.254.169.254", SslMode::Required).is_err());
        assert!(host_gate("fe80::1%eth0", SslMode::Required).is_err());
        assert!(host_gate("0.0.0.0", SslMode::Required).is_err());
        // loopback: any mode ok
        assert!(host_gate("127.0.0.1", SslMode::Disabled).is_ok());
        // remote + plaintext rejected; remote + encrypting allowed
        assert!(host_gate("db.example.com", SslMode::Disabled).is_err());
        assert!(host_gate("db.example.com", SslMode::Required).is_ok());
        assert!(host_gate("2606:4700::1111", SslMode::Required).is_ok());
    }
}
