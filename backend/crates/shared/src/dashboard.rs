//! Doc: docs/internal/code/backend/shared/dashboard.md
//! Dashboard resource DTOs.
//!
//! A `Dashboard` is the persisted record (id + title + spec + favorite
//! + folder), stored as a dashboard-typed `project_files` row.
//! `DashboardSpec` is the inner shape — a layout template + a list of
//! widgets; each widget references a chart by id.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dashboard {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    pub title:              String,
    #[serde(default)]
    pub description:        Option<String>,
    pub spec:               DashboardSpec,
    #[serde(default)]
    pub is_favorite:        bool,
    #[serde(default)]
    pub is_public:          bool,
    #[serde(default)]
    pub folder:             Option<String>,
    // Owner — joined via projects.owner_id → users. None when the
    // fetcher didn't take the users join (single-row endpoints leave
    // these unset). The list endpoint populates all three for the
    // Dashboards tab.
    #[serde(default)]
    pub owner_id:           Option<String>,
    #[serde(default)]
    pub owner_display_name: Option<String>,
    #[serde(default)]
    pub owner_username:     Option<String>,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DashboardSpec {
    /// Template id — drives the grid layout. Known values are
    /// `1x1`, `2x2`, `kpi-row-2x1`, `chart-side-table`, `header-3x2`.
    /// Unknown ids render as `1x1` (single full-width widget).
    #[serde(default)]
    pub template_id: String,
    #[serde(default)]
    pub widgets:     Vec<Widget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Widget {
    /// Layout slot id — defined by the template (`a`, `b`, `kpi-1`, …).
    pub slot: String,
    /// `chart` | `kpi` | `table` | `text` | `report`.
    pub kind: String,
    /// Shape varies by `kind`:
    ///   chart : { chart_id, title_override? } — references a saved
    ///           chart file; the dashboard decides where to place it.
    ///   text  : { markdown }
    #[serde(default)]
    pub spec: serde_json::Value,
}

/// Body of `POST /api/dashboards` (and `PUT /api/dashboards/:rid`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardRequest {
    pub project_redpash_id: String,
    pub title:              String,
    pub spec:               DashboardSpec,
    #[serde(default)]
    pub description:        Option<String>,
    #[serde(default)]
    pub folder:             Option<String>,
}
