//! Purpose: the axum edge — a thin shell over the api lib.
//! Surface: health (liveness + ?deep=1 DB readiness), auth, /api/me, the file
//! data-work flow (upload/page/clean/sql/joins/export), group preview, and the
//! generic object registry — all behind the CSRF origin guard.

use axum::{
    extract::{DefaultBodyLimit, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use tower::Layer;
use tower_http::services::{ServeDir, ServeFile};

use api::{
    admin, auth, cases, designer, files, group, me, middleware, monitoring, objects, projects, rail,
    search, settings, state::AppState, types,
};

#[tokio::main]
async fn main() -> eyre::Result<()> {
    // Load backend/.env (DATABASE_URL, REDPASH_BIND, dev-login) before anything
    // reads the environment — AppState::init reads DATABASE_URL below. Best-effort:
    // a missing file is fine when the vars are already exported. Mirrors the
    // predecessor's main.rs (the port had dropped this line).
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt().json().flatten_event(true).init();

    let state = AppState::init().await?;

    let api_router = Router::new()
        .route("/health", get(health))
        .nest("/auth", auth::routes())
        .nest("/cases", cases::routes())
        .nest("/charts", designer::chart_routes())
        .nest("/dashboards", designer::dashboard_routes())
        .nest("/me", me::routes())
        .nest("/monitoring", monitoring::routes())
        .nest("/files", files::routes())
        .nest("/group", group::routes())
        .nest("/objects", objects::routes())
        .nest("/projects", projects::routes())
        .nest("/rail", rail::routes())
        .nest("/search", search::routes())
        .nest("/settings", settings::routes())
        .nest("/types", types::routes())
        .nest("/admin", admin::routes())
        // CSRF origin guard on state-changing methods (defense-in-depth over
        // SameSite=Lax). from_fn_with_state so it sees the allowlist.
        .layer(axum::middleware::from_fn_with_state(state.clone(), middleware::origin_guard))
        // 256 MiB upload cap (well above Salesforce's 100 MB CSV import).
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024));

    // Static frontend: one binary serves API + UI. Cache policy (day-one #7
    // + S8): the BASE is `no-store` so un-hashed assets (dev source, and the
    // release entry points: index.html / partials / the SW) are never cached —
    // ServeDir sends no ETag, and bare `no-cache` lets browsers heuristically
    // serve stale dev JS (the recurring preview pain). Content-hashed assets
    // (build-fe.sh / build-wasm.sh names) are then UPGRADED to immutable by the
    // immutable_for_hashed layer below — the hash IS the cache version. Point
    // REDPASH_FRONTEND_DIR at frontend-dist (build-fe.sh output) for the release
    // tree; the dev default (../frontend) is fully uncacheable, so edits always
    // show on the next load.
    let fe_dir = std::env::var("REDPASH_FRONTEND_DIR").unwrap_or_else(|_| "../frontend".into());
    let static_svc = ServeDir::new(&fe_dir)
        .fallback(ServeFile::new(format!("{fe_dir}/index.html")));
    let static_svc = tower_http::set_header::SetResponseHeaderLayer::if_not_present(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    )
    .layer(static_svc);

    let app = Router::new()
        .nest("/api", api_router)
        .fallback_service(static_svc)
        // Path-shape guarded: only name.<hex>.{js,css,wasm} is upgraded, so
        // API responses and entry points pass through untouched.
        .layer(axum::middleware::from_fn(middleware::immutable_for_hashed))
        .with_state(state);

    // Day-one #10 posture: default bind is LOOPBACK; exposing beyond
    // localhost is an explicit override, never a default.
    let bind = std::env::var("REDPASH_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[derive(Deserialize)]
struct HealthQuery {
    /// String so `?deep=1` and `?deep` both work (serde_urlencoded can't parse
    /// "1" as a bool). Enabled unless explicitly "0"/"false".
    #[serde(default)]
    deep: Option<String>,
}

/// GET /api/health — liveness (status+version); ?deep=1 also pings Postgres so
/// an uptime probe can detect a dead DB (the predecessor planned this and never
/// built it).
async fn health(State(state): State<AppState>, Query(q): Query<HealthQuery>) -> Json<serde_json::Value> {
    let deep = matches!(q.deep.as_deref(), Some(v) if v != "0" && !v.eq_ignore_ascii_case("false"));
    let mut body = serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") });
    if deep {
        let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.db).await.is_ok();
        body["db"] = serde_json::json!(if db_ok { "ok" } else { "down" });
        if !db_ok {
            body["status"] = serde_json::json!("degraded");
        }
    }
    Json(body)
}
