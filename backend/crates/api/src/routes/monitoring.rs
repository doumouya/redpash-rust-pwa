//! `/api/monitoring` — read surface for the `/monitoring` page.
//!
//!   GET /api/monitoring/events?page&size&window&level&kind
//!   GET /api/monitoring/audit-runs?page&size&tool
//!   GET /api/monitoring/audit-findings?page&size&run&tool&kind
//!   GET /api/monitoring/requests?page&size&window&route&status&method
//!   GET /api/monitoring/requests/stats?window
//!   GET   /api/monitoring/optimization-points?page&size&subsystem&status
//!   PATCH /api/monitoring/optimization-points/:rid     (status flip)
//!   GET /api/monitoring/events/stats?window=
//!   GET /api/monitoring/audit-runs/stats
//!   GET /api/monitoring/audit-findings/stats
//!
//! All three return `Page<T>` — same shape as `/api/files/:rid/page`
//! so the redtable on the monitoring tabs reuses the existing reader.
//! Window values mirror `/api/metrics`: `1h`, `24h`, `7d`, `30d`.
//!
//! Wire contract: `docs/internal/admin-monitoring-surfaces.md §6`.
//! Open today (solo / localhost); gate behind the company-admin role
//! when RBAC lands. Mirrors events.rs's posture.

use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    routing::{get, patch},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use shared::{
    monitoring::{
        AuditFindingSummary, AuditFindingsStats, AuditRunSummary, AuditRunsStats,
        EventSummary, EventsStats, LatencyBucket,
        RequestDetail, RequestSummary, RequestsStats, RouteStat, UserActivity, Window,
    },
    optimization::OptimizationPoint,
    Page,
};
use std::collections::HashMap;
use sqlx::Row;

use crate::{db, error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/events",                get(list_events))
        .route("/events/stats",          get(stats_events))
        .route("/audit-runs",            get(list_audit_runs))
        .route("/audit-runs/stats",      get(stats_audit_runs))
        .route("/audit-findings",        get(list_audit_findings))
        .route("/audit-findings/stats",  get(stats_audit_findings))
        .route("/requests",            get(list_requests))
        .route("/requests/stats",      get(stats_requests))
        // Per-request drill-down (M-1, slice E). Singular path so it
        // can't collide with /requests/stats — :request_id is opaque
        // to axum's matcher and would otherwise swallow "stats".
        .route("/request/:request_id", get(request_detail))
        // Per-user investigation feed (M-2, slice E).
        .route("/users/:user_rid/activity", get(user_activity))
        .route("/optimization-points",      get(list_optimization_points))
        .route("/optimization-points/:rid", patch(patch_optimization_point))
}

// ── shared query plumbing ───────────────────────────────────────────────

use super::pagination::{build_page, paginate};

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)] page:   Option<u32>,
    #[serde(default)] size:   Option<u32>,
    #[serde(default)] window: Option<String>,
    #[serde(default)] level:  Option<String>,
    #[serde(default)] kind:   Option<String>,
    /// Free-text search across kind + message. ILIKE substring match.
    #[serde(default)] q:      Option<String>,
}

#[derive(Deserialize)]
struct AuditRunsQuery {
    #[serde(default)] page: Option<u32>,
    #[serde(default)] size: Option<u32>,
    #[serde(default)] tool: Option<String>,
    /// Free-text search across tool + git_branch + git_sha. ILIKE
    /// substring; sha can be partial (e.g. "abc12" matches).
    #[serde(default)] q:    Option<String>,
}

#[derive(Deserialize)]
struct AuditFindingsQuery {
    #[serde(default)] page: Option<u32>,
    #[serde(default)] size: Option<u32>,
    #[serde(default)] run:  Option<i64>,
    #[serde(default)] tool: Option<String>,
    #[serde(default)] kind: Option<String>,
    /// Free-text search across tool + kind + finding_key. ILIKE substring.
    #[serde(default)] q:    Option<String>,
}

/// Resolve `?window=` to a UTC cutoff. `None` means "no window filter".
/// Bad value → `AppError::bad_request` matching the /api/metrics surface.
fn window_cutoff(w: Option<&str>) -> Result<Option<DateTime<Utc>>, AppError> {
    let Some(label) = w else { return Ok(None) };
    let dur = match label {
        "1h"  => Duration::hours(1),
        "24h" => Duration::hours(24),
        "7d"  => Duration::days(7),
        "30d" => Duration::days(30),
        _ => {
            return Err(AppError::bad_request(
                "monitoring",
                "window must be one of: 1h, 24h, 7d, 30d",
            ))
        }
    };
    Ok(Some(Utc::now() - dur))
}

/// SQL interval per window label — targets ~24-30 buckets across any
/// window so a smooth-line chart reads clean at any zoom. Returns a
/// string that Postgres's `date_bin($interval::interval, ...)` parses
/// directly. Same window vocabulary as `window_cutoff`.
fn bucket_interval(label: &str) -> &'static str {
    match label {
        "1h"  => "2 minutes",   //  ~30 buckets
        "24h" => "1 hour",      //  24 buckets
        "7d"  => "6 hours",     //  28 buckets
        "30d" => "1 day",       //  30 buckets
        _     => "1 hour",      //  defensive; window_cutoff already 400s anything else
    }
}


// ── /api/monitoring/events ──────────────────────────────────────────────

async fn list_events(
    State(state): State<AppState>,
    Query(q):     Query<EventsQuery>,
) -> Result<Json<Page<EventSummary>>, AppError> {
    let started = Instant::now();
    let cutoff = window_cutoff(q.window.as_deref())?;
    let (offset, size, page) = paginate(q.page, q.size);

    // Pre-filter total ("all rows ever") — useful to show "showing X of N
    // events ever logged" alongside the windowed/filtered total.
    let all_count: i64 = db::count_total(&state.db, "events").await?;

    // Post-filter total + the page rows. Three optional filters
    // (window, level, kind) folded into a single SQL via the
    // `$N::T IS NULL OR …` trick so we avoid building dynamic SQL.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM events
         WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
           AND ($2::text IS NULL OR level = $2)
           AND ($3::text IS NULL OR kind  = $3)
           AND ($4::text IS NULL OR
                kind    ILIKE '%' || $4 || '%' OR
                message ILIKE '%' || $4 || '%')",
    )
    .bind(cutoff)
    .bind(q.level.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows = sqlx::query(
        "SELECT redpash_id, occurred_at, origin, level, kind, message,
                http_status, request_id
           FROM events
          WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
            AND ($2::text IS NULL OR level = $2)
            AND ($3::text IS NULL OR kind  = $3)
            AND ($4::text IS NULL OR
                 kind    ILIKE '%' || $4 || '%' OR
                 message ILIKE '%' || $4 || '%')
          ORDER BY occurred_at DESC
          LIMIT $5 OFFSET $6",
    )
    .bind(cutoff)
    .bind(q.level.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<EventSummary> = rows
        .into_iter()
        .map(|r| EventSummary {
            redpash_id:  r.try_get("redpash_id").unwrap_or_default(),
            occurred_at: r.try_get("occurred_at").unwrap_or_else(|_| Utc::now()),
            origin:      r.try_get("origin").unwrap_or_default(),
            level:       r.try_get("level").unwrap_or_default(),
            kind:        r.try_get("kind").unwrap_or_default(),
            message:     r.try_get("message").unwrap_or_default(),
            http_status: r.try_get("http_status").ok(),
            request_id:  r.try_get("request_id").ok(),
        })
        .collect();

    Ok(Json(build_page(
        rows,
        total as u64,
        all_count as u64,
        page,
        size,
        started,
    )))
}

// ── /api/monitoring/audit-runs ──────────────────────────────────────────

async fn list_audit_runs(
    State(state): State<AppState>,
    Query(q):     Query<AuditRunsQuery>,
) -> Result<Json<Page<AuditRunSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = db::count_total(&state.db, "audit.run").await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.run
         WHERE ($1::text IS NULL OR tool = $1)
           AND ($2::text IS NULL OR
                tool                  ILIKE '%' || $2 || '%' OR
                COALESCE(git_branch, '') ILIKE '%' || $2 || '%' OR
                COALESCE(git_sha,    '') ILIKE '%' || $2 || '%')",
    )
    .bind(q.tool.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows = sqlx::query(
        "SELECT id, tool, ran_at, git_sha, git_branch, stats
           FROM audit.run
          WHERE ($1::text IS NULL OR tool = $1)
            AND ($2::text IS NULL OR
                 tool                  ILIKE '%' || $2 || '%' OR
                 COALESCE(git_branch, '') ILIKE '%' || $2 || '%' OR
                 COALESCE(git_sha,    '') ILIKE '%' || $2 || '%')
          ORDER BY ran_at DESC
          LIMIT $3 OFFSET $4",
    )
    .bind(q.tool.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<AuditRunSummary> = rows
        .into_iter()
        .map(|r| AuditRunSummary {
            id:         r.try_get("id").unwrap_or(0),
            tool:       r.try_get("tool").unwrap_or_default(),
            ran_at:     r.try_get("ran_at").unwrap_or_else(|_| Utc::now()),
            git_sha:    r.try_get("git_sha").ok(),
            git_branch: r.try_get("git_branch").ok(),
            stats:      r.try_get("stats").unwrap_or(serde_json::Value::Null),
        })
        .collect();

    Ok(Json(build_page(
        rows,
        total as u64,
        all_count as u64,
        page,
        size,
        started,
    )))
}

// ── /api/monitoring/audit-findings ──────────────────────────────────────

async fn list_audit_findings(
    State(state): State<AppState>,
    Query(q):     Query<AuditFindingsQuery>,
) -> Result<Json<Page<AuditFindingSummary>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    // If `?run=` isn't set, default to the most-recent run per tool so
    // the page loads useful data on first visit (instead of N runs of
    // findings interleaved with no clear order). Caller can pass an
    // explicit run id to see older runs.
    let run_filter: Option<i64> = if let Some(r) = q.run {
        Some(r)
    } else {
        sqlx::query_scalar(
            "SELECT id FROM audit.run
              WHERE ($1::text IS NULL OR tool = $1)
              ORDER BY ran_at DESC
              LIMIT 1",
        )
        .bind(q.tool.as_deref())
        .fetch_optional(&state.db)
        .await?
    };

    let all_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.finding",
    )
    .fetch_one(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.finding
         WHERE ($1::bigint IS NULL OR run_id = $1)
           AND ($2::text IS NULL OR tool = $2)
           AND ($3::text IS NULL OR kind = $3)
           AND ($4::text IS NULL OR
                tool        ILIKE '%' || $4 || '%' OR
                kind        ILIKE '%' || $4 || '%' OR
                finding_key ILIKE '%' || $4 || '%')",
    )
    .bind(run_filter)
    .bind(q.tool.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows = sqlx::query(
        "SELECT run_id, tool, kind, finding_key, severity
           FROM audit.finding
          WHERE ($1::bigint IS NULL OR run_id = $1)
            AND ($2::text IS NULL OR tool = $2)
            AND ($3::text IS NULL OR kind = $3)
            AND ($4::text IS NULL OR
                 tool        ILIKE '%' || $4 || '%' OR
                 kind        ILIKE '%' || $4 || '%' OR
                 finding_key ILIKE '%' || $4 || '%')
          ORDER BY run_id DESC, severity DESC NULLS LAST, finding_key
          LIMIT $5 OFFSET $6",
    )
    .bind(run_filter)
    .bind(q.tool.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<AuditFindingSummary> = rows
        .into_iter()
        .map(|r| AuditFindingSummary {
            run_id:      r.try_get("run_id").unwrap_or(0),
            tool:        r.try_get("tool").unwrap_or_default(),
            kind:        r.try_get("kind").unwrap_or_default(),
            finding_key: r.try_get("finding_key").unwrap_or_default(),
            severity:    r.try_get("severity").ok(),
        })
        .collect();

    Ok(Json(build_page(
        rows,
        total as u64,
        all_count as u64,
        page,
        size,
        started,
    )))
}

// ── /api/monitoring/requests ────────────────────────────────────────────

#[derive(Deserialize)]
struct RequestsQuery {
    #[serde(default)] page:   Option<u32>,
    #[serde(default)] size:   Option<u32>,
    #[serde(default)] window: Option<String>,
    /// Substring match on the normalized route (post-`/api`-strip).
    /// `?route=/projects` matches `/projects`, `/projects/:id`, etc.
    #[serde(default)] route:  Option<String>,
    /// Exact status filter (e.g. `?status=401`) — keeps it simple; if
    /// the UI needs 2xx/3xx/4xx/5xx banding, it filters status_mix
    /// from the stats endpoint.
    #[serde(default)] status: Option<i16>,
    #[serde(default)] method: Option<String>,
    /// Free-text search across route + method + status (as text). ILIKE
    /// substring match — feeds the toolbar search box on /monitoring/requests
    /// (same shape as events / runs / findings / steps' ?q=).
    #[serde(default)] q:      Option<String>,
}

async fn list_requests(
    State(state): State<AppState>,
    Query(q):     Query<RequestsQuery>,
) -> Result<Json<Page<RequestSummary>>, AppError> {
    let started = Instant::now();
    let cutoff = window_cutoff(q.window.as_deref())?;
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = db::count_total(&state.db, "request_log").await?;

    // /api/monitoring/* itself is filtered out so the operator's act
    // of viewing the dashboard doesn't pollute its own table —
    // matches the /api/metrics convention. Stored routes are
    // post-`/api`-strip (capture_mw mounts on the nested router).
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM request_log
          WHERE ($1::timestamptz IS NULL OR at >= $1)
            AND route NOT LIKE '/monitoring%'
            AND ($2::text  IS NULL OR route  ILIKE '%' || $2 || '%')
            AND ($3::int2  IS NULL OR status = $3)
            AND ($4::text  IS NULL OR method = $4)
            AND ($5::text  IS NULL OR (
                  route        ILIKE '%' || $5 || '%' OR
                  method       ILIKE '%' || $5 || '%' OR
                  status::text ILIKE '%' || $5 || '%'))",
    )
    .bind(cutoff)
    .bind(q.route.as_deref())
    .bind(q.status)
    .bind(q.method.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows = sqlx::query(
        "SELECT id, at, method, route, status, duration_ms, request_id
           FROM request_log
          WHERE ($1::timestamptz IS NULL OR at >= $1)
            AND route NOT LIKE '/monitoring%'
            AND ($2::text  IS NULL OR route  ILIKE '%' || $2 || '%')
            AND ($3::int2  IS NULL OR status = $3)
            AND ($4::text  IS NULL OR method = $4)
            AND ($5::text  IS NULL OR (
                  route        ILIKE '%' || $5 || '%' OR
                  method       ILIKE '%' || $5 || '%' OR
                  status::text ILIKE '%' || $5 || '%'))
          ORDER BY at DESC
          LIMIT $6 OFFSET $7",
    )
    .bind(cutoff)
    .bind(q.route.as_deref())
    .bind(q.status)
    .bind(q.method.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let rows: Vec<RequestSummary> = rows
        .into_iter()
        .map(|r| RequestSummary {
            id:          r.try_get("id").unwrap_or(0),
            at:          r.try_get("at").unwrap_or_else(|_| Utc::now()),
            method:      r.try_get("method").unwrap_or_default(),
            route:       r.try_get("route").unwrap_or_default(),
            status:      r.try_get("status").unwrap_or(0),
            duration_ms: r.try_get("duration_ms").unwrap_or(0),
            request_id:  r.try_get("request_id").ok(),
        })
        .collect();

    Ok(Json(build_page(
        rows,
        total as u64,
        all_count as u64,
        page,
        size,
        started,
    )))
}

// ── /api/monitoring/requests/stats ──────────────────────────────────────

#[derive(Deserialize)]
struct RequestsStatsQuery {
    #[serde(default)] window: Option<String>,
}

async fn stats_requests(
    State(state): State<AppState>,
    Query(q):     Query<RequestsStatsQuery>,
) -> Result<Json<RequestsStats>, AppError> {
    let label = q.window.as_deref().unwrap_or("24h").to_string();
    let cutoff = window_cutoff(Some(&label))?
        .expect("window_cutoff returns Some for non-None input");
    let until = Utc::now();

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM request_log
          WHERE at >= $1
            AND route NOT LIKE '/monitoring%'",
    )
    .bind(cutoff)
    .fetch_one(&state.db)
    .await?;

    let mix_rows = sqlx::query(
        "SELECT status::TEXT AS status_str, COUNT(*)::BIGINT AS cnt
           FROM request_log
          WHERE at >= $1
            AND route NOT LIKE '/monitoring%'
          GROUP BY status",
    )
    .bind(cutoff)
    .fetch_all(&state.db)
    .await?;

    let mut status_mix: HashMap<String, u64> = HashMap::with_capacity(mix_rows.len());
    for r in mix_rows {
        let s: String = r.try_get("status_str").unwrap_or_default();
        let c: i64    = r.try_get("cnt").unwrap_or(0);
        if !s.is_empty() {
            status_mix.insert(s, c as u64);
        }
    }

    // Top routes by p95 — same percentile_cont path as /api/metrics,
    // sorted by the p95 column descending, capped at 10. Tie-break by
    // count descending so a 0ms route doesn't outrank a busy one.
    let route_rows = sqlx::query(
        "SELECT method, route,
                COUNT(*)::BIGINT                                                              AS cnt,
                COUNT(*) FILTER (WHERE status >= 400)::BIGINT                                 AS errs,
                COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT AS p50,
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT AS p95,
                COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT AS p99
           FROM request_log
          WHERE at >= $1
            AND route NOT LIKE '/monitoring%'
          GROUP BY method, route
          ORDER BY p95 DESC, cnt DESC
          LIMIT 10",
    )
    .bind(cutoff)
    .fetch_all(&state.db)
    .await?;

    let top_routes: Vec<RouteStat> = route_rows
        .into_iter()
        .map(|r| {
            let cnt:  i64 = r.try_get("cnt").unwrap_or(0);
            let errs: i64 = r.try_get("errs").unwrap_or(0);
            RouteStat {
                method:     r.try_get("method").unwrap_or_default(),
                route:      r.try_get("route").unwrap_or_default(),
                count:      cnt as u64,
                p50_ms:     r.try_get("p50").unwrap_or(0),
                p95_ms:     r.try_get("p95").unwrap_or(0),
                p99_ms:     r.try_get("p99").unwrap_or(0),
                error_rate: if cnt == 0 { 0.0 } else { errs as f64 / cnt as f64 },
            }
        })
        .collect();

    // Latency-over-time buckets (~24-30 points across the window).
    // `date_bin` is Postgres-14+ and lands the bucket on a clean clock
    // origin (2000-01-01) so consecutive windows align identically.
    // Empty buckets are omitted; frontend gap-fills if its chart kind
    // needs continuous x.
    let bucket_rows = sqlx::query(
        "SELECT date_bin($1::interval, at, TIMESTAMPTZ '2000-01-01') AS ts,
                COUNT(*)::BIGINT                                                                AS cnt,
                COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p50,
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p95,
                COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms), 0)::BIGINT  AS p99
           FROM request_log
          WHERE at >= $2
            AND route NOT LIKE '/monitoring%'
          GROUP BY ts
          ORDER BY ts",
    )
    .bind(bucket_interval(&label))
    .bind(cutoff)
    .fetch_all(&state.db)
    .await?;

    let buckets: Vec<LatencyBucket> = bucket_rows
        .into_iter()
        .map(|r| {
            let cnt: i64 = r.try_get("cnt").unwrap_or(0);
            LatencyBucket {
                ts:     r.try_get("ts").unwrap_or_else(|_| Utc::now()),
                count:  cnt as u64,
                p50_ms: r.try_get("p50").unwrap_or(0),
                p95_ms: r.try_get("p95").unwrap_or(0),
                p99_ms: r.try_get("p99").unwrap_or(0),
            }
        })
        .collect();

    Ok(Json(RequestsStats {
        window: Window {
            label,
            since: cutoff,
            until,
        },
        total: total as u64,
        status_mix,
        top_routes,
        buckets,
    }))
}

// ── /api/monitoring/events/stats ────────────────────────────────────────

#[derive(Deserialize)]
struct EventsStatsQuery {
    #[serde(default)] window: Option<String>,
}

/// `GET /api/monitoring/events/stats?window=` — single-shape aggregate
/// for the Events tab KPI strip: total + level distribution + last-24h
/// count. Window narrows total + by_level; last_24h is always fixed
/// at 24h regardless. Shape parallels `/api/admin/*/stats`.
async fn stats_events(
    State(state): State<AppState>,
    Query(q):     Query<EventsStatsQuery>,
) -> Result<Json<EventsStats>, AppError> {
    let cutoff = window_cutoff(q.window.as_deref())?;

    let total: i64 = if let Some(c) = cutoff {
        sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM events WHERE occurred_at >= $1")
            .bind(c)
            .fetch_one(&state.db).await?
    } else {
        db::count_total(&state.db, "events").await?
    };

    let by_level_query = if cutoff.is_some() {
        "SELECT level, COUNT(*)::BIGINT FROM events WHERE occurred_at >= $1 GROUP BY level"
    } else {
        "SELECT level, COUNT(*)::BIGINT FROM events GROUP BY level"
    };
    let by_level = if let Some(c) = cutoff {
        let rows = sqlx::query(by_level_query).bind(c)
            .fetch_all(&state.db).await?;
        let mut out = HashMap::with_capacity(rows.len());
        for r in rows {
            let k: String = r.try_get(0).unwrap_or_default();
            let c: i64    = r.try_get(1).unwrap_or(0);
            if !k.is_empty() { out.insert(k, c as u64); }
        }
        out
    } else {
        crate::routes::admin::group_count(&state.db, by_level_query).await?
    };

    let last_24h: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM events WHERE occurred_at >= now() - interval '24 hours'",
    )
    .fetch_one(&state.db).await?;

    Ok(Json(EventsStats {
        total:    total as u64,
        by_level,
        last_24h: last_24h as u64,
    }))
}

// ── /api/monitoring/audit-runs/stats ────────────────────────────────────

/// `GET /api/monitoring/audit-runs/stats` — KPI strip for the Runs
/// tab: total + by-tool distribution + last-7d cadence. No window
/// param: audit runs are infrequent (a handful per day at most), so
/// total over all time is the right top-line.
async fn stats_audit_runs(
    State(state): State<AppState>,
) -> Result<Json<AuditRunsStats>, AppError> {
    let total: i64 = db::count_total(&state.db, "audit.run").await?;

    let by_tool = crate::routes::admin::group_count(
        &state.db,
        "SELECT tool, COUNT(*)::BIGINT FROM audit.run GROUP BY tool",
    ).await?;

    let last_7d: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.run WHERE ran_at >= now() - interval '7 days'",
    )
    .fetch_one(&state.db).await?;

    Ok(Json(AuditRunsStats {
        total:   total as u64,
        by_tool,
        last_7d: last_7d as u64,
    }))
}

// ── /api/monitoring/audit-findings/stats ────────────────────────────────

/// `GET /api/monitoring/audit-findings/stats` — KPI strip for the
/// Findings tab: total + severity bucket distribution + by-kind
/// horizontal bar. Severity is bucketed low/med/high in SQL (raw
/// column is integer 0-28+); the frontend wants three bands.
async fn stats_audit_findings(
    State(state): State<AppState>,
) -> Result<Json<AuditFindingsStats>, AppError> {
    let total: i64 = db::count_total(&state.db, "audit.finding").await?;

    // Bucket boundaries: low ≤ 5, med 6-15, high > 15. NULL severity
    // folds into "low" since "no severity flagged" is the gentlest
    // band — keeps the donut from showing a fourth slice the frontend
    // doesn't know how to colour.
    let by_severity = crate::routes::admin::group_count(
        &state.db,
        "SELECT CASE
                  WHEN severity IS NULL OR severity <= 5  THEN 'low'
                  WHEN severity <= 15                     THEN 'med'
                  ELSE 'high'
                END AS bucket,
                COUNT(*)::BIGINT
           FROM audit.finding
          GROUP BY bucket",
    ).await?;

    let by_kind = crate::routes::admin::group_count(
        &state.db,
        "SELECT kind, COUNT(*)::BIGINT FROM audit.finding GROUP BY kind",
    ).await?;

    Ok(Json(AuditFindingsStats {
        total: total as u64,
        by_severity,
        by_kind,
    }))
}

// ── /api/monitoring/request/:request_id  (M-1 — slice E) ────────────────

/// Per-request investigation drill-down. Pulls the `request_log` row
/// keyed on `request_id`, plus every event tagged with the same
/// request_id, ordered ascending so the operator reads the timeline
/// top-to-bottom. 404 when neither the request row nor any event
/// exists for the id — protects against a typo'd id returning an
/// empty drill-down with no signal.
async fn request_detail(
    State(state):       State<AppState>,
    Path(request_id):   Path<String>,
) -> Result<Json<RequestDetail>, AppError> {
    let row = sqlx::query(
        "SELECT id, at, method, route, status, duration_ms, request_id
           FROM request_log
          WHERE request_id = $1
          ORDER BY at DESC
          LIMIT 1",
    )
    .bind(&request_id)
    .fetch_optional(&state.db)
    .await?;

    let request = match row {
        Some(r) => RequestSummary {
            id:          r.try_get("id").unwrap_or(0),
            at:          r.try_get("at").unwrap_or_else(|_| Utc::now()),
            method:      r.try_get("method").unwrap_or_default(),
            route:       r.try_get("route").unwrap_or_default(),
            status:      r.try_get("status").unwrap_or(0),
            duration_ms: r.try_get("duration_ms").unwrap_or(0),
            request_id:  r.try_get("request_id").ok(),
        },
        None => return Err(AppError::not_found("not_found", format!("request {request_id}"))),
    };

    let events = db::list_events_for_request(&state.db, &request_id).await?;

    Ok(Json(RequestDetail { request, events }))
}

// ── /api/monitoring/users/:user_rid/activity  (M-2 — slice E) ───────────

#[derive(Deserialize)]
struct UserActivityQuery {
    /// Window start (RFC3339). Defaults to `now - 1h` when absent.
    #[serde(default)] from: Option<chrono::DateTime<chrono::Utc>>,
    /// Window end (RFC3339). Defaults to `now` when absent.
    #[serde(default)] to:   Option<chrono::DateTime<chrono::Utc>>,
    /// Per-side cap (requests AND events). Default 500. Caps prevent
    /// the operator's "give me all of last week" mistype from pulling
    /// 10M rows; the FE pages back narrower windows when the cap hits.
    #[serde(default)] limit: Option<i64>,
}

/// Per-user activity feed. Returns the user's request_log rows + events
/// over the requested window, each capped to `limit` (default 500).
/// Both slices are independent — the FE UNIONs them for a single
/// time-ordered redtable view.
async fn user_activity(
    State(state):    State<AppState>,
    Path(user_rid):  Path<String>,
    Query(q):        Query<UserActivityQuery>,
) -> Result<Json<UserActivity>, AppError> {
    let now   = Utc::now();
    let to    = q.to.unwrap_or(now);
    let from  = q.from.unwrap_or_else(|| now - Duration::hours(1));
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);

    let request_rows = sqlx::query(
        "SELECT id, at, method, route, status, duration_ms, request_id
           FROM request_log
          WHERE user_redpash_id = $1
            AND at >= $2 AND at < $3
          ORDER BY at DESC
          LIMIT $4",
    )
    .bind(&user_rid)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let requests: Vec<RequestSummary> = request_rows
        .into_iter()
        .map(|r| RequestSummary {
            id:          r.try_get("id").unwrap_or(0),
            at:          r.try_get("at").unwrap_or_else(|_| Utc::now()),
            method:      r.try_get("method").unwrap_or_default(),
            route:       r.try_get("route").unwrap_or_default(),
            status:      r.try_get("status").unwrap_or(0),
            duration_ms: r.try_get("duration_ms").unwrap_or(0),
            request_id:  r.try_get("request_id").ok(),
        })
        .collect();

    let events = db::list_events_for_user(&state.db, &user_rid, from, to, limit).await?;

    Ok(Json(UserActivity { requests, events }))
}

// ── /api/monitoring/optimization-points ─────────────────────────────────

#[derive(Deserialize)]
struct OptPointsQuery {
    #[serde(default)] page:      Option<u32>,
    #[serde(default)] size:      Option<u32>,
    #[serde(default)] subsystem: Option<String>,
    #[serde(default)] status:    Option<String>,
}

/// Whitelist of table names safe for `table_row_count` measurement.
/// Keep narrow — anything that lands here gets COUNT(*)'d on every
/// optimization-map fetch.
const ROW_COUNT_TABLES: &[&str] = &[
    "users", "projects", "project_files", "project_steps",
    "request_log", "events", "user_preferences", "sentinel_submissions",
    "audit.run", "audit.finding",
];

async fn list_optimization_points(
    State(state): State<AppState>,
    Query(q):     Query<OptPointsQuery>,
) -> Result<Json<Page<OptimizationPoint>>, AppError> {
    let started = Instant::now();
    let (offset, size, page) = paginate(q.page, q.size);

    let all_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM optimization_points",
    )
    .fetch_one(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM optimization_points
         WHERE ($1::text IS NULL OR subsystem = $1)
           AND ($2::text IS NULL OR status    = $2)",
    )
    .bind(q.subsystem.as_deref())
    .bind(q.status.as_deref())
    .fetch_one(&state.db)
    .await?;

    // Sort: open before planned before done before wontfix; then
    // subsystem; then phase. "What's left to do" rises to the top.
    let rows = sqlx::query(
        "SELECT id, subsystem, phase, current_cost, horizon, status,
                measurement_kind, measurement_key, threshold_value,
                threshold_unit, notes, created_at, updated_at
           FROM optimization_points
          WHERE ($1::text IS NULL OR subsystem = $1)
            AND ($2::text IS NULL OR status    = $2)
          ORDER BY
            CASE status
              WHEN 'open'     THEN 0
              WHEN 'planned'  THEN 1
              WHEN 'done'     THEN 2
              WHEN 'wontfix'  THEN 3
              ELSE 4
            END,
            subsystem, phase
          LIMIT $3 OFFSET $4",
    )
    .bind(q.subsystem.as_deref())
    .bind(q.status.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let mut points: Vec<OptimizationPoint> = Vec::with_capacity(rows.len());
    for r in rows {
        let mut p = OptimizationPoint {
            id:               r.try_get("id").unwrap_or(0),
            subsystem:        r.try_get("subsystem").unwrap_or_default(),
            phase:            r.try_get("phase").unwrap_or_default(),
            current_cost:     r.try_get("current_cost").unwrap_or_default(),
            horizon:          r.try_get("horizon").unwrap_or_default(),
            status:           r.try_get("status").unwrap_or_default(),
            measurement_kind: r.try_get("measurement_kind").ok(),
            measurement_key:  r.try_get("measurement_key").ok(),
            threshold_value:  r.try_get("threshold_value").ok(),
            threshold_unit:   r.try_get("threshold_unit").ok(),
            notes:            r.try_get("notes").ok(),
            created_at:       r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
            updated_at:       r.try_get("updated_at").unwrap_or_else(|_| Utc::now()),
            current_value:    None,
            tipped:           None,
        };
        // Live evaluation per measurement_kind. Errors swallow to NULL —
        // the row still renders the static prose; the live cell shows "—".
        p.current_value = evaluate_measurement(
            &state,
            p.measurement_kind.as_deref(),
            p.measurement_key.as_deref(),
        ).await;
        p.tipped = match (p.current_value, p.threshold_value) {
            (Some(cv), Some(th)) => Some(cv >= th),
            _                    => None,
        };
        points.push(p);
    }

    Ok(Json(build_page(
        points,
        total as u64,
        all_count as u64,
        page,
        size,
        started,
    )))
}

/// Dispatch the live measurement per `kind`. Returns NULL on
/// unknown kind, NULL key when one is required, or any DB error
/// (the row still renders without a live value).
async fn evaluate_measurement(
    state: &AppState,
    kind:  Option<&str>,
    key:   Option<&str>,
) -> Option<f64> {
    let kind = kind?;
    if kind == "none" { return None; }

    match kind {
        // route_count_24h — count of request_log entries matching the
        // method+route, last 24h. Self-observation filter applies
        // (matches the metrics endpoint convention).
        "route_count_24h" => {
            let (method, route) = split_method_route(key?)?;
            let n: Result<i64, _> = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT FROM request_log
                  WHERE at >= now() - interval '24 hours'
                    AND method = $1 AND route = $2
                    AND route NOT LIKE '/monitoring%'"
            ).bind(method).bind(route).fetch_one(&state.db).await;
            n.ok().map(|v| v as f64)
        }

        // route_p95_ms_24h — p95 latency for the method+route, last 24h.
        "route_p95_ms_24h" => {
            let (method, route) = split_method_route(key?)?;
            let p95: Result<f64, _> = sqlx::query_scalar(
                "SELECT COALESCE(
                          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms),
                          0
                        )::DOUBLE PRECISION
                   FROM request_log
                  WHERE at >= now() - interval '24 hours'
                    AND method = $1 AND route = $2
                    AND route NOT LIKE '/monitoring%'"
            ).bind(method).bind(route).fetch_one(&state.db).await;
            p95.ok()
        }

        // route_error_rate_24h — fraction in [0,1].
        "route_error_rate_24h" => {
            let (method, route) = split_method_route(key?)?;
            let row = sqlx::query(
                "SELECT COUNT(*)::BIGINT AS total,
                        COUNT(*) FILTER (WHERE status >= 400)::BIGINT AS errs
                   FROM request_log
                  WHERE at >= now() - interval '24 hours'
                    AND method = $1 AND route = $2
                    AND route NOT LIKE '/monitoring%'"
            ).bind(method).bind(route).fetch_one(&state.db).await.ok()?;
            let total: i64 = row.try_get("total").unwrap_or(0);
            let errs:  i64 = row.try_get("errs").unwrap_or(0);
            if total == 0 { None } else { Some(errs as f64 / total as f64) }
        }

        // audit_finding_count — count of findings of a (tool/kind)
        // pair in the latest audit.run for that tool.
        "audit_finding_count" => {
            let (tool, fkind) = key?.split_once('/')?;
            let n: Result<i64, _> = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT
                   FROM audit.finding f
                   JOIN (SELECT id FROM audit.run
                          WHERE tool = $1
                          ORDER BY ran_at DESC LIMIT 1) latest
                     ON f.run_id = latest.id
                  WHERE f.kind = $2"
            ).bind(tool).bind(fkind).fetch_one(&state.db).await;
            n.ok().map(|v| v as f64)
        }

        // table_row_count — whitelisted table names only.
        "table_row_count" => {
            let table = key?;
            if !ROW_COUNT_TABLES.contains(&table) { return None; }
            // Safe: table is from the whitelist literal, not user input.
            let sql = format!("SELECT COUNT(*)::BIGINT FROM {}", table);
            let n: Result<i64, _> = sqlx::query_scalar(&sql)
                .fetch_one(&state.db).await;
            n.ok().map(|v| v as f64)
        }

        _ => None,
    }
}

fn split_method_route(key: &str) -> Option<(&str, &str)> {
    let mut parts = key.splitn(2, ' ');
    let method = parts.next()?;
    let route  = parts.next()?;
    Some((method, route))
}

// Allowed `status` values — mirrors the CHECK on optimization_points.
const OPT_STATUSES: &[&str] = &["open", "planned", "done", "wontfix"];

#[derive(Deserialize)]
struct PatchOptPointBody {
    status: String,
}

/// `PATCH /api/monitoring/optimization-points/:rid` — flip a row's
/// status (`open → planned → done → wontfix`). Returns the updated
/// row with live measurement re-evaluated, same shape as the list.
///
/// Open to any authed user today, matching the rest of the monitoring
/// surface; RBAC-gate to company-admin when [[rbac-corporate-ready]]
/// lands. Spec: docs/internal/specs/optimization-map.md §7.
async fn patch_optimization_point(
    State(state): State<AppState>,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchOptPointBody>,
) -> Result<Json<OptimizationPoint>, AppError> {
    // AUTH-AUDIT-ACK: optimization_points is global admin state per
    // optimization-map.md §7; gate behind company-admin role at RBAC.
    let new_status = body.status.trim();
    if !OPT_STATUSES.contains(&new_status) {
        return Err(AppError::bad_request("invalid",
            "status must be open / planned / done / wontfix"));
    }
    let id: i64 = rid.parse()
        .map_err(|_| AppError::bad_request("invalid", "id must be a number"))?;

    let row = sqlx::query(
        "UPDATE optimization_points
            SET status = $2, updated_at = now()
          WHERE id = $1
      RETURNING id, subsystem, phase, current_cost, horizon, status,
                measurement_kind, measurement_key, threshold_value,
                threshold_unit, notes, created_at, updated_at",
    )
    .bind(id)
    .bind(new_status)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::not_found("not_found", format!("optimization_point {id}")))?;

    let mut p = OptimizationPoint {
        id:               row.try_get("id").unwrap_or(0),
        subsystem:        row.try_get("subsystem").unwrap_or_default(),
        phase:            row.try_get("phase").unwrap_or_default(),
        current_cost:     row.try_get("current_cost").unwrap_or_default(),
        horizon:          row.try_get("horizon").unwrap_or_default(),
        status:           row.try_get("status").unwrap_or_default(),
        measurement_kind: row.try_get("measurement_kind").ok(),
        measurement_key:  row.try_get("measurement_key").ok(),
        threshold_value:  row.try_get("threshold_value").ok(),
        threshold_unit:   row.try_get("threshold_unit").ok(),
        notes:            row.try_get("notes").ok(),
        created_at:       row.try_get("created_at").unwrap_or_else(|_| Utc::now()),
        updated_at:       row.try_get("updated_at").unwrap_or_else(|_| Utc::now()),
        current_value:    None,
        tipped:           None,
    };
    p.current_value = evaluate_measurement(
        &state,
        p.measurement_kind.as_deref(),
        p.measurement_key.as_deref(),
    ).await;
    p.tipped = match (p.current_value, p.threshold_value) {
        (Some(cv), Some(th)) => Some(cv >= th),
        _                    => None,
    };
    Ok(Json(p))
}
