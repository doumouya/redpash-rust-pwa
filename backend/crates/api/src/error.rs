//! Purpose: the error airlock — rich diagnostics server-side, sanitized wire.
//! Ported from the predecessor: `inner` (eyre::Report, full source chain +
//! lazy backtrace) is logged through tracing and DROPPED before any bytes
//! leave the process; the wire carries only `{ "error": message, "kind" }`.
//! 4xx constructors leave `inner` empty (the message IS the contract); the
//! 5xx path and the From impls wrap the source so operators see PgError
//! detail in logs while callers see a generic line.
//! The events-table Channel B (EventInfo on response extensions) lands with
//! the observability spine in Phase 4.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub kind: &'static str,
    pub message: String,
    /// Never crosses the wire.
    pub inner: Option<eyre::Report>,
}

impl AppError {
    pub fn bad_request(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, kind, message: msg.into(), inner: None }
    }
    pub fn unauthenticated() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            kind: "unauthenticated",
            message: "sign in required".into(),
            inner: None,
        }
    }
    /// THE denial shape. RBAC denials are 404, never 403 — a denied caller
    /// cannot tell "exists but not yours" from "doesn't exist".
    pub fn not_found(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, kind, message: msg.into(), inner: None }
    }
    /// The ONE sanctioned 403: the field gate (field_perms::require_fields),
    /// which runs AFTER the coarse leak-free object gate has admitted the
    /// caller — existence is already known, so naming the blocked field leaks
    /// nothing. Object-level denials stay not_found.
    pub fn forbidden(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::FORBIDDEN, kind, message: msg.into(), inner: None }
    }
    pub fn conflict(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::CONFLICT, kind, message: msg.into(), inner: None }
    }
    pub fn internal(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, kind, message: msg.into(), inner: None }
    }
    pub fn service_unavailable(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::SERVICE_UNAVAILABLE, kind, message: msg.into(), inner: None }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match &self.inner {
            Some(report) => tracing::error!(
                status = %self.status,
                kind = %self.kind,
                message = %self.message,
                error.chain = %format!("{report:#}"),
                error.debug = ?report,
                "request failed"
            ),
            None => tracing::warn!(
                status = %self.status,
                kind = %self.kind,
                message = %self.message,
                "request failed"
            ),
        }
        // inner is dropped HERE — the airlock.
        let body = Json(serde_json::json!({ "error": self.message, "kind": self.kind }));
        (self.status, body).into_response()
    }
}

/// Generic wire message on purpose: PgError constraint/SQLSTATE detail rides
/// the log channel only. RowNotFound is NOT mapped to 404 — handlers model
/// missing rows explicitly with fetch_optional.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            kind: "db",
            message: "internal database error".into(),
            inner: Some(eyre::Report::new(e)),
        }
    }
}

impl From<eyre::Report> for AppError {
    fn from(e: eyre::Report) -> Self {
        AppError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            kind: "internal",
            message: format!("{e}"),
            inner: Some(e),
        }
    }
}

impl From<data::DataError> for AppError {
    fn from(e: data::DataError) -> Self {
        use data::DataError::*;
        match e {
            NotFound(m) => AppError::not_found("not_found", m),
            InvalidSpec(m) => AppError::bad_request("invalid_spec", m),
            // Polars failures on user data are caller-fixable (a malformed
            // CSV, a bad cast) → 400; the chain stays server-side.
            Polars(ref pe) => AppError {
                status: StatusCode::BAD_REQUEST,
                kind: "invalid_csv",
                message: pe.to_string(),
                inner: Some(eyre::Report::new(e)),
            },
            Internal(m) => AppError::internal("data_engine", m),
        }
    }
}
