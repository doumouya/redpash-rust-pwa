//! Doc: docs/internal/code/backend/shared/project.md
//! Project resource DTOs.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub redpash_id:    String,
    pub name:          String,
    pub description:   Option<String>,
    pub file_count:    u32,
    pub cleanness_pct: Option<f32>,
    pub stage:         String,
    pub status:        String,
    pub is_default:    bool,
    // Owner: the id is the FK; display_name / username come from a
    // `users` join so the Objects table can show + reassign the owner.
    pub owner_id:           String,
    pub owner_display_name: String,
    pub owner_username:     String,
    // Company scoping: `None` = personal project. The id is the FK;
    // the company name isn't joined here (the Objects table shows the
    // raw scope, the company picker resolves names separately).
    pub company_id:         Option<String>,
    pub created_at:    DateTime<Utc>,
    pub updated_at:    DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDetail {
    #[serde(flatten)]
    pub summary: ProjectSummary,
    pub files:   Vec<crate::file::FileSummary>,
}
