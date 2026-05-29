//! Company resource DTOs.
//!
//! A company is the multi-tenancy boundary: a user belongs to zero or
//! more companies via the unified `memberships` table. Projects can be
//! scoped to a company or stay personal (`company_id = NULL`).

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

/// A company record as stored. `slug` is immutable — derived from the
/// name at creation and never re-issued.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    pub redpash_id: String,
    pub name:       String,
    pub slug:       String,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A company in the requesting user's list — the record plus the
/// caller's own role and the total member count.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanySummary {
    #[serde(flatten)]
    pub company:      Company,
    pub member_count: u32,
    /// The requesting user's role in this company: `owner` · `admin` · `member`.
    /// `None` when the caller isn't a member — the list endpoint returns
    /// every company (broader-than-membership scope) so the Companies tab
    /// can surface companies the user might want to join.
    #[serde(default)]
    pub my_role:      Option<String>,
}

/// One membership row, joined with the member's user profile so the
/// members list renders without a second lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyMember {
    pub user_redpash_id: String,
    pub display_name:    String,
    pub username:        String,
    pub avatar_url:      Option<String>,
    pub role:            String,
    pub joined_at:       DateTime<Utc>,
}
