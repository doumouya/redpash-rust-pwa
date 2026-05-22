//! `redpash-api` — HTTP entrypoint.
//!
//! Boots in three steps:
//!   1. load `.env` (DATABASE_URL, REDPASH_BIND, …) — silent if file missing
//!   2. init `tracing-subscriber` from RUST_LOG (default `info`)
//!   3. build the Axum router from `routes::router()` and serve until SIGTERM
//!
//! Routes live under `src/routes/`. This file should stay tiny — it is
//! just plumbing.

mod bootstrap;
mod db;
mod error;
mod event;
mod id;
mod request_log;
mod routes;
mod state;

use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Step 1 — env. `.env` is dev-only; in prod the systemd unit sets vars.
    let _ = dotenvy::dotenv();

    // Step 2 — tracing. RUST_LOG wins; otherwise `info,sqlx=warn,hyper=warn`.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn,hyper=warn")),
        )
        .init();

    // Step 3 — app state (db pool, caches). Stubbed until Phase 2.
    let state = state::AppState::init().await?;

    // Step 4 — router + bind.
    let app = routes::router(state);
    let bind: SocketAddr = std::env::var("REDPASH_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;

    tracing::info!(%bind, "redpash-api listening");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
