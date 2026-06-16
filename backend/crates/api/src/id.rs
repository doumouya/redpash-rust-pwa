//! Purpose: RedPash-ID minting — `<PREFIX>_<32-hex-uppercase>` (36 chars).
//! 122 bits of uuid-v4 randomness; no PK-collision retry needed.
//! Day-one decision #1: prefixes are UNIQUE per type (see the
//! type_definitions seed) — `object_kind` resolution is a plain map lookup.

use uuid::Uuid;

pub fn new(prefix: &str) -> String {
    let raw = Uuid::new_v4().simple().to_string().to_ascii_uppercase();
    format!("{prefix}_{raw}")
}
