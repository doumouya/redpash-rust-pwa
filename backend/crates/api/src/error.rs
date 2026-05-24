//! HTTP-friendly error type — the airlock between rich server-side
//! diagnostics and a sanitized wire response.
//!
//! `AppError` carries an optional [`eyre::Report`] (`inner`) that
//! preserves the full source chain + lazy backtrace from the
//! originating error (sqlx PgError, polars, IO, etc). The report is
//! **server-side only**: `IntoResponse` logs it through tracing
//! (Channel A — pretty-printed chain + Debug backtrace) and stuffs an
//! [`EventInfo`] extension on the response for `capture_mw` to persist
//! to the events table (Channel B). The wire response carries ONLY
//! `kind` + `message` — `inner` is dropped before any bytes leave the
//! process.
//!
//! The wire shape matches `shared::ApiError` (`{ "error": "...",
//! "kind": "..." }`) so the frontend's `api.js` can surface
//! `err.body.kind` consistently.
//!
//! ## Severity split
//!
//! `IntoResponse` logs at WARN for client errors (4xx — no `inner`,
//! the caller-chosen message IS the explanation) and ERROR for
//! internal failures (5xx — `inner` carries the chain). Aggregated
//! dashboards can filter by level instead of having every error look
//! like a warning.
//!
//! ## How `inner` gets populated
//!
//! The 4xx constructors (`bad_request`, `not_found`, `conflict`) leave
//! `inner` as `None` — there's no underlying error chain to capture;
//! the message IS the contract. The 5xx path (`internal` constructor
//! + `From` impls for `sqlx::Error` / `anyhow::Error` / `eyre::Report`
//! / `DataError::Io`) wraps the source into `eyre::Report` so the
//! chain reaches the log stream.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use shared::ApiError;

#[derive(Debug)]
pub struct AppError {
    pub status:  StatusCode,
    pub kind:    &'static str,
    pub message: String,
    /// Rich error chain + lazy backtrace. **Never** crosses the wire —
    /// `IntoResponse` logs it and drops it before serialising the
    /// response body. `None` for client-error constructors (4xx); set
    /// by the 5xx path (internal + From impls).
    pub inner:   Option<eyre::Report>,
}

impl AppError {
    pub fn bad_request(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, kind, message: msg.into(), inner: None }
    }
    pub fn not_found(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, kind, message: msg.into(), inner: None }
    }
    pub fn conflict(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::CONFLICT, kind, message: msg.into(), inner: None }
    }
    /// Internal-server-error constructor. Use the From impls below
    /// when you already have a source error — they preserve the
    /// chain. This constructor is for cases where the message IS the
    /// whole story (e.g. spawn-blocking join failures where the
    /// underlying panic was already logged via the panic hook).
    pub fn internal(kind: &'static str, msg: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, kind, message: msg.into(), inner: None }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // ── Channel A ── full chain to tracing JSON. Severity split:
        // 5xx with a Report → ERROR, 4xx → WARN. request_id auto-attaches
        // via the current span (set by `request_id_mw` at request entry).
        match &self.inner {
            Some(report) => {
                tracing::error!(
                    status      = %self.status,
                    kind        = %self.kind,
                    message     = %self.message,
                    // {:#} walks the source chain (top-level error +
                    // every .source() under it). For sqlx::Error this
                    // surfaces the PgError details (constraint name,
                    // SQLSTATE, etc) that .to_string() flattens away.
                    error.chain = %format!("{report:#}"),
                    // Debug form includes the backtrace when
                    // RUST_BACKTRACE=1 (or =full). eyre captures
                    // lazily — zero cost when the env is unset, full
                    // unwind when it's on.
                    error.debug = ?report,
                    "request failed"
                );
            }
            None => {
                tracing::warn!(
                    status  = %self.status,
                    kind    = %self.kind,
                    message = %self.message,
                    "request failed"
                );
            }
        }

        // ── Channel B ── EventInfo on response extensions for
        // capture_mw. Carries the sanitized kind + message + (when
        // there's an inner Report) a redacted rendering of the chain
        // so the Monitoring page's M-4 error-chain expander has the
        // PgError details at-a-glance. The full unredacted chain
        // stays in Channel A only — discipline gate is
        // `crate::redact::redact_chain`.
        let chain_redacted = self.inner.as_ref().map(|report| {
            crate::redact::redact_chain(&format!("{report:#}"))
        });
        let info = crate::event::EventInfo {
            kind:    self.kind,
            message: self.message.clone(),
            chain_redacted,
        };

        // ── Wire ── self.inner DROPPED here. The eyre::Report never
        // crosses the airlock. ApiError shape unchanged so api.js
        // parsing is untouched.
        let body = Json(ApiError { error: self.message, kind: self.kind.to_string() });
        let mut resp = (self.status, body).into_response();
        resp.extensions_mut().insert(info);
        resp
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
            // IO errors are server-side failures — wrap the source so
            // the eyre Report carries the underlying io::Error chain
            // (file path, errno, etc) into Channel A.
            Io(e)          => AppError {
                status:  StatusCode::INTERNAL_SERVER_ERROR,
                kind:    "io",
                message: e.to_string(),
                inner:   Some(eyre::Report::new(e)),
            },
            Export(m)      => AppError::internal("export_failed", m),
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        // anyhow::Error doesn't impl std::error::Error (it IS one,
        // structurally, but the trait impl is intentionally absent —
        // anyhow's design choice). Bridge via the formatted chain:
        // `{e:#}` walks anyhow's source list the same way `{report:#}`
        // walks eyre's, so the chain reaches Channel A's `error.chain`
        // field intact. Backtrace is fresh from eyre's capture point
        // (not anyhow's original, but the message preserves the line
        // each layer added via wrap_err / context).
        let chain = format!("{e:#}");
        let msg = e.to_string();
        AppError {
            status:  StatusCode::INTERNAL_SERVER_ERROR,
            kind:    "internal",
            message: msg,
            inner:   Some(eyre::Report::msg(chain)),
        }
    }
}

impl From<eyre::Report> for AppError {
    fn from(e: eyre::Report) -> Self {
        let msg = format!("{e}");
        AppError {
            status:  StatusCode::INTERNAL_SERVER_ERROR,
            kind:    "internal",
            message: msg,
            inner:   Some(e),
        }
    }
}

/// Every DB error funnels through `?` as an internal 500 with kind
/// `"db"` — same shape as the 134+ hand-written `.map_err(|e|
/// AppError::internal("db", e.to_string()))?` chains that lived on
/// every sqlx call before this impl landed (rust-dedup-audit-2026-05-24,
/// item A). NOT mapping `RowNotFound → 404`: most queries use
/// `.fetch_optional()` for legitimate missing rows; mapping
/// RowNotFound here would change response codes for handlers that
/// already model "not found" explicitly.
///
/// The wire message is **deliberately generic** ("internal database
/// error") so PgError details (column / constraint / SQLSTATE / bind
/// values) don't leak to the FE. The rich detail rides Channel A via
/// `inner: Some(eyre::Report)` — operators see the full PgError
/// chain in the log stream, users see a clean message.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError {
            status:  StatusCode::INTERNAL_SERVER_ERROR,
            kind:    "db",
            message: "internal database error".to_string(),
            inner:   Some(eyre::Report::new(e)),
        }
    }
}
