//! HTTP-friendly error type.
//!
//! Wraps `DataError` (Polars / encoding) and the catch-all `anyhow` into
//! a single `AppError` that implements `IntoResponse` — so handlers can
//! return `Result<T, AppError>` and rely on `?` for everything.
//!
//! The wire shape matches `shared::ApiError` (`{ "error": "...",
//! "kind": "..." }`) so the frontend's `api.js` can surface
//! `err.body.kind` consistently.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use shared::ApiError;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub kind:   &'static str,
    pub message: String,
}

impl AppError {
    pub fn bad_request(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, kind, message: msg.into() }
    }
    pub fn not_found(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, kind, message: msg.into() }
    }
    pub fn internal(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, kind, message: msg.into() }
    }
    pub fn conflict(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::CONFLICT, kind, message: msg.into() }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Log every 4xx/5xx with its message so `cargo run` shows the
        // real cause — by default tower-http's trace layer only logs
        // request paths, not response bodies.
        tracing::warn!(
            status = %self.status,
            kind   = %self.kind,
            message = %self.message,
            "request failed"
        );
        let body = Json(ApiError { error: self.message, kind: self.kind.to_string() });
        (self.status, body).into_response()
    }
}

impl From<data::DataError> for AppError {
    fn from(e: data::DataError) -> Self {
        use data::DataError::*;
        match e {
            NotFound(m)    => AppError::not_found("not_found", m),
            InvalidSpec(m) => AppError::bad_request("invalid_spec", m),
            Encoding(m)    => AppError::bad_request("encoding_failed", m),
            Polars(e)      => AppError::bad_request("invalid_csv", e.to_string()),
            Io(e)          => AppError::internal("io", e.to_string()),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::internal("internal", e.to_string())
    }
}
