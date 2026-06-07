//! Purpose: connector **secret-at-rest**. Symmetric AES-256-GCM (ring) under a master
//! key from `REDPASH_MASTER_KEY`, so a connector credential (Kafka SASL today; every
//! future connector) is encrypted in `connectors.config` — a `pg_dump` / VIEW-reach
//! read never sees a plaintext cluster key. Encrypt on the create path; decrypt in the
//! loader's `from_connection`. NEVER store a plaintext secret in config.
//!
//! Format: `v1:` + base64(`nonce[12] || ciphertext || tag[16]`). The `v1:` prefix is
//! the creds_version — rotate the algo/key by bumping it. A wrong-key / tampered blob
//! fails LOUDLY on the GCM auth tag (never silent garbage).
//!
//! Fail-closed: `encrypt`/`decrypt` ERROR when the key is unavailable/invalid (a kafka
//! create with a secret refuses rather than storing plaintext; a present-but-
//! undecryptable secret refuses rather than silently skipping). At startup,
//! `report_startup` refuses to boot on a MALFORMED key (operator error) but only WARNS
//! when the key is unset (encryption unavailable; env-based creds still work) — so an
//! existing deployment without the key keeps booting.
//! Doc: docs/internal/code/backend/api/secrets.md

use anyhow::{bail, Context, Result};
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use std::sync::OnceLock;

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const VERSION_PREFIX: &str = "v1:";
static KEY: OnceLock<LessSafeKey> = OnceLock::new();

/// The master key as a cached `LessSafeKey`. `REDPASH_MASTER_KEY` is the base64 of
/// exactly 32 bytes (AES-256). Errors (never panics) when missing / invalid.
fn key() -> Result<&'static LessSafeKey> {
    if let Some(k) = KEY.get() {
        return Ok(k);
    }
    let raw = std::env::var("REDPASH_MASTER_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .context("REDPASH_MASTER_KEY is not set — connector secret encryption is unavailable")?;
    let bytes = B64.decode(raw.trim()).context("REDPASH_MASTER_KEY: not valid base64")?;
    if bytes.len() != 32 {
        bail!("REDPASH_MASTER_KEY: must be base64 of 32 bytes (got {})", bytes.len());
    }
    let unbound = UnboundKey::new(&AES_256_GCM, &bytes)
        .map_err(|_| anyhow::anyhow!("REDPASH_MASTER_KEY: invalid AES-256 key"))?;
    let _ = KEY.set(LessSafeKey::new(unbound)); // first writer wins; a race produces the same key
    Ok(KEY.get().expect("key set above"))
}

/// Encrypt a secret → `v1:<base64>`. Fresh random 96-bit nonce per call (GCM's
/// uniqueness requirement). Errors if no master key (never stores plaintext).
pub fn encrypt(plaintext: &str) -> Result<String> {
    seal(key()?, plaintext)
}

/// Decrypt a `v1:<base64>` blob → plaintext. Tampered / wrong-key fails LOUDLY.
pub fn decrypt(stored: &str) -> Result<String> {
    open(key()?, stored)
}

/// Startup posture: refuse to boot on a MALFORMED key (operator error); only WARN when
/// the key is unset (encryption unavailable, env creds still work) so an existing
/// deployment without the key keeps booting. Call once at boot.
pub fn report_startup() -> Result<()> {
    match std::env::var("REDPASH_MASTER_KEY") {
        Ok(v) if !v.trim().is_empty() => {
            key().context("REDPASH_MASTER_KEY is set but invalid — refusing to boot (fix or unset it)")?;
            tracing::info!("secrets: connector secret-at-rest enabled (AES-256-GCM)");
            Ok(())
        }
        _ => {
            tracing::warn!(
                "secrets: REDPASH_MASTER_KEY not set — connector secret encryption UNAVAILABLE \
                 (kafka SASL falls back to .env; creating a connector WITH a secret will error). \
                 Set REDPASH_MASTER_KEY to a base64 32-byte key to enable."
            );
            Ok(())
        }
    }
}

// ── crypto core — takes the key explicitly so it's unit-testable without env ──

fn seal(key: &LessSafeKey, plaintext: &str) -> Result<String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| anyhow::anyhow!("secret: RNG failure generating nonce"))?;
    let mut in_out = plaintext.as_bytes().to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut in_out)
        .map_err(|_| anyhow::anyhow!("secret: encryption failed"))?;
    let mut blob = Vec::with_capacity(NONCE_LEN + in_out.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&in_out);
    Ok(format!("{VERSION_PREFIX}{}", B64.encode(blob)))
}

fn open(key: &LessSafeKey, stored: &str) -> Result<String> {
    let b64 = stored
        .strip_prefix(VERSION_PREFIX)
        .context("secret: unrecognized creds_version (expected v1:)")?;
    let blob = B64.decode(b64).context("secret: not valid base64")?;
    if blob.len() < NONCE_LEN + AES_256_GCM.tag_len() {
        bail!("secret: ciphertext too short"); // < (not <=): an empty plaintext is exactly nonce+tag
    }
    let nonce: [u8; NONCE_LEN] = blob[..NONCE_LEN].try_into().expect("checked len");
    let mut ct = blob[NONCE_LEN..].to_vec();
    let plain = key
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut ct)
        .map_err(|_| anyhow::anyhow!("secret: decryption failed (tampered ciphertext or wrong master key)"))?;
    String::from_utf8(plain.to_vec()).context("secret: decrypted bytes are not UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(b: u8) -> LessSafeKey {
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &[b; 32]).expect("32-byte key"))
    }

    #[test]
    fn seal_open_round_trip() {
        let k = test_key(7);
        let blob = seal(&k, "super-secret-API-key").unwrap();
        assert!(blob.starts_with("v1:"));
        assert_eq!(open(&k, &blob).unwrap(), "super-secret-API-key");
        // empty + unicode round-trip
        assert_eq!(open(&k, &seal(&k, "").unwrap()).unwrap(), "");
        assert_eq!(open(&k, &seal(&k, "café-é-🔑").unwrap()).unwrap(), "café-é-🔑");
        // nonce is random → two seals of the same plaintext differ
        assert_ne!(seal(&k, "x").unwrap(), seal(&k, "x").unwrap());
    }

    #[test]
    fn open_fails_loudly_on_wrong_key_or_tamper() {
        let k = test_key(7);
        let blob = seal(&k, "secret").unwrap();
        // wrong key → error (GCM auth tag), never garbage
        assert!(open(&test_key(9), &blob).is_err());
        // tampered ciphertext → error
        let mut bad = blob.clone();
        let pos = bad.len() - 2;
        let repl = if &bad[pos..pos + 1] == "A" { "B" } else { "A" };
        bad.replace_range(pos..pos + 1, repl);
        assert!(open(&k, &bad).is_err());
        // unknown version prefix / not-our-format → error
        assert!(open(&k, "v9:AAAA").is_err());
        assert!(open(&k, "plaintext").is_err());
    }
}
