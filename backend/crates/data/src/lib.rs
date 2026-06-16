//! Purpose: the RedPash data engine — pure compute over dataframes.
//! One engine, two surfaces: this exact crate runs natively in the api crate
//! AND as wasm32 in the browser. Zero io / http / threads / time by law
//! (tools/purity-check.sh gates every commit on a wasm32 cargo check).
//!
//! render/doc-rendering deliberately lives OUTSIDE this crate (the
//! predecessor's stub-plus-deps muddied the pure-compute story).

pub mod clean;
pub mod distinct;
pub mod dtype;
pub mod encoding;
pub mod error;
pub mod filter;
pub mod group_by;
pub mod joins;
pub mod parse;
pub mod search;
pub mod sentinels;
pub mod sort;
pub mod sql;
pub mod stats;
pub mod steps;
pub mod structure;
pub mod view;

// Export (CSV/XLSX/JSON) is server-only — rust_xlsxwriter doesn't build on wasm.
#[cfg(not(target_arch = "wasm32"))]
pub mod export;

pub use error::DataError;

/// Crate result alias.
pub type Result<T> = std::result::Result<T, DataError>;

/// Row caps as ONE constant kept in lockstep across the server page clamp,
/// the SQL result cap, and the client engine buffer (CAS_21B43BEC lesson).
pub const ROW_CAP: usize = 500_000;

// wasm-bindgen wrappers (JSON-in/JSON-out over the same engine the server
// runs). Generated method list — never a hand-maintained array (the
// predecessor's 13-vs-6 drift). Lands with the parse/score wrappers next.
#[cfg(target_arch = "wasm32")]
pub mod wasm;
