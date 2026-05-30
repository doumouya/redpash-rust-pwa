//! Doc: docs/internal/code/backend/shared/user.md
//! User + profile + preferences.
//!
//! Mirrors `core.UserProfile` from the Django side. The `prefs` JSON
//! blob holds everything that doesn't deserve a column (theme, accent
//! hue, default rows-per-page, …) — keep it small but free-form.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub redpash_id:   String,
    pub username:     String,
    pub email:        Option<String>,
    pub display_name: String,
    /// Structured name fields. Optional — pre-2026-05-22 rows backfill
    /// from display_name, which stays the friendly label (avatar
    /// initials, UI). New payloads may omit them, hence #[serde(default)].
    #[serde(default)]
    pub first_name:   Option<String>,
    #[serde(default)]
    pub last_name:    Option<String>,
    pub avatar_url:   Option<String>,
    pub job_title:    Option<String>,
    pub organisation: Option<String>,
    pub use_case:     Option<String>,
    pub plan:         String,
    pub locale:       String,
    pub prefs:        serde_json::Value,
    /// Per-company membership rows joined in by `/api/users`. Empty when
    /// the user belongs to no company, omitted by single-row fetchers
    /// (find_user_by_id, find_user_by_username, /me) that don't take
    /// the join — `#[serde(default)]` keeps them deserialising fine.
    #[serde(default)]
    pub memberships:  Vec<UserMembership>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMembership {
    pub company_id:   String,
    pub company_name: String,
    pub role:         String,
}

/// Body for `PATCH /api/me/prefs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrefsPatch {
    /// Sparse object — only keys present overwrite.
    pub prefs: serde_json::Value,
}
