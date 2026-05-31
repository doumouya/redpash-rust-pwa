//! Doc: docs/internal/code/backend/shared/team.md
//! Team resource DTOs.
//!
//! Teams are company-scoped: `teams.company_id` is `NOT NULL` and
//! `CASCADE`s on company delete. Membership uses the same polymorphic
//! `memberships` edge as companies / projects / cases (object =
//! team's redpash_id). See [entity-membership-model](../../specs/rbac/entity-membership-model.md).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A team record as stored. Slimmer than `Company` — no slug, no
/// avatar, no `updated_at` (the migration omits it; can be added
/// later when the UI surfaces it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub redpash_id: String,
    pub company_id: String,
    pub name:       String,
    pub created_at: DateTime<Utc>,
}

/// A team in the requesting user's list — the record plus member
/// count, caller's own role, and the joined company name for display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamSummary {
    #[serde(flatten)]
    pub team:         Team,
    /// Convenience join — saves the FE a second `/companies` lookup to
    /// render the parent on the Home Teams tab.
    pub company_name: String,
    pub member_count: u32,
    /// The requesting user's role in this team: `owner` · `admin` · `member`.
    /// `None` when the caller isn't a member. List returns every team
    /// (broader-than-membership) so the Home tab shows teams the user
    /// might want to join — same convention as Companies.
    #[serde(default)]
    pub my_role:      Option<String>,
}

// Reusing `shared::company::CompanyMember` for the per-team members
// list — the membership shape is object-agnostic (the JOIN is on
// `memberships.object_redpash_id`, not a typed column), so a parallel
// `TeamMember` would only duplicate the type. See
// `routes/members.rs` for the shared CRUD layer.
