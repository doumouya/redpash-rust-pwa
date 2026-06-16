//! Authenticated encryption for connector secrets (privacy finding F-F) + key
//! rotation.
//!
//! AES-256-GCM. Keys come from the environment: `REDPASH_MASTER_KEY` (current)
//! and the optional `REDPASH_MASTER_KEY_PREV` (the key being rotated out), each
//! a base64-encoded 32 bytes. Envelope: `v1:<base64(nonce(12) || ct || tag(16))>`
//! — exactly the format the connectors schema declares; the `v1:` prefix is the
//! version / rotation seam.
//!
//! Fail-closed: with no / non-32-byte CURRENT key, `encrypt_secret` ERRS — a
//! secret is never persisted in the clear. `decrypt_secret` tries the current
//! key then the prev key (so a re-keyed deploy still reads old ciphertext); a
//! value WITHOUT the `v1:` prefix is legacy plaintext, returned unchanged.
//!
//! Rotation: `rotate_secret` / `rotate_value_in_place` re-encrypt every envelope
//! under the CURRENT key. Run the `redpash-rotate-secrets` bin after swapping
//! keys (old key as `REDPASH_MASTER_KEY_PREV`), then drop `_PREV`.

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::sync::OnceLock;

static CURRENT_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
static PREV_KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

fn load_key(var: &str) -> Option<[u8; 32]> {
    let v = std::env::var(var).ok()?;
    let raw = STANDARD.decode(v.trim()).ok()?;
    <[u8; 32]>::try_from(raw.as_slice()).ok()
}
fn current_key() -> Option<&'static [u8; 32]> {
    CURRENT_KEY.get_or_init(|| load_key("REDPASH_MASTER_KEY")).as_ref()
}
fn prev_key() -> Option<&'static [u8; 32]> {
    PREV_KEY.get_or_init(|| load_key("REDPASH_MASTER_KEY_PREV")).as_ref()
}
/// Keys to TRY on decrypt, current first then the one being rotated out.
fn decrypt_keys() -> Vec<[u8; 32]> {
    [current_key(), prev_key()].into_iter().flatten().copied().collect()
}

fn encrypt_with(key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bit, unique per call
    let ct = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| "encrypt failed".to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct); // ct already carries the 16-byte GCM tag
    Ok(format!("v1:{}", STANDARD.encode(blob)))
}

fn decrypt_with(key: &[u8; 32], envelope: &str) -> Result<String, String> {
    let b64 = envelope.strip_prefix("v1:").ok_or("not a v1: envelope")?;
    let blob = STANDARD.decode(b64.trim()).map_err(|_| "bad base64".to_string())?;
    if blob.len() < 12 + 16 {
        return Err("ciphertext too short".into());
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "decrypt failed (wrong key or tampered ciphertext)".to_string())?;
    String::from_utf8(pt).map_err(|_| "non-utf8 plaintext".into())
}

/// Try each key in turn (current, then prev) — the dual-key window that lets a
/// re-keyed deploy still read ciphertext written under the old key.
fn decrypt_any(keys: &[[u8; 32]], envelope: &str) -> Result<String, String> {
    let mut last = "no decryption key available".to_string();
    for k in keys {
        match decrypt_with(k, envelope) {
            Ok(pt) => return Ok(pt),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Encrypt a connector secret → `v1:...`. Errs (fail-closed) if the current key
/// is absent/malformed — a secret is never persisted in the clear.
pub fn encrypt_secret(plaintext: &str) -> Result<String, String> {
    let key = current_key().ok_or("REDPASH_MASTER_KEY unset or not 32 base64 bytes")?;
    encrypt_with(key, plaintext)
}

/// Decrypt a stored connector secret (trying current then prev key). A value
/// WITHOUT the `v1:` prefix is treated as legacy plaintext and returned as-is.
pub fn decrypt_secret(stored: &str) -> Result<String, String> {
    if !stored.starts_with("v1:") {
        return Ok(stored.to_string());
    }
    let keys = decrypt_keys();
    if keys.is_empty() {
        return Err("REDPASH_MASTER_KEY unset or not 32 base64 bytes".into());
    }
    decrypt_any(&keys, stored)
}

fn rotate_secret_with(
    dec_keys: &[[u8; 32]],
    enc_key: &[u8; 32],
    stored: &str,
) -> Result<Option<String>, String> {
    if !stored.starts_with("v1:") {
        return Ok(None);
    }
    let pt = decrypt_any(dec_keys, stored)?;
    Ok(Some(encrypt_with(enc_key, &pt)?))
}

fn rotate_value_with(dec_keys: &[[u8; 32]], enc_key: &[u8; 32], v: &mut Value) -> Result<bool, String> {
    let mut changed = false;
    match v {
        Value::String(s) => {
            if let Some(new) = rotate_secret_with(dec_keys, enc_key, s)? {
                *s = new;
                changed = true;
            }
        }
        Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                changed |= rotate_value_with(dec_keys, enc_key, val)?;
            }
        }
        Value::Array(arr) => {
            for val in arr.iter_mut() {
                changed |= rotate_value_with(dec_keys, enc_key, val)?;
            }
        }
        _ => {}
    }
    Ok(changed)
}

/// Re-encrypt one value under the CURRENT key if it is an envelope; `None` if it
/// isn't (legacy plaintext is left for the write path to adopt on next write).
pub fn rotate_secret(stored: &str) -> Result<Option<String>, String> {
    if !stored.starts_with("v1:") {
        return Ok(None);
    }
    let enc = current_key().ok_or("REDPASH_MASTER_KEY unset or not 32 base64 bytes")?;
    rotate_secret_with(&decrypt_keys(), enc, stored)
}

/// Walk a JSON value, re-keying every `v1:` envelope in place under the CURRENT
/// key. Returns whether anything changed. Field-agnostic — rotates any encrypted
/// value wherever it sits, so no per-connector secret-field list is needed.
pub fn rotate_value_in_place(v: &mut Value) -> Result<bool, String> {
    let enc = current_key().ok_or("REDPASH_MASTER_KEY unset or not 32 base64 bytes")?;
    rotate_value_with(&decrypt_keys(), enc, v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_and_tamper() {
        let key = [7u8; 32];
        let env = encrypt_with(&key, "s3cret-pw").unwrap();
        assert!(env.starts_with("v1:"));
        assert_eq!(decrypt_with(&key, &env).unwrap(), "s3cret-pw");
        // a different key fails to authenticate (AEAD guarantee)
        assert!(decrypt_with(&[9u8; 32], &env).is_err());
        // a flipped ciphertext byte fails the tag check
        let mut bad = env.clone();
        let last = bad.pop().unwrap();
        bad.push(if last == 'A' { 'B' } else { 'A' });
        assert!(decrypt_with(&key, &bad).is_err());
    }

    #[test]
    fn dual_key_decrypt_falls_back_to_prev() {
        let (a, b) = ([1u8; 32], [2u8; 32]);
        let env = encrypt_with(&a, "x").unwrap();
        // current=b, prev=a → a recovers it
        assert_eq!(decrypt_any(&[b, a], &env).unwrap(), "x");
        // only the wrong key → fail (no plaintext leak)
        assert!(decrypt_any(&[b], &env).is_err());
        assert!(decrypt_any(&[], &env).is_err());
    }

    #[test]
    fn rotate_walks_and_rekeys_envelopes_only() {
        let key = [3u8; 32];
        let env = encrypt_with(&key, "pw").unwrap();
        let mut cfg = json!({ "host": "db.example", "password": env.clone(), "nested": { "tok": "plain" } });
        let changed = rotate_value_with(&[key], &key, &mut cfg).unwrap();
        assert!(changed);
        // host + nested plaintext are untouched; the envelope was re-keyed (new nonce)
        assert_eq!(cfg["host"], "db.example");
        assert_eq!(cfg["nested"]["tok"], "plain");
        let rekeyed = cfg["password"].as_str().unwrap();
        assert!(rekeyed.starts_with("v1:") && rekeyed != env);
        assert_eq!(decrypt_with(&key, rekeyed).unwrap(), "pw");
    }

    #[test]
    fn legacy_plaintext_passes_through() {
        assert_eq!(decrypt_secret("plain-not-v1").unwrap(), "plain-not-v1");
        assert_eq!(rotate_secret("plain-not-v1").unwrap(), None);
    }
}
