//! Doc: docs/internal/code/backend/api/routes/metrics.md
//! `/api/metrics` — performance read surface over `request_log`.
//!
//!   GET /api/metrics?window=1h|24h|7d|30d   (default 1h)
//!
//! `request_log` captures every /api/* request fire-and-forget. This
//! endpoint is the surfacing layer that turns those rows into a usable
//! shape: total count, error rate, p50/p95/p99 latency over the window,
//! plus the same five numbers per (method, route) ordered by traffic.
//! "How long does a table refresh take" — measured, not felt.
//!
//! Self-observation is filtered out (rows where route starts with
//! `/metrics` — `request_log` stores routes post-`/api` strip, see
//! `request_log::normalize_route` + `capture_mw`'s mount point) so the
//! act of viewing the dashboard doesn't pollute its own data.
//!
//! **Platform-admin-only** (2026-06-03): the `/metrics` nest is gated by
//! `routes::require_platform_admin_mw` (a `from_fn_with_state` layer in
//! routes/mod.rs, mirroring `/monitoring`) — non-admins get a leak-free 404
//! before this handler runs, so no per-handler gate is needed here. `request_log`
//! is tenant-less (no company column), so this is global system observability;
//! per-company metrics would need a `request_log.company_id` column (future).
//! Was anonymously readable before the gate
//! (runbook CAS_CBA057EE46F24BAD897089D2B9DDBDFC-metrics-anon-leak).

use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(metrics))
}

#[derive(Deserialize)]
struct MetricsQuery {
    #[serde(default)]
    window: Option<String>,
}

#[derive(Serialize)]
struct Window {
    label: String,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
}

#[derive(Serialize)]
struct Overall {
    count: i64,
    errors: i64,
    error_rate: f64,
    p50_ms: i64,
    p95_ms: i64,
    p99_ms: i64,
}

#[derive(Serialize)]
struct RouteStats {
    method: String,
    route: String,
    count: i64,
    errors: i64,
    error_rate: f64,
    p50_ms: i64,
    p95_ms: i64,
    p99_ms: i64,
}

#[derive(Serialize)]
struct MetricsResp {
    window: Window,
    overall: Overall,
    by_route: Vec<RouteStats>,
}

async fn metrics(
    State(state): State<AppState>,
    Query(q): Query<MetricsQuery>,
) -> Result<Json<MetricsResp>, AppError> {
    let label = q.window.as_deref().unwrap_or("1h");
    let duration = match label {
        "1h" => Duration::hours(1),
        "24h" => Duration::hours(24),
        "7d" => Duration::days(7),
        "30d" => Duration::days(30),
        _ => {
            return Err(AppError::bad_request(
                "metrics",
                "window must be one of: 1h, 24h, 7d, 30d",
            ))
        }
    };
    let until = Utc::now();
    let since = until - duration;

    // percentile_cont returns DOUBLE PRECISION; cast to BIGINT — request
    // latency is captured as integer ms, so sub-millisecond resolution
    // would be noise. COALESCE handles the empty-window case (no rows →
    // NULL percentile → 0 instead of leaking NULL out the JSON).
    let overall_row = sqlx::query(
        "SELECT
            COUNT(*)::BIGINT                                                                AS total,
            COUNT(*) FILTER (WHERE status >= 400)::BIGINT                                   AS errors,
            COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p50,
            COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p95,
            COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p99
         FROM request_log
         WHERE at >= $1
           AND route NOT LIKE '/metrics%'",
    )
    .bind(since)
    .fetch_one(&state.db)
    .await?;

    let total: i64 = overall_row.try_get("total").unwrap_or(0);
    let errors: i64 = overall_row.try_get("errors").unwrap_or(0);
    let overall = Overall {
        count: total,
        errors,
        error_rate: if total == 0 {
            0.0
        } else {
            errors as f64 / total as f64
        },
        p50_ms: overall_row.try_get("p50").unwrap_or(0),
        p95_ms: overall_row.try_get("p95").unwrap_or(0),
        p99_ms: overall_row.try_get("p99").unwrap_or(0),
    };

    let route_rows = sqlx::query(
        "SELECT
            method,
            route,
            COUNT(*)::BIGINT                                                                AS cnt,
            COUNT(*) FILTER (WHERE status >= 400)::BIGINT                                   AS errs,
            COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p50,
            COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p95,
            COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p99
         FROM request_log
         WHERE at >= $1
           AND route NOT LIKE '/metrics%'
         GROUP BY method, route
         ORDER BY cnt DESC",
    )
    .bind(since)
    .fetch_all(&state.db)
    .await?;

    let by_route: Vec<RouteStats> = route_rows
        .into_iter()
        .map(|r| {
            let cnt: i64 = r.try_get("cnt").unwrap_or(0);
            let errs: i64 = r.try_get("errs").unwrap_or(0);
            RouteStats {
                method: r.try_get("method").unwrap_or_default(),
                route: r.try_get("route").unwrap_or_default(),
                count: cnt,
                errors: errs,
                error_rate: if cnt == 0 {
                    0.0
                } else {
                    errs as f64 / cnt as f64
                },
                p50_ms: r.try_get("p50").unwrap_or(0),
                p95_ms: r.try_get("p95").unwrap_or(0),
                p99_ms: r.try_get("p99").unwrap_or(0),
            }
        })
        .collect();

    Ok(Json(MetricsResp {
        window: Window {
            label: label.to_string(),
            since,
            until,
        },
        overall,
        by_route,
    }))
}
