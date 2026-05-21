//! `/api/events` — runtime observability log.
//!
//!   GET  /api/events        recent events, newest first
//!                           (filter: `?level=` `?kind=` `?limit=`)
//!   GET  /api/events/:rid   one event
//!   POST /api/events        a frontend-reported event — `origin` is
//!                           forced to `frontend`; `user` / `session`
//!                           are resolved server-side from the
//!                           `rp_session` cookie, never trusted from
//!                           the request body.
//!
//! The two GETs are the internal monitoring read surface — open today
//! (solo / localhost); gate behind the company-admin role when RBAC
//! lands. The POST is the frontend capture funnel.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::event::{Event, EventReport};

use crate::{db, error::AppError, event, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(report))
        .route("/:rid", get(get_one))
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)] level: Option<String>,
    #[serde(default)] kind:  Option<String>,
    #[serde(default)] limit: Option<i64>,
}

#[derive(Serialize)]
struct EventList {
    items: Vec<Event>,
}

/// `GET /api/events` — most-recent-first feed for the monitoring tool.
async fn list(
    State(state): State<AppState>,
    Query(q):     Query<ListQuery>,
) -> Result<Json<EventList>, AppError> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let level = q.level.as_deref().filter(|s| !s.is_empty());
    let kind  = q.kind.as_deref().filter(|s| !s.is_empty());
    let items = db::list_events(&state.db, level, kind, limit)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(EventList { items }))
}

/// `GET /api/events/:rid` — a single event by RID.
async fn get_one(
    State(state): State<AppState>,
    Path(rid):    Path<String>,
) -> Result<Json<Event>, AppError> {
    let ev = db::find_event(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .ok_or_else(|| AppError::not_found("not_found", format!("event {rid}")))?;
    Ok(Json(ev))
}

/// `POST /api/events` — the frontend reports a client-side event (JS
/// error, failed action). Always answers `204` — a logging endpoint
/// must never make the caller retry — and `record` is fire-and-forget,
/// so even an insert failure later is invisible here.
async fn report(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<EventReport>,
) -> StatusCode {
    // Identity is resolved server-side from the session cookie — the
    // client never asserts who it is.
    let session_id = super::read_cookie(&headers, "rp_session");
    let user = match &session_id {
        Some(sid) => db::find_session_user(&state.db, sid).await.ok().flatten(),
        None      => None,
    };
    // Map the client-supplied level onto the fixed set; anything
    // unrecognised becomes `error` so a mislabelled event isn't lost.
    let level: &'static str = match body.level.as_str() {
        "debug" => "debug",
        "info"  => "info",
        "warn"  => "warn",
        _       => "error",
    };
    event::record(&state.db, event::EventDraft {
        origin:     "frontend",
        level,
        kind:       body.kind,
        message:    body.message,
        source:     body.source,
        user,
        session_id,
        request_id: body.request_id,
        context:    body.context.unwrap_or(serde_json::Value::Null),
        ..Default::default()
    });
    StatusCode::NO_CONTENT
}
