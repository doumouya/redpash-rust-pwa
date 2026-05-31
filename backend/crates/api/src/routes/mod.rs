//! Doc: docs/internal/code/backend/api/routes/mod.md
//! Route assembly.
//!
//! Each resource is its own module (`health`, `files`, …) and exposes a
//! `pub fn routes() -> Router<AppState>` that gets nested under its URL
//! prefix here. Keeping the tree assembled in one place makes the API
//! surface easy to audit.
//!
//! Layers on the `/api` subtree (outermost first):
//!   - request_id_mw    : mint a per-request id, echo it as X-Request-Id
//!   - capture_mw       : persist every 4xx/5xx response as an `event`
//!   - DefaultBodyLimit : 256 MiB so CSV uploads aren't truncated
//! Outer-router layers: TraceLayer, CorsLayer, CompressionLayer.
//!
//! Static frontend assets are served from `../frontend/` so `cargo run`
//! alone is enough to bring the whole app up in dev. In debug builds the
//! static fallback carries `cache-control: no-cache` so edits show up on a
//! normal reload (runbook 0009); release builds leave caching untouched.

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::HeaderValue,
    middleware::Next,
    response::Response,
    Router,
};
#[cfg(debug_assertions)]
use axum::http::header::CACHE_CONTROL;
use std::time::Instant;
#[cfg(debug_assertions)]
use tower::ServiceBuilder;
use tower_http::{
    compression::CompressionLayer,
    cors::CorsLayer,
    services::ServeDir,
    trace::TraceLayer,
};
#[cfg(debug_assertions)]
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::Instrument;

use crate::state::AppState;

mod auth;
mod cases;
mod charts;
mod companies;
mod dashboards;
mod demo;
mod docs;
mod events;
mod files;
mod group;
mod health;
mod admin;
mod me;
mod metrics;
mod monitoring;
mod pagination;
mod projects;
mod search;
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
        ?
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

/// Per-request id. Minted by `request_id_mw`, carried in the request
/// extensions so `capture_mw` can tag events, and echoed back as the
/// `X-Request-Id` response header so the frontend can stamp its own
/// events with the same id — stitching a frontend action to the
/// backend request it triggered.
#[derive(Clone)]
struct RequestId(String);

/// Outermost `/api` middleware — mint a request id, store it in the
/// request extensions, echo it as the `X-Request-Id` response header,
/// AND open a `tracing` span so every log line emitted during the
/// request (handler code, sqlx queries, downstream task logs) inherits
/// `request_id` as a span field. That's the spine of investigation I-2:
/// once a 500 happens, the operator pivots from the events table to the
/// stdout log by grep'ing the request_id — and the stdout lines now
/// carry it because the span context is part of the default fmt output.
async fn request_id_mw(mut req: Request, next: Next) -> Response {
    let rid = format!("req_{}", uuid::Uuid::new_v4().simple());
    req.extensions_mut().insert(RequestId(rid.clone()));

    let span = tracing::info_span!("api", request_id = %rid);
    async move {
        let mut resp = next.run(req).await;
        if let Ok(hv) = HeaderValue::from_str(&rid) {
            resp.headers_mut().insert("x-request-id", hv);
        }
        resp
    }
    .instrument(span)
    .await
}

/// Capture middleware — after the handler runs, persist any 4xx/5xx
/// response as an `event`. `AppError::into_response` stashes an
/// `EventInfo` extension carrying its kind + message; responses without
/// it (Axum's own 404/405, the body-limit 413, `Json`-extractor 400s)
/// are recorded by status alone. `event::record` is fire-and-forget —
/// this never blocks or fails the response it's observing.
async fn capture_mw(
    State(state): State<AppState>,
    req:          Request,
    next:         Next,
) -> Response {
    let method  = req.method().to_string();
    let path    = req.uri().path().to_string();
    let route   = crate::request_log::normalize_route(&path);
    let req_id  = req.extensions().get::<RequestId>().map(|r| r.0.clone());
    let session = read_cookie(req.headers(), "rp_session");

    let started = Instant::now();
    let resp = next.run(req).await;
    let status = resp.status();
    let ms = started.elapsed().as_millis() as i32;

    // Resolve the caller's user_redpash_id from the session cookie. Runs
    // AFTER the response is computed and BEFORE the request_log /
    // event::record fire-and-forget hand-offs, so it adds no latency to
    // the user-facing response — but it does run on every request (pre-
    // market verbose mode). When the lookup proves measurable in prod
    // we'll cache it per session_id at the AppState layer.
    let user = match &session {
        Some(sid) => crate::db::find_session_user(&state.db, sid).await.ok().flatten(),
        None      => None,
    };

    // Every request — fire-and-forget — feeds the performance metrics +
    // per-user / per-session investigations (I-1 / I-7).
    crate::request_log::record(
        &state.db, method.clone(), route, status.as_u16() as i16, ms,
        req_id.clone(), user.clone(), session.clone(),
    );

    if status.as_u16() >= 400 {
        let (err_kind, message, chain_redacted) = match resp.extensions().get::<crate::event::EventInfo>() {
            Some(info) => (Some(info.kind), info.message.clone(), info.chain_redacted.clone()),
            None => (None, status.canonical_reason().unwrap_or("error").to_string(), None),
        };
        let level = if status.as_u16() >= 500 { "error" } else { "warn" };
        // Mirror the redacted chain into events.context.error_chain
        // when AppError carried an inner Report — feeds the Monitoring
        // page's M-4 error-chain expander (slice E). The redactor at
        // the airlock guarantees: length cap + sensitive-key masking.
        let context = match (err_kind, chain_redacted) {
            (Some(k), Some(chain)) => serde_json::json!({ "error_kind": k, "error_chain": chain }),
            (Some(k), None)        => serde_json::json!({ "error_kind": k }),
            (None,    _)           => serde_json::json!({}),
        };
        crate::event::record(&state.db, crate::event::EventDraft {
            origin:      "backend",
            level,
            kind:        "http_error".into(),
            message,
            user,
            session_id:  session,
            request_id:  req_id,
            http_method: Some(method),
            http_path:   Some(path),
            http_status: Some(status.as_u16() as i32),
            duration_ms: Some(ms),
            context,
            ..Default::default()
        });
    }
    resp
}

pub fn router(state: AppState) -> Router {
    // capture_mw needs the pool; `with_state` below consumes `state`, so
    // hand the middleware its own clone.
    let capture_state = state.clone();

    let api = Router::new()
        .nest("/health",   health::routes())
        .nest("/me",       me::routes())
        .nest("/auth",     auth::routes())
        .nest("/projects", projects::routes())
        .nest("/companies",  companies::routes())
        .nest("/files",      files::routes())
        .nest("/group",      group::routes())
        .nest("/cases",      cases::routes())
        .nest("/charts",     charts::routes())
        .nest("/dashboards", dashboards::routes())
        .nest("/users",      users::routes())
        .nest("/events",     events::routes())
        .nest("/metrics",    metrics::routes())
        .nest("/monitoring", monitoring::routes())
        .nest("/admin",      admin::routes())
        .nest("/search",     search::routes())
        .nest("/demo",       demo::routes())
        .nest("/docs",       docs::routes())
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        // capture wraps the body-limit so a 413 is logged too; request_id
        // wraps capture so the id is set before capture reads it.
        .layer(axum::middleware::from_fn_with_state(capture_state, capture_mw))
        .layer(axum::middleware::from_fn(request_id_mw));

    // Dev: serve frontend from the repo. In prod the static files are
    // baked into the binary via `include_dir!` (Phase 5).
    let frontend = ServeDir::new("../frontend").append_index_html_on_directories(true);

    // Runbook 0009: ServeDir ships `last-modified` but no `cache-control`,
    // so browsers apply heuristic freshness and keep serving stale CSS/JS
    // after an edit. `no-cache` lets them keep the copy but forces a
    // conditional GET every time, so ServeDir's existing last-modified/304
    // path makes revalidation cheap while killing the staleness. Debug-only:
    // release builds serve fingerprinted assets and must keep caching them.
    #[cfg(debug_assertions)]
    let frontend = ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(
            CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .service(frontend);

    Router::new()
        .nest("/api", api)
        .fallback_service(frontend)
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}
