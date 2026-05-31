//! Doc: docs/internal/code/backend/shared/admin.md
//! Admin summaries — slim wire shapes for the `/api/admin/*` list
//! endpoints powering Home's org/data rail tabs.
//!
//! Each `*Summary` is a list-projection: enough fields for the
//! redtable + KPI strip on the Home tab, with the heavier per-entity
//! detail (prefs JSONB, full ColumnMeta vec, step params, etc.) left
//! to the existing resource endpoints. The frontend renders Home as
//! a read-only browser; per-row drill-down opens the entity's normal
//! detail page.
//!
//! Wire contract: `docs/internal/admin-monitoring-surfaces.md §6`.
//!
//! NOT a duplicate of the existing per-resource DTOs:
//!   - `shared::user::UserProfile`  serves the signed-in user's own profile.
//!   - `shared::file::FileSummary`  serves per-project file lists.
//!   - `shared::company::CompanySummary` is reused as-is (Companies tab).
//! The admin views need *org-wide* projections with joined context
//! fields (project_name, file_filename) the per-resource shapes don't
//! carry — that's what the new types here add.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One row in `GET /api/admin/users`. Org-wide list — no membership
/// scoping until RBAC lands; the `plan` + `organisation` fields give
/// the Home Users tab enough context without the prefs JSONB.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSummary {
    pub redpash_id:   String,
    pub username:     String,
    #[serde(default)] pub email:        Option<String>,
    pub display_name: String,
    #[serde(default)] pub avatar_url:   Option<String>,
    #[serde(default)] pub job_title:    Option<String>,
    #[serde(default)] pub organisation: Option<String>,
    pub plan:         String,
    /// User's top company membership, joined from `memberships` (company objects).
    /// "Top" = owner first, then admin, then member; ties broken by
    /// most-recent `joined_at`. NULL when the user has no membership.
    /// Distinct from `organisation` (free-text profile field).
    #[serde(default)] pub org_id:       Option<String>,
    #[serde(default)] pub org_name:     Option<String>,
    #[serde(default)] pub org_role:     Option<String>,
    pub created_at:   DateTime<Utc>,
}

/// One row in `GET /api/admin/memberships?scope=project|company`. One
/// shape, two scopes — `scope` discriminates which set the row came
/// from. `scope_redpash_id` + `scope_name` carry the joined parent
/// (project or company) so the row renders without a second lookup;
/// `user_display_name` + `user_username` do the same for the member.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MembershipSummary {
    /// `"project"` | `"company"` — which membership table this came from.
    pub scope:             String,
    pub scope_redpash_id:  String,
    pub scope_name:        String,
    pub member_redpash_id:   String,
    pub user_display_name: String,
    pub user_username:     String,
    /// project memberships: `owner | collaborator | viewer`.
    /// company memberships: `owner | admin | member`.
    pub role:              String,
    pub joined_at:         DateTime<Utc>,
}

/// One row in `GET /api/admin/files`. Same backing table as
/// `shared::file::FileSummary` (project_files), but adds `project_name`
/// joined from `projects` so the Home Files tab shows which project
/// each file lives in without a chatty follow-up fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminFileSummary {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    pub project_name:       String,
    pub filename:           String,
    #[serde(default)] pub display_name:    Option<String>,
    pub file_type:          String,
    /// Computed via the `file_stages` view (`new | clean | design | publish`).
    /// Replaces the dropped `status` column; matches `shared::file::FileSummary.stage`.
    pub stage:              String,
    #[serde(default)] pub row_count:       Option<i64>,
    #[serde(default)] pub col_count:       Option<i32>,
    #[serde(default)] pub file_size_bytes: Option<i64>,
    #[serde(default)] pub cleanness_pct:   Option<f32>,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}

/// One row in `GET /api/admin/charts`. Backed by `project_files` rows
/// where `file_type = 'chart'`; same fields as `AdminFileSummary` plus
/// the chart-specific bits would land here later (kind, used-in-reports
/// count, etc.). Kept as a distinct type so the frontend renderer can
/// branch cleanly when chart-specific columns are added.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartSummary {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    pub project_name:       String,
    pub filename:           String,
    #[serde(default)] pub display_name: Option<String>,
    /// Stage from the `file_stages` view; same vocabulary as
    /// `AdminFileSummary.stage`.
    pub stage:              String,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}

/// One row in `GET /api/admin/steps`. Each project_step joined with the
/// owning file's `filename` so the Home Steps tab shows which file each
/// step was applied to. `params` JSONB is omitted — the per-file step
/// timeline (workspace UI) is the right place to inspect parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepSummary {
    pub redpash_id:      String,
    pub file_redpash_id: String,
    pub file_filename:   String,
    pub ordinal:         i32,
    pub kind:            String,
    pub applied:         bool,
    pub created_at:      DateTime<Utc>,
}

// ── *Stats — per-entity KPI aggregates ──────────────────────────────────
//
// Returned by `GET /api/admin/<entity>/stats`. One small JSON per
// entity, used to paint the contextual KPI strip at the top of each
// Home tab body. Shapes are entity-specific — forcing a generic
// container would obscure the KPIs each tab actually displays. Each
// distribution (`by_*`) serializes as a JSON object (`{label: count}`)
// so the frontend renders it as a sorted bar without re-shaping.

use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserStats {
    pub total:     u64,
    /// Distinct users who appear in `events.user_redpash_id` over the
    /// last 7 days (any captured backend or frontend event). Best
    /// proxy we have for "active" pre-RBAC; will switch to a proper
    /// sessions table when one lands.
    pub active_7d: u64,
    /// Distribution by `users.plan` (`free | pro | …`).
    pub by_plan:   HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyStats {
    pub total:          u64,
    /// Companies whose projects had a file `updated_at` in the last
    /// 30 days. Activity proxy until we wire a real audit feed.
    pub active_30d:     u64,
    /// Companies with `COUNT(projects) > 0`.
    pub with_projects:  u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MembershipStats {
    /// `"project"` | `"company"` — scope this stat block describes.
    pub scope:   String,
    pub total:   u64,
    /// Role distribution within this scope.
    ///   project: owner | collaborator | viewer
    ///   company: owner | admin | member
    pub by_role: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStats {
    pub total:          u64,
    /// `file_stages.stage` distribution (new | clean | design | publish).
    /// Files predating the view entry default to `new`.
    pub by_stage:       HashMap<String, u64>,
    /// `file_type` distribution (csv | chart | …).
    pub by_type:        HashMap<String, u64>,
    /// AVG(cleanness_pct) over rows where it isn't NULL. `None` if no
    /// rows have a score yet.
    pub avg_cleanness:  Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartStats {
    pub total:           u64,
    pub last_7d:         u64,
    /// Projects that contain ≥1 chart-typed file — the implicit
    /// "report" criterion (projects with a chart attached).
    pub used_in_reports: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepStats {
    pub total:    u64,
    /// Step kind distribution (`filter_rows | drop_rows | set_cell | …`).
    pub by_kind:  HashMap<String, u64>,
    pub last_24h: u64,
}
