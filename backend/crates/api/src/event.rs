//! Purpose: fire-and-forget audit/observability events. The absolute rule: the
//! observability layer must never slow down — or fail — the thing it observes.
//! Every record() detaches onto a tokio task; insert failures are warn-logged
//! and swallowed. Writes to the partitioned `events` table.
//!
//! (Minimal port — the request_log middleware + the error-airlock Channel B
//! wiring land with the rest of the observability spine.)

use sqlx::PgPool;

use crate::id;

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// Record an event without blocking the request. Detaches; never propagates an
/// error to the caller.
pub fn record(
    pool: &PgPool,
    kind: impl Into<String>,
    level: Level,
    message: impl Into<String>,
    user: Option<String>,
    context: serde_json::Value,
) {
    let pool = pool.clone();
    let (kind, message) = (kind.into(), message.into());
    tokio::spawn(async move {
        let res = sqlx::query(
            "INSERT INTO events (id, kind, level, message, user_id, context)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id::new("EVT"))
        .bind(&kind)
        .bind(level.as_str())
        .bind(&message)
        .bind(user)
        .bind(context)
        .execute(&pool)
        .await;
        if let Err(e) = res {
            tracing::warn!(%kind, error = %e, "event insert failed (swallowed)");
        }
    });
}

pub fn info(pool: &PgPool, kind: impl Into<String>, message: impl Into<String>, user: Option<String>, context: serde_json::Value) {
    record(pool, kind, Level::Info, message, user, context);
}

pub fn warn(pool: &PgPool, kind: impl Into<String>, message: impl Into<String>, user: Option<String>, context: serde_json::Value) {
    record(pool, kind, Level::Warn, message, user, context);
}
