//! Chart resource DTOs.
//!
//! A saved chart is a self-contained visualisation authored on the
//! Reports page. It is persisted as a chart-typed `project_files` row;
//! `spec` carries the whole chart definition as an opaque JSON blob
//! (kind, group-by / aggregation, the baked-in ECharts `option`, and an
//! SVG snapshot) — the backend stores and serves it without ever
//! reading into it.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chart {
    pub redpash_id:         String,
    pub project_redpash_id: String,
    /// The data file this chart was built from.
    pub source_file_id:     String,
    pub title:              String,
    /// Opaque chart definition: kind, group_by, agg_col / agg_fn, the
    /// self-contained ECharts `option`, an `svg` snapshot, and any
    /// per-kind modifiers. The backend never interprets it.
    pub spec:               serde_json::Value,
    pub created_at:         DateTime<Utc>,
    pub updated_at:         DateTime<Utc>,
}

/// Body of `POST /api/charts` and `PUT /api/charts/:rid`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartRequest {
    pub source_file_id: String,
    pub title:          String,
    pub spec:           serde_json::Value,
}
