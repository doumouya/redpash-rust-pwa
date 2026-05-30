//! Doc: docs/internal/code/backend/shared/search.md
//! Omnisearch DTOs — wire shape for `GET /api/search`.
//!
//! One flat list of results, `kind`-discriminated. Frontend groups by
//! `kind` for display and uses the per-result `hash` to navigate
//! without baking routing rules into the JS — backend names the
//! destination, frontend just goes there.
//!
//! `sub` is the contextual line below the result label: project
//! description for projects, parent project name for files/charts/
//! dashboards. Empty string when there's nothing useful to surface.
//!
//! See docs/internal/admin-monitoring-surfaces.md §6 for the wider
//! shape conventions this aligns with (kind discriminators, hash-as-
//! navigation-target). Phase 1 is user-scoped (owner_id = caller);
//! Phase 4 adds `?scope=admin` for org-wide search when RBAC ships.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// `project | file | chart | dashboard | user | company | membership`
    /// (the kinds the search handler currently emits).
    pub kind:  String,
    pub rid:   String,
    pub label: String,
    /// Sub-label / context line. Project: description (or empty);
    /// file/chart/dashboard: "in <project_name>".
    #[serde(default)] pub sub: String,
    /// Navigation target — a hash fragment the frontend assigns to
    /// `location.hash`. Backend owns the routing rule per kind so
    /// adding a new kind doesn't require a frontend switch update.
    pub hash:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    /// Echoed back so the frontend can correlate a late response with
    /// the current input value (drop the response if the user has
    /// kept typing past it).
    pub q:       String,
    pub results: Vec<SearchResult>,
    /// Server-side time spent — useful both for the search input's
    /// own "fast feel" indicator and for the perf-capture log.
    pub ms:      u32,
}
