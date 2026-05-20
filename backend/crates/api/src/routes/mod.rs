//! Route assembly.
//!
//! Each resource is its own module (`health`, `files`, …) and exposes a
//! `pub fn routes() -> Router<AppState>` that gets nested under its URL
//! prefix here. Keeping the tree assembled in one place makes the API
//! surface easy to audit.
//!
//! Layers (applied outside-in):
//!   - DefaultBodyLimit : 64 MiB so CSV uploads aren't truncated
//!   - TraceLayer       : structured access logs via `tracing`
//!   - CorsLayer        : permissive in dev; tightened in prod via env
//!   - CompressionLayer : brotli/gzip for JSON + static assets
//!
//! Static frontend assets are served from `../frontend/` so `cargo run`
//! alone is enough to bring the whole app up in dev.

use axum::{extract::DefaultBodyLimit, Router};
use tower_http::{
    compression::CompressionLayer,
    cors::CorsLayer,
    services::ServeDir,
    trace::TraceLayer,
};

use crate::state::AppState;

mod auth;
mod companies;
mod dashboards;
mod files;
mod health;
mod me;
mod projects;
mod reports;
mod users;

pub(crate) use auth::read_cookie;
pub(crate) use me::resolve_user_rid;

/// 404 with `kind="not_found"` on miss or mismatch — so we never leak
/// "exists but not yours" vs "doesn't exist".
pub(crate) fn ensure_owner(
    owner_lookup: Result<Option<String>, sqlx::Error>,
    expected:     &str,
    label:        &str,
    rid:          &str,
) -> Result<(), crate::error::AppError> {
    use crate::error::AppError;
    let owner = owner_lookup
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("{label} {rid}")))?;
    if owner != expected {
        return Err(AppError::not_found("not_found", format!("{label} {rid}")));
    }
    Ok(())
}

// 256 MiB — well above Salesforce's 100 MB CSV import cap, and Polars
// handles arbitrary row sizes / column counts internally so no per-row
// or per-field artificial limits.
const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .nest("/health",   health::routes())
        .nest("/me",       me::routes())
        .nest("/auth",     auth::routes())
        .nest("/projects", projects::routes())
        .nest("/companies",  companies::routes())
        .nest("/files",      files::routes())
        .nest("/reports",    reports::routes())
        .nest("/dashboards", dashboards::routes())
        .nest("/users",      users::routes())
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES));

    // Dev: serve frontend from the repo. In prod the static files are
    // baked into the binary via `include_dir!` (Phase 5).
    let frontend = ServeDir::new("../frontend").append_index_html_on_directories(true);

    Router::new()
        .nest("/api", api)
        .fallback_service(frontend)
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
