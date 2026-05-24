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

    // Step 2 — tracing. RUST_LOG wins; otherwise the pre-market verbose
    // default: `info` on our crates + tower_http (so request_id-bearing
    // spans + per-request access logs surface) + `sqlx=info` (every query
    // logged for I-5 / I-2 investigation paths) + `hyper=warn` (hyper's
    // own info is too chatty to be useful). Tighten before market.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,sqlx=info,hyper=warn,tower_http=info")),
        )
        .init();

    // Step 3 — app state (db pool, caches). Stubbed until Phase 2.
    let state = state::AppState::init().await?;

    // Step 4 — process-level panic hook. Records every panic into the
    // `events` table (kind="panic", level="error") so background-task
    // failures aren't invisible. Investigation I-8 in the observability
    // doc — without this hook, a tokio task that panics logs to stderr
    // and disappears. The default hook is preserved (stderr backtrace +
    // thread name) by calling it first.
    {
        let pool = state.db.clone();
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            default_hook(info);
            let payload = info.payload().downcast_ref::<&'static str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic (non-string payload)".to_string());
            let location = info.location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown".to_string());
            // event::record spawns onto the current tokio runtime — works
            // from a panicking task. A boot-time panic before the runtime
            // is up skips the DB write (no runtime to spawn on) and
            // falls through to the default hook's stderr output.
            if tokio::runtime::Handle::try_current().is_ok() {
                event::record(&pool, event::EventDraft {
                    origin:  "backend",
                    level:   "error",
                    kind:    "panic".into(),
                    message: payload,
                    context: serde_json::json!({ "location": location }),
                    ..Default::default()
                });
            }
        }));
    }

    // Step 5 — router + bind.
    let app = routes::router(state);
    let bind: SocketAddr = std::env::var("REDPASH_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;

    tracing::info!(%bind, "redpash-api listening");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
