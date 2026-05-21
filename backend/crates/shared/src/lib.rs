//! # `shared` — DTOs across the wire
//!
//! Every struct in this crate is serialised over HTTP and deserialised
//! on the JS side. Keeping it isolated means the `api` and `data` crates
//! both depend on a single, dependency-light crate for request /
//! response shapes — no risk of drift, fast compile.
//!
//! Modules map 1:1 to API resources. Cross-cutting types (pagination,
//! errors) live in the root.

use serde::{Deserialize, Serialize};

pub mod project;
pub mod company;
pub mod file;
pub mod filter;
pub mod report;
pub mod dashboard;
pub mod step;
pub mod user;
pub mod event;

/// One page of a paginated result. Returned by every `…/page` endpoint
/// (files, reports, …). `rows` is generic so each resource can pick its
/// own row shape; `total` reflects the post-filter count, `all_count`
/// the underlying total before filters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page<T> {
    pub rows:      Vec<T>,
    pub total:     u64,
    pub all_count: u64,
    pub page:      u32,
    pub size:      u32,
    pub pages:     u32,
    /// Server-side query time in milliseconds — useful for the
    /// cleaner's footer status indicator.
    pub ms: u32,
    /// Absolute row index in the underlying frame for each row in this
    /// page (post step-replay, pre query-time filter/sort). Lets the
    /// frontend's select-mode build a `drop_rows` step that targets
    /// the correct rows even when filters/sort are active.
    #[serde(default)]
    pub row_indices: Vec<u32>,
}

/// Generic envelope for endpoints that return a single record alongside
/// metadata. Keeps response shapes regular.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub data: T,
}

/// Wire-level error returned by every failure path. The HTTP status
/// code is set on the response separately; this carries the human-
/// readable message + an optional machine-readable kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    /// Stable identifier — e.g. `"not_found"`, `"invalid_csv"`,
    /// `"encoding_failed"`. Clients can branch on this.
    pub kind: String,
}
