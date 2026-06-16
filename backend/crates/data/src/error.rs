//! Purpose: the crate-wide error type the api crate maps to HTTP status.

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("invalid spec: {0}")]
    InvalidSpec(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("polars error: {0}")]
    Polars(#[from] polars::error::PolarsError),
    #[error("internal: {0}")]
    Internal(String),
}
