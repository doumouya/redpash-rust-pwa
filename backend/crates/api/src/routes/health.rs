//! Doc: docs/internal/code/backend/api/routes/health.md
//! `/api/health` — liveness + (eventually) DB readiness.
//!
//! Phase 1: just `{"status": "ok"}` so the frontend router and any uptime
//! probe can confirm the server boots. Phase 2 adds a `?deep=1` flag that
//! also pings Postgres.

use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn get_health(State(_): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(get_health))
}
