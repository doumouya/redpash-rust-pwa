//! Doc: docs/internal/code/backend/shared/optimization.md
//! Optimization map — the wire DTO for `/api/monitoring/optimization-points`.
//!
//! See `docs/internal/specs/optimization-map.md`. One row pairs a
//! known optimization opportunity (subsystem + phase + horizon)
//! with the metadata to compute its live measured value, and ships
//! the evaluated value alongside the static prose. The frontend
//! redtable renders both in the same view.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationPoint {
    pub id:           i64,
    pub subsystem:    String,
    pub phase:        String,
    pub current_cost: String,
    pub horizon:      String,
    /// `open | planned | done | wontfix` (CHECK-constrained at the DB).
    pub status:       String,
    /// Measurement metadata — controls what the server evaluates for
    /// this row's `current_value`. NULL / "none" → static row.
    #[serde(default)] pub measurement_kind:  Option<String>,
    #[serde(default)] pub measurement_key:   Option<String>,
    #[serde(default)] pub threshold_value:   Option<f64>,
    #[serde(default)] pub threshold_unit:    Option<String>,
    #[serde(default)] pub notes:             Option<String>,
    pub created_at:   DateTime<Utc>,
    pub updated_at:   DateTime<Utc>,
    /// Server-evaluated on every fetch. NULL when measurement_kind is
    /// `none`/NULL, or the evaluator returned no data (empty window,
    /// non-whitelisted table, etc.).
    #[serde(default)] pub current_value:     Option<f64>,
    /// Server-computed convenience: `current_value >= threshold_value`.
    /// NULL when either side is NULL.
    #[serde(default)] pub tipped:            Option<bool>,
}
