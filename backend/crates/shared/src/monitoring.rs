//! Doc: docs/internal/code/backend/shared/monitoring.md
//! Monitoring summaries — slim wire shapes for the /api/monitoring
//! list endpoints.
//!
//! Each `*Summary` is a *list-projection*: enough fields for the
//! redtable + ranked-table views in `frontend/scripts/pages/monitoring.js`,
//! omitting the heavy detail JSONB (`context`, `payload`, `detail`).
//! Detail views (per-event, per-run, per-finding) live behind the
//! existing per-rid endpoints — `/api/events/:rid` already serves
//! the full `Event`.
//!
//! Wire contract: `docs/internal/admin-monitoring-surfaces.md §6`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One row in `GET /api/monitoring/events`. Drops `context`, `source`,
/// `user_redpash_id`, `session_id`, `http_method`, `http_path`,
/// `duration_ms` — those land in the per-rid detail view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSummary {
    pub redpash_id:  String,
    pub occurred_at: DateTime<Utc>,
    pub origin:      String,
    pub level:       String,
    pub kind:        String,
    pub message:     String,
    #[serde(default)] pub http_status: Option<i32>,
    #[serde(default)] pub request_id:  Option<String>,
}

/// One row in `GET /api/monitoring/audit-runs`. `stats` is the JSONB
/// the audit script emitted (headline numbers — files, conflicts,
/// orphans, reachable, etc.); the full `payload` lives in
/// `audit.run.payload` and isn't projected here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRunSummary {
    pub id:         i64,
    pub tool:       String,
    pub ran_at:     DateTime<Utc>,
    #[serde(default)] pub git_sha:    Option<String>,
    #[serde(default)] pub git_branch: Option<String>,
    pub stats:      serde_json::Value,
}

/// One row in `GET /api/monitoring/audit-findings`. `detail` JSONB
/// is omitted — call the matching `audit.run.payload` for the full
/// context if a finding's UI needs it. `severity` semantics depend on
/// `kind`: conflictCount, divergentCount, saved, etc. — see
/// `tools/audit-storage-brainstorming.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditFindingSummary {
    pub run_id:      i64,
    pub tool:        String,
    pub kind:        String,
    pub finding_key: String,
    #[serde(default)] pub severity: Option<i32>,
}

/// One row in `GET /api/monitoring/requests` — the drill-down redtable
/// beneath the Requests-tab KPI strip + ECharts panels. Mirrors the
/// `request_log` table verbatim minus internal-only columns (none in
/// the current schema, but the projection is explicit so a future
/// `internal_only` column won't leak by accident).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestSummary {
    pub id:          i64,
    pub at:          chrono::DateTime<chrono::Utc>,
    pub method:      String,
    pub route:       String,
    pub status:      i16,
    pub duration_ms: i32,
    #[serde(default)] pub request_id: Option<String>,
}

/// One row in `GET /api/monitoring/queries` — the DB-layer sibling of
/// `RequestSummary`. Mirrors `db_query_log` (DB observability). The
/// `query_template` is the parameterized SQL (placeholders, no bound
/// values); `request_id` / `route` / `user_redpash_id` correlate back to
/// the HTTP request that issued the query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbQuerySummary {
    pub id:             i64,
    pub at:             chrono::DateTime<chrono::Utc>,
    pub query_template: String,
    pub duration_ms:    i32,
    #[serde(default)] pub rows:            Option<i64>,
    pub status:         i16,
    #[serde(default)] pub error_kind:      Option<String>,
    #[serde(default)] pub request_id:      Option<String>,
    #[serde(default)] pub route:           Option<String>,
    #[serde(default)] pub user_redpash_id: Option<String>,
}

/// One row in the `top_routes` field of `GET /api/monitoring/requests/stats`.
/// Same shape as `/api/metrics`'s `by_route` entries, kept distinct so
/// the two endpoints can drift independently (e.g. monitoring later
/// adds an "ok/warn/error" band column without touching /api/metrics).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteStat {
    pub method:     String,
    pub route:      String,
    pub count:      u64,
    pub p50_ms:     i64,
    pub p95_ms:     i64,
    pub p99_ms:     i64,
    pub error_rate: f64,
}

/// Aggregate returned by `GET /api/monitoring/requests/stats`. Powers
/// the status-mix donut + ranked top-routes panels on the Requests
/// tab; the paginated drill-down comes from the sibling list endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestsStats {
    pub window:      crate::monitoring::Window,
    pub total:       u64,
    /// HTTP status-code distribution within the window — exact codes
    /// (`"200" | "401" | "500" | …`) so the donut can color-band by
    /// 2xx / 3xx / 4xx / 5xx on the frontend without bucket choices
    /// being baked server-side.
    pub status_mix:  std::collections::HashMap<String, u64>,
    /// Routes ranked by p95 latency, descending — the operator's
    /// "slowest 10" view. Always capped at 10 entries server-side.
    pub top_routes:  Vec<RouteStat>,
    /// Bucketed latency time-series across the window — drives a smooth
    /// p95 line on the frontend. Grain is server-picked per window
    /// (~24-30 buckets across any window). Empty buckets are omitted;
    /// the frontend can gap-fill if its chart kind requires it.
    /// `#[serde(default)]` keeps the wire backwards-compatible.
    #[serde(default)]
    pub buckets:     Vec<LatencyBucket>,
}

/// One time bucket in the latency-over-time series. `ts` is the start
/// of the bucket (UTC); `count` is the number of requests inside it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyBucket {
    pub ts:     chrono::DateTime<chrono::Utc>,
    pub count:  u64,
    pub p50_ms: i64,
    pub p95_ms: i64,
    pub p99_ms: i64,
}

/// Aggregate returned by `GET /api/monitoring/events/stats`. Powers
/// the Events tab's KPI strip (by-level donut + last-24h gauge).
/// Same single-shape vocabulary as the `/api/admin/*/stats` family.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventsStats {
    pub total:    u64,
    pub by_level: std::collections::HashMap<String, u64>,
    pub last_24h: u64,
}

/// Aggregate returned by `GET /api/monitoring/audit-runs/stats`.
/// Powers the Audit Runs tab's KPI strip (by-tool horizontal bar +
/// last-7d cadence gauge).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRunsStats {
    pub total:   u64,
    pub by_tool: std::collections::HashMap<String, u64>,
    pub last_7d: u64,
}

/// Aggregate returned by `GET /api/monitoring/audit-findings/stats`.
/// Powers the Findings tab's KPI strip (severity donut + by-kind
/// horizontal bar). `severity` is bucketed server-side because the
/// raw column is an integer 0-28+; the frontend wants three bands.
///
///   low  ≤ 5      med  6-15      high  > 15
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditFindingsStats {
    pub total:        u64,
    pub by_severity:  std::collections::HashMap<String, u64>,
    pub by_kind:      std::collections::HashMap<String, u64>,
}

/// The time window covered by a monitoring stats response. Mirrors
/// `/api/metrics`'s `window` field so the frontend can label it
/// identically.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Window {
    pub label: String,
    pub since: chrono::DateTime<chrono::Utc>,
    pub until: chrono::DateTime<chrono::Utc>,
}

/// Returned by `GET /api/monitoring/request/:request_id` — the
/// per-request investigation drill-down. `request` is the request_log
/// row keyed on `request_id`; `events` is every event row carrying the
/// same `request_id`, ordered ascending so the operator reads the
/// timeline top-to-bottom.
///
/// Powers slice E of the audit-everything workstream — investigation
/// I-2 ("user got a 500 — root-cause it") in
/// docs/internal/observability/investigations.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestDetail {
    pub request: RequestSummary,
    pub events:  Vec<crate::event::Event>,
}

/// One row of the per-user activity feed. Unified projection over
/// `events` + `request_log` (server-side `UNION ALL`) so a single
/// `Page<ActivityRow>` paginates the merged chronological stream —
/// independent slices would break pagination once either source
/// exceeds the per-side cap.
///
/// `source` tags origin (`"event"` | `"request"`); `kind` is the
/// per-source category (event.kind for events, `METHOD ROUTE` for
/// requests); `summary` carries the human-readable line; `level`
/// is event-only (NULL for requests); `ref_id` is the source row's
/// addressable id (events.redpash_id or request_log.request_id) for
/// drill-down; `context` is the source's jsonb payload (events.context
/// directly, requests projected as `{ status, duration_ms }`).
///
/// Powers investigations I-1 ("user X reports slow Workspace") and
/// I-7 ("replay user's session"). Sources both indexed on
/// `(user_redpash_id, at DESC)` — `events_user_idx` (mig 013) and
/// `request_log_user_idx` (mig 027) — so the UNION ALL hits both
/// fast paths and Postgres merges + LIMIT/OFFSETs the unified set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityRow {
    pub at:      chrono::DateTime<chrono::Utc>,
    pub source:  String,
    pub kind:    String,
    pub summary: String,
    pub level:   Option<String>,
    pub ref_id:  Option<String>,
    pub context: serde_json::Value,
}
