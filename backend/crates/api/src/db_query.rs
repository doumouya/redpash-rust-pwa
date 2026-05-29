//! DB-layer observability — fire-and-forget per-query capture into the
//! `db_query_log` table (the DB sibling of `request_log`). A `tracing`
//! Layer taps sqlx's own query-log events (target `sqlx::query`), so
//! there are ZERO call-site changes. Scope:
//! `docs/internal/observability/db-monitoring.md`.
//!
//! Measuring the DB must never slow it: capture is fire-and-forget
//! (`tokio::spawn`) and the layer no-ops until the pool is set
//! ([`init_pool`], called after `AppState` boots — tracing inits before
//! the pool exists, hence the `OnceLock`).
//!
//! **Loop guard:** the capture INSERT is itself a sqlx query, so without
//! a guard it would emit a `sqlx::query` event → capture → INSERT → … a
//! runaway. We skip any query touching the log tables themselves.
//!
//! Capture policy (Em 2026-05-29, "monitor everything in verbose mode"):
//!   - `REDPASH_DB_TRACE=1` → capture EVERY query (verbose firehose).
//!   - otherwise            → capture only slow (≥ `REDPASH_DB_SLOW_MS`,
//!                            default 50ms) queries + errors.
//! The Monitoring view filters further; capture is the floor.

use std::sync::OnceLock;
use std::time::Duration;

use sqlx::PgPool;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

static POOL: OnceLock<PgPool> = OnceLock::new();

fn verbose() -> bool {
    matches!(
        std::env::var("REDPASH_DB_TRACE").ok().as_deref(),
        Some("1") | Some("true")
    )
}
fn slow_ms() -> i32 {
    std::env::var("REDPASH_DB_SLOW_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50)
}

/// Set the capture pool (after `AppState` boots) + spawn the retention
/// job. Only the first call wins (`OnceLock`).
pub fn init_pool(pool: PgPool) {
    if POOL.set(pool.clone()).is_err() {
        return;
    }
    spawn_retention(pool);
}

/// Hourly cleanup so the firehose stays bounded — `db_query_log` grows
/// faster than `request_log` (already flagged for unbounded growth).
/// `REDPASH_DB_LOG_RETENTION_DAYS` (default 7).
fn spawn_retention(pool: PgPool) {
    let days: i64 = std::env::var("REDPASH_DB_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let res = sqlx::query(
                "DELETE FROM db_query_log WHERE at < now() - ($1 || ' days')::interval",
            )
            .bind(days.to_string())
            .execute(&pool)
            .await;
            if let Err(e) = res {
                tracing::warn!(error = %e, "db_query_log retention cleanup failed (non-fatal)");
            }
        }
    });
}

/// The capture layer — added to the subscriber registry in `main`.
pub fn layer() -> DbQueryLayer {
    DbQueryLayer
}

pub struct DbQueryLayer;

/// Recorded from the per-request `"api"` span (see `request_id_mw`) so a
/// query event can correlate to its request.
#[derive(Clone)]
struct SpanCtx {
    request_id: Option<String>,
}

#[derive(Default)]
struct ApiSpanVisitor {
    request_id: Option<String>,
}
impl Visit for ApiSpanVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "request_id" {
            self.request_id = Some(value.to_string());
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "request_id" && self.request_id.is_none() {
            self.request_id = Some(format!("{value:?}").trim_matches('"').to_string());
        }
    }
}

#[derive(Default)]
struct QueryVisitor {
    statement: Option<String>,
    summary: Option<String>,
    elapsed_secs: Option<f64>,
    rows_affected: Option<i64>,
    rows_returned: Option<i64>,
}
impl Visit for QueryVisitor {
    fn record_f64(&mut self, field: &Field, value: f64) {
        if field.name() == "elapsed_secs" {
            self.elapsed_secs = Some(value);
        }
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        match field.name() {
            "rows_affected" => self.rows_affected = Some(value as i64),
            "rows_returned" => self.rows_returned = Some(value as i64),
            _ => {}
        }
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        match field.name() {
            "rows_affected" => self.rows_affected = Some(value),
            "rows_returned" => self.rows_returned = Some(value),
            _ => {}
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "db.statement" => self.statement = Some(value.to_string()),
            "summary" => self.summary = Some(value.to_string()),
            _ => {}
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "db.statement" if self.statement.is_none() => {
                self.statement = Some(format!("{value:?}"))
            }
            "summary" if self.summary.is_none() => self.summary = Some(format!("{value:?}")),
            _ => {}
        }
    }
}

impl<S> Layer<S> for DbQueryLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        if attrs.metadata().name() != "api" {
            return;
        }
        let mut v = ApiSpanVisitor::default();
        attrs.record(&mut v);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanCtx {
                request_id: v.request_id,
            });
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if event.metadata().target() != "sqlx::query" {
            return;
        }
        let pool = match POOL.get() {
            Some(p) => p.clone(),
            None => return,
        };

        let mut qv = QueryVisitor::default();
        event.record(&mut qv);

        let elapsed_ms = qv
            .elapsed_secs
            .map(|s| (s * 1000.0).round() as i32)
            .unwrap_or(0);
        let is_error = *event.metadata().level() == tracing::Level::ERROR;

        // Capture floor: verbose → everything; else slow or error only.
        if !verbose() && elapsed_ms < slow_ms() && !is_error {
            return;
        }

        // sqlx 0.8 emits BOTH `db.statement` and `summary`; for many
        // queries `db.statement` comes through empty while `summary`
        // carries the SQL, so prefer whichever is non-empty (statement is
        // the fuller form when present).
        let raw = qv
            .statement
            .filter(|s| !s.trim().is_empty())
            .or(qv.summary)
            .unwrap_or_default();
        let template = normalize_sql(&raw);
        if template.is_empty() {
            return;
        }
        // LOOP GUARD — never capture writes to the log tables themselves,
        // or this insert (a sqlx query) re-triggers capture forever.
        if template.contains("db_query_log") || template.contains("request_log") {
            return;
        }

        let rows = qv.rows_returned.or(qv.rows_affected);
        let status: i16 = if is_error { 1 } else { 0 };
        let request_id = ctx.lookup_current().and_then(|span| {
            span.scope().find_map(|s| {
                s.extensions()
                    .get::<SpanCtx>()
                    .and_then(|c| c.request_id.clone())
            })
        });

        tokio::spawn(async move {
            let res = sqlx::query(
                "INSERT INTO db_query_log
                     (query_template, duration_ms, rows, status, request_id)
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(template)
            .bind(elapsed_ms)
            .bind(rows)
            .bind(status)
            .bind(request_id)
            .execute(&pool)
            .await;
            if let Err(e) = res {
                tracing::warn!(error = %e, "db_query_log insert failed (non-fatal)");
            }
        });
    }
}

/// Collapse whitespace so a multi-line prepared statement logs as one
/// readable template line. sqlx already emits the *parameterized* SQL
/// (`$1, $2 …`), so there are no bound values to redact.
fn normalize_sql(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
