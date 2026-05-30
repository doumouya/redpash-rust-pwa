//! Doc: docs/internal/code/backend/api/request_log.md
//! Per-request performance capture — fire-and-forget writes to the
//! `request_log` table.
//!
//! [`record`] persists one row per HTTP request (route, status,
//! latency) WITHOUT blocking the response: it clones the pool (cheap —
//! `Arc` inside) and spawns the INSERT on a detached task. Same rule as
//! `event::record` — the measurement layer must never slow, or fail,
//! the thing it measures.
//!
//! Fed by `routes::capture_mw`. Powers the performance side of the
//! monitoring dashboard.

use sqlx::PgPool;

/// Persist a request's metrics without blocking the caller. The INSERT
/// runs on a detached `tokio` task; a failure is `warn!`-logged and
/// dropped.
///
/// `user_redpash_id` + `session_id` carry the request's identity for
/// per-user / per-session investigations (I-1 / I-7 in the
/// observability investigations doc). Anonymous requests pass `None`.
pub fn record(
    pool:            &PgPool,
    method:          String,
    route:           String,
    status:          i16,
    duration_ms:     i32,
    request_id:      Option<String>,
    user_redpash_id: Option<String>,
    session_id:      Option<String>,
) {
    let pool = pool.clone();
    tokio::spawn(async move {
        let res = sqlx::query(
            "INSERT INTO request_log
                 (method, route, status, duration_ms,
                  request_id, user_redpash_id, session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(method)
        .bind(route)
        .bind(status)
        .bind(duration_ms)
        .bind(request_id)
        .bind(user_redpash_id)
        .bind(session_id)
        .execute(&pool)
        .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "request_log insert failed (non-fatal)");
        }
    });
}

/// Collapse RedPash-ID path segments to `:id` so dynamic routes
/// aggregate — `/api/files/FIL_AB…/page` becomes `/api/files/:id/page`.
pub fn normalize_route(path: &str) -> String {
    path.split('/')
        .map(|seg| if is_redpash_id(seg) { ":id" } else { seg })
        .collect::<Vec<_>>()
        .join("/")
}

/// A RedPash-ID is `<2–4 uppercase letters>_<32 hex digits>`
/// (e.g. `FIL_AB12…`, `PRJ_…`). Used to spot id-bearing path segments.
fn is_redpash_id(seg: &str) -> bool {
    match seg.split_once('_') {
        Some((prefix, hex)) => {
            (2..=4).contains(&prefix.len())
                && prefix.bytes().all(|b| b.is_ascii_uppercase())
                && hex.len() == 32
                && hex.bytes().all(|b| b.is_ascii_hexdigit())
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_route;

    #[test]
    fn collapses_id_segments_only() {
        assert_eq!(
            normalize_route("/api/files/FIL_0123456789ABCDEF0123456789ABCDEF/page"),
            "/api/files/:id/page",
        );
        // no id — untouched.
        assert_eq!(normalize_route("/api/projects"), "/api/projects");
        // a plain word that merely contains an underscore is not an id.
        assert_eq!(normalize_route("/api/dev_login"), "/api/dev_login");
    }
}
