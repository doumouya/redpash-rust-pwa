//! Doc: docs/internal/code/backend/shared/event.md
//! Event DTOs — the runtime observability log.
//!
//! `Event` is the persisted record (one `events` row). `EventReport`
//! is the slimmer body the frontend POSTs to `/api/events` — identity
//! (`user` / `session`) is stamped server-side from the request cookie,
//! never trusted from the client, and `origin` is forced to `frontend`.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub redpash_id:  String,
    pub occurred_at: DateTime<Utc>,
    /// `backend` | `frontend` — where the event was captured.
    pub origin:      String,
    /// `debug` | `info` | `warn` | `error`.
    pub level:       String,
    /// Machine-readable type — `http_error`, `auth_login`, `step_apply`, …
    pub kind:        String,
    pub message:     String,
    /// Emitting site — `routes::files::upload`, `cleaner.js#applyStep`, …
    #[serde(default)] pub source:          Option<String>,
    #[serde(default)] pub user_redpash_id: Option<String>,
    /// `rp_session` RID — groups a login-to-logout span.
    #[serde(default)] pub session_id:      Option<String>,
    /// Correlates every event from one request, frontend + backend.
    #[serde(default)] pub request_id:      Option<String>,
    #[serde(default)] pub http_method:     Option<String>,
    #[serde(default)] pub http_path:       Option<String>,
    #[serde(default)] pub http_status:     Option<i32>,
    #[serde(default)] pub duration_ms:     Option<i32>,
    /// Free-form structured payload — error kind, rid involved, params.
    pub context:     serde_json::Value,
}

/// Body of `POST /api/events`. The frontend supplies only the event's
/// own fields; `origin`, `user_redpash_id` and `session_id` are filled
/// server-side.
#[derive(Debug, Clone, Deserialize)]
pub struct EventReport {
    pub level:   String,
    pub kind:    String,
    pub message: String,
    #[serde(default)] pub source:     Option<String>,
    #[serde(default)] pub request_id: Option<String>,
    #[serde(default)] pub context:    Option<serde_json::Value>,
}
