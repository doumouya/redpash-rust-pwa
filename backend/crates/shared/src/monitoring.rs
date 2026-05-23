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
