//! Purpose: the cleaning-step DTO — one row of project_steps on the wire.
//!
//! `kind` is an OPEN string resolved against the data crate's step registry —
//! never an enum. A new step kind ships with zero DTO/DB changes; the engine
//! pattern-matches known kinds and rejects the rest with InvalidSpec.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub kind: String,
    #[serde(default)]
    pub params: serde_json::Value,
}
