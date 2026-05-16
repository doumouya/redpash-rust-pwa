//! ProjectStep — one cleaning operation applied to a file.
//!
//! Wire shape mirrors the `project_steps` table:
//!   • `ordinal`  is the position in the file's step history.
//!   • `applied`  flips false on undo, true on redo.
//!   • `kind`     is a string (so new step kinds can ship without
//!                touching the DTO); the data crate pattern-matches on
//!                known values and rejects the rest.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStep {
    pub redpash_id:      String,
    pub file_redpash_id: String,
    pub ordinal:         i32,
    pub kind:            String,
    pub params:          serde_json::Value,
    pub applied:         bool,
    pub created_at:      DateTime<Utc>,
}

/// Body of `POST /api/files/:rid/steps`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRequest {
    pub kind:   String,
    pub params: serde_json::Value,
}
