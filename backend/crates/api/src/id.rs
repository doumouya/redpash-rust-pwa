//! Doc: docs/internal/code/backend/api/id.md
//! RedPash-ID generation.
//!
//! Format: `<PREFIX>_<32-char-uppercase-hex>` — e.g.
//! `FIL_5F3C7A21D8E94B6E92A1C0F4B3D7E0A2`. 36 chars total. URL-safe,
//! easy to spot in logs.
//!
//! Body is `Uuid::new_v4().simple()` (32 hex, no dashes) upper-cased.
//! 122 bits of randomness — collision probability per insert is
//! negligible, so we don't retry on PK conflict.
//!
//! See [`docs/db/redpash-id.md`](../../../docs/db/redpash-id.md) for
//! the full spec.

use uuid::Uuid;

pub fn new(prefix: &str) -> String {
    let u = Uuid::new_v4();
    let raw = u.simple().to_string().to_ascii_uppercase();
    format!("{prefix}_{raw}")
}
