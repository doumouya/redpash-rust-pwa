//! Doc: docs/internal/code/backend/data/lib.md
//! # `data` — Pure-compute layer
//!
//! Everything in this crate is HTTP-agnostic. The `api` crate calls
//! these functions and serialises the results; tests can exercise them
//! directly without spinning up a server.
//!
//! Modules:
//!   - `encoding`  : detect encoding from a byte buffer (chardetng)
//!   - `parse`     : streaming CSV parse via Polars `LazyFrame`
//!   - `dtype`     : per-column type inference + light stats
//!   - `dedup`     : full-row + per-PK duplicate detection
//!   - `joins`     : detect_join_keys port — set-overlap scoring
//!   - `group_by`  : aggregation engine used by Reports
//!   - `steps`     : apply / undo / redo a `project_steps` operation
//!   - `render`    : Markdown → HTML for `/docs`, Maud templates for
//!                   reports + dashboards, syntect for code highlighting
//!
//! Most modules are stubbed at this stage — they fill in as each phase
//! lands. The signatures + module boundaries are stable, so the `api`
//! crate can wire its routes today and the implementations land
//! independently.

pub mod encoding;
pub mod parse;
pub mod dtype;
pub mod dedup;
pub mod joins;
pub mod distinct;
pub mod group_by;
pub mod steps;
pub mod stats;
// `render` is the Markdown / Maud / syntect path for `/api/docs` and
// the report templates. Server-side only — its transitive deps
// (`onig_sys`, `crossterm`) don't compile on wasm32-unknown-unknown.
// See docs/internal/roadmap-webassembly.md §3 + §7.
#[cfg(not(target_arch = "wasm32"))]
pub mod render;
pub mod export;
pub mod clean;

// `wasm` — Phase B wasm-bindgen wrappers (apply_filter / apply_sort /
// auto_clean / step_preview). Only compiled for wasm32; the server
// build doesn't see this module. See docs/internal/roadmap-webassembly.md §5.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// Crate-level error. Wraps Polars, IO, and parse failures into a single
/// type the `api` crate can map to HTTP status codes.
#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Polars error: {0}")]
    Polars(#[from] polars::error::PolarsError),

    #[error("Encoding error: {0}")]
    Encoding(String),

    #[error("Invalid spec: {0}")]
    InvalidSpec(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Export error: {0}")]
    Export(String),
}

pub type Result<T> = std::result::Result<T, DataError>;
