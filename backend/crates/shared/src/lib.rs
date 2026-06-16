//! Purpose: wire DTOs — the single vocabulary the JS↔Rust seam speaks.
//! One name per concern across the stack: `filter.rs` / `filter.js` / `FilterNode`.

pub mod file;
pub mod filter;
pub mod query;
pub mod report;
pub mod sort;
pub mod step;

pub use file::ColumnMeta;
pub use filter::FilterNode;
pub use query::QuerySpec;
pub use report::ReportSpec;
pub use sort::SortKey;
pub use step::Step;
