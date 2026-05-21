//! Runtime event capture — fire-and-forget writes to the `events` table.
//!
//! `record(pool, draft)` persists an event WITHOUT blocking the caller:
//! it clones the pool (cheap — `Arc` inside) and spawns the INSERT on a
//! detached task. A failed insert is logged and swallowed. The rule is
//! absolute — the observability layer must never slow down, or fail,
//! the thing it observes.
//!
//! Two capture paths feed this:
//!   - the `routes::mod::capture_mw` middleware — every 4xx/5xx response;
//!   - explicit `event::record(...)` calls — notable lifecycle actions
//!     (login, upload, step apply, …) and the frontend `POST /api/events`.

use serde_json::Value;
use sqlx::PgPool;

/// A draft event to persist. Build one, hand it to [`record`].
///
/// `origin` / `level` are `&'static str` — every call site passes a
/// literal (the frontend-report handler maps its runtime string onto
/// the fixed set first). Everything else is owned so the draft can move
/// into the detached insert task.
#[derive(Debug, Clone, Default)]
pub struct EventDraft {
    pub origin:      &'static str,   // "backend" | "frontend"
    pub level:       &'static str,   // "debug" | "info" | "warn" | "error"
    pub kind:        String,
    pub message:     String,
    pub source:      Option<String>,
    pub user:        Option<String>,
    pub session_id:  Option<String>,
    pub request_id:  Option<String>,
    pub http_method: Option<String>,
    pub http_path:   Option<String>,
    pub http_status: Option<i32>,
    pub duration_ms: Option<i32>,
    pub context:     Value,
}

/// Persist `draft` without blocking the caller. The INSERT runs on a
/// detached `tokio` task; a failure is `warn!`-logged and dropped.
pub fn record(pool: &PgPool, draft: EventDraft) {
    let pool = pool.clone();
    tokio::spawn(async move {
        let rid = crate::id::new("EVT");
        // The column defaults to '{}'; a null payload would violate NOT NULL.
        let context = if draft.context.is_null() {
            serde_json::json!({})
        } else {
            draft.context
        };
        let res = sqlx::query(
            "INSERT INTO events
                 (redpash_id, origin, level, kind, message, source,
                  user_redpash_id, session_id, request_id,
                  http_method, http_path, http_status, duration_ms, context)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        )
        .bind(rid.as_str())
        .bind(draft.origin)
        .bind(draft.level)
        .bind(draft.kind.as_str())
        .bind(draft.message.as_str())
        .bind(draft.source.as_deref())
        .bind(draft.user.as_deref())
        .bind(draft.session_id.as_deref())
        .bind(draft.request_id.as_deref())
        .bind(draft.http_method.as_deref())
        .bind(draft.http_path.as_deref())
        .bind(draft.http_status)
        .bind(draft.duration_ms)
        .bind(context)
        .execute(&pool)
        .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "event insert failed (non-fatal)");
        }
    });
}

/// Stashed in an error `Response`'s extensions by `AppError::into_response`
/// so the capture middleware can read the error's kind + message after
/// the handler has returned (the `AppError` itself is long gone by then).
#[derive(Debug, Clone)]
pub struct EventInfo {
    pub kind:    &'static str,
    pub message: String,
}
