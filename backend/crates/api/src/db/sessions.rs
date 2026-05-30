//! Doc: docs/internal/code/backend/api/db/sessions.md
//! Session-row helpers — the `sessions` table holding the cookie
//! → user-rid mapping. The auth flow creates a row on login,
//! the request middleware reads it on every authed call, the
//! logout flow deletes it.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

pub async fn create_session(pool: &PgPool, user_rid: &str, ttl_days: i64) -> sqlx::Result<String> {
    let sid = crate::id::new("SES");
    sqlx::query(
        "INSERT INTO sessions (redpash_id, user_redpash_id, expires_at)
         VALUES ($1, $2, now() + ($3 || ' days')::interval)",
    )
    .bind(&sid)
    .bind(user_rid)
    .bind(ttl_days.to_string())
    .execute(pool)
    .await?;
    Ok(sid)
}

/// Returns the user RID for a session if it exists and hasn't expired.
/// Auto-deletes the row if expired (cheap cleanup on the read path).
pub async fn find_session_user(pool: &PgPool, sid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT user_redpash_id, expires_at FROM sessions WHERE redpash_id = $1",
    )
    .bind(sid)
    .fetch_optional(pool)
    .await?;
    let Some((user_rid, expires_at)) = row else { return Ok(None); };
    if expires_at < Utc::now() {
        let _ = sqlx::query("DELETE FROM sessions WHERE redpash_id = $1")
            .bind(sid)
            .execute(pool)
            .await;
        return Ok(None);
    }
    Ok(Some(user_rid))
}

pub async fn delete_session(pool: &PgPool, sid: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE redpash_id = $1")
        .bind(sid)
        .execute(pool)
        .await?;
    Ok(())
}
