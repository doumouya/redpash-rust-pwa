//! `/api/monitoring` — read surface for the `/monitoring` page.
//!
//!   GET /api/monitoring/events?page&size&window&level&kind
//!   GET /api/monitoring/audit-runs?page&size&tool
//!   GET /api/monitoring/audit-findings?page&size&run&tool&kind
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
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use shared::{
    monitoring::{AuditFindingSummary, AuditRunSummary, EventSummary},
    Page,
};
use sqlx::Row;

use crate::{error::AppError, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/events",          get(list_events))
        .route("/audit-runs",      get(list_audit_runs))
        .route("/audit-findings",  get(list_audit_findings))
}

// ── shared query plumbing ───────────────────────────────────────────────

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 500;

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)] page:   Option<u32>,
    #[serde(default)] size:   Option<u32>,
    #[serde(default)] window: Option<String>,
    #[serde(default)] level:  Option<String>,
    #[serde(default)] kind:   Option<String>,
}

#[derive(Deserialize)]
struct AuditRunsQuery {
    #[serde(default)] page: Option<u32>,
    #[serde(default)] size: Option<u32>,
    #[serde(default)] tool: Option<String>,
}

#[derive(Deserialize)]
struct AuditFindingsQuery {
    #[serde(default)] page: Option<u32>,
    #[serde(default)] size: Option<u32>,
    #[serde(default)] run:  Option<i64>,
    #[serde(default)] tool: Option<String>,
    #[serde(default)] kind: Option<String>,
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

/// Convert (page, size) → (zero-based offset, clamped size, clamped page).
/// 1-based `page` over the wire; 0-based offset internally.
fn paginate(page: Option<u32>, size: Option<u32>) -> (i64, u32, u32) {
    let size = size.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
    let page = page.unwrap_or(1).max(1);
    let offset = ((page - 1) as i64) * (size as i64);
    (offset, size, page)
}

/// Common Page<T> tail — `total` (post-filter), `all_count` (pre-filter
/// global total), `pages` (computed), `ms` (server time). `row_indices`
/// stays empty (admin lists don't drive select-mode).
fn build_page<T>(
    rows: Vec<T>,
    total: u64,
    all_count: u64,
    page: u32,
    size: u32,
    started: Instant,
) -> Page<T> {
    let pages = if total == 0 {
        0
    } else {
        ((total + size as u64 - 1) / size as u64) as u32
    };
    Page {
        rows,
        total,
        all_count,
        page,
        size,
        pages,
        ms: started.elapsed().as_millis() as u32,
        row_indices: Vec::new(),
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
    let all_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM events")
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    // Post-filter total + the page rows. Three optional filters
    // (window, level, kind) folded into a single SQL via the
    // `$N::T IS NULL OR …` trick so we avoid building dynamic SQL.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM events
         WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
           AND ($2::text IS NULL OR level = $2)
           AND ($3::text IS NULL OR kind  = $3)",
    )
    .bind(cutoff)
    .bind(q.level.as_deref())
    .bind(q.kind.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT redpash_id, occurred_at, origin, level, kind, message,
                http_status, request_id
           FROM events
          WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
            AND ($2::text IS NULL OR level = $2)
            AND ($3::text IS NULL OR kind  = $3)
          ORDER BY occurred_at DESC
          LIMIT $4 OFFSET $5",
    )
    .bind(cutoff)
    .bind(q.level.as_deref())
    .bind(q.kind.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

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

    let all_count: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM audit.run")
        .fetch_one(&state.db)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.run
         WHERE ($1::text IS NULL OR tool = $1)",
    )
    .bind(q.tool.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT id, tool, ran_at, git_sha, git_branch, stats
           FROM audit.run
          WHERE ($1::text IS NULL OR tool = $1)
          ORDER BY ran_at DESC
          LIMIT $2 OFFSET $3",
    )
    .bind(q.tool.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

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
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
    };

    let all_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.finding",
    )
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.finding
         WHERE ($1::bigint IS NULL OR run_id = $1)
           AND ($2::text IS NULL OR tool = $2)
           AND ($3::text IS NULL OR kind = $3)",
    )
    .bind(run_filter)
    .bind(q.tool.as_deref())
    .bind(q.kind.as_deref())
    .fetch_one(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    let rows = sqlx::query(
        "SELECT run_id, tool, kind, finding_key, severity
           FROM audit.finding
          WHERE ($1::bigint IS NULL OR run_id = $1)
            AND ($2::text IS NULL OR tool = $2)
            AND ($3::text IS NULL OR kind = $3)
          ORDER BY run_id DESC, severity DESC NULLS LAST, finding_key
          LIMIT $4 OFFSET $5",
    )
    .bind(run_filter)
    .bind(q.tool.as_deref())
    .bind(q.kind.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

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
