//! Doc: docs/internal/code/backend/shared/case.md
//! Case + Comment DTOs — the Jira-flow workstream's wire shapes.
//!
//! Case lifecycle changes are NOT modelled as a parallel struct here;
//! they live as `events.kind = 'case_*'` rows persisted through the
//! existing `event::record` path (cat-3 audit-trail discipline). The
//! case detail page's Activity tab consumes `Event` records filtered
//! by `context->>'case'`, not a separate History DTO.
//!
//! Spec: docs/internal/jira-flow-proposition/proposition.md.

use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

/// One row in `GET /api/cases/categories`. Flat shape — the FE
/// groups by `parent_id` to build the hierarchical picker. Roots
/// have `parent_id = None`; subcategories have it set. `company_id`
/// is null for global / built-in categories (the v1 seeded taxonomy);
/// non-null entries are per-company customisations that v3 will
/// gate by RBAC visibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub redpash_id: String,
    pub name:       String,
    #[serde(default)] pub parent_id:  Option<String>,
    #[serde(default)] pub company_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// One row in `GET /api/cases` + the body of `GET /api/cases/:rid`
/// (sans the comments + activity feed — those live on `CaseDetail`
/// below). Mirrors the cases table verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Case {
    pub redpash_id:  String,
    /// One of `bug | feature | task | epic`.
    pub r#type:      String,
    pub title:       String,
    #[serde(default)] pub description: Option<String>,
    /// `backlog | todo | in_progress | in_review | done`. Click-cycle
    /// on the kanban advances through these (wraps to backlog on a
    /// done-click).
    pub status:      String,
    /// `low | medium | high | critical`.
    pub priority:    String,
    #[serde(default)] pub reporter_id: Option<String>,
    #[serde(default)] pub assignee_id: Option<String>,
    #[serde(default)] pub project_id:  Option<String>,
    #[serde(default)] pub company_id:  Option<String>,
    /// Hydrated server-side via LEFT JOIN users. The FE card +
    /// detail page render `display_name || rid || "—"` so the user
    /// sees a readable name instead of `USR_abc123…`. Null when the
    /// user no longer exists (FK is ON DELETE SET NULL — the case
    /// outlives the deletion).
    #[serde(default)] pub reporter_display_name: Option<String>,
    #[serde(default)] pub assignee_display_name: Option<String>,
    /// Raw error payload for cases auto-triaged from error-class
    /// events (FE crashes / panics / 5xx). Distinct from
    /// `description` (markdown prose) so the FE can render it as a
    /// monospace `<pre>` and the auto-triage dedup hash can compute
    /// over a stable shape. Null for manually-filed cases.
    #[serde(default)] pub error_message: Option<String>,
    /// Taxonomy slot. Single FK — a case has at most one
    /// (sub)category. Hydrated `*_name` fields below let the FE
    /// render "Backend > API" without a separate categories fetch
    /// per case. All three are null when the case is uncategorised.
    #[serde(default)] pub category_id:          Option<String>,
    #[serde(default)] pub category_name:        Option<String>,
    #[serde(default)] pub category_parent_id:   Option<String>,
    #[serde(default)] pub category_parent_name: Option<String>,
    /// File references attached to the case (bug-report evidence:
    /// logs, error screenshots, repro CSVs). A JSON array of
    /// `{ name, mime, size, uploaded_at }` objects; `[]` when none.
    /// v1 is metadata-only — byte upload/preview is a later slice.
    #[serde(default)] pub attachments: serde_json::Value,
    pub created_at:  DateTime<Utc>,
    pub updated_at:  DateTime<Utc>,
}

/// One row in `GET /api/cases/:rid/comments` + the embedded list on
/// `CaseDetail`. Threaded replies + attachments deferred to v2/v3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub redpash_id: String,
    pub case_id:    String,
    #[serde(default)] pub author_id: Option<String>,
    /// Hydrated server-side via LEFT JOIN users. The FE thread render
    /// (`.rp-cases-comment-author`) reads `display_name || rid || "—"`
    /// so the user sees a readable name instead of `USR_abc123…`. Null
    /// when the author no longer exists (FK is ON DELETE SET NULL —
    /// the comment outlives the deletion).
    #[serde(default)] pub author_display_name: Option<String>,
    pub body:       String,
    pub is_edited:  bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Returned by `GET /api/cases/:rid`. Three sections:
///   - the case row itself
///   - chronological comment thread (ASC by created_at)
///   - activity feed: `Event` rows from the audit log filtered to
///     `context->>'case' == rid`, time-ordered ASC. Reuses the
///     audit-everything spine — no separate history table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseDetail {
    pub case:     Case,
    pub comments: Vec<Comment>,
    pub activity: Vec<crate::event::Event>,
}

/// Body of `POST /api/cases`. Required: title. Everything else
/// defaults server-side (type=task, status=backlog, priority=medium,
/// reporter=resolved-from-session, all other refs None).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseCreateRequest {
    pub title: String,
    #[serde(default)] pub description:   Option<String>,
    #[serde(default)] pub r#type:        Option<String>,
    #[serde(default)] pub priority:      Option<String>,
    #[serde(default)] pub assignee_id:   Option<String>,
    #[serde(default)] pub project_id:    Option<String>,
    #[serde(default)] pub company_id:    Option<String>,
    /// Auto-triage path populates this with the raw error string;
    /// manual creates leave it null.
    #[serde(default)] pub error_message: Option<String>,
    /// Pick a leaf (subcategory) when one fits; pick a parent rid
    /// directly when the case is broadly "Backend" with no fitting
    /// sub. Null = uncategorised.
    #[serde(default)] pub category_id:   Option<String>,
}

/// Body of `PATCH /api/cases/:rid`. Sparse — every field optional.
/// Each non-None field emits a separate `case_<field>_change` event
/// via the audit-trail discipline (so the activity feed renders
/// "X changed status from todo to in_progress" as a discrete row, not
/// a bundled multi-field diff).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasePatchRequest {
    #[serde(default)] pub title:         Option<String>,
    #[serde(default)] pub description:   Option<String>,
    #[serde(default)] pub r#type:        Option<String>,
    #[serde(default)] pub status:        Option<String>,
    #[serde(default)] pub priority:      Option<String>,
    #[serde(default)] pub assignee_id:   Option<String>,
    #[serde(default)] pub project_id:    Option<String>,
    #[serde(default)] pub company_id:    Option<String>,
    #[serde(default)] pub error_message: Option<String>,
    #[serde(default)] pub category_id:   Option<String>,
    /// Replace the case's attachment list (a JSON array of
    /// `{ name, mime, size, uploaded_at }`). `None` leaves it untouched.
    #[serde(default)] pub attachments:   Option<serde_json::Value>,
}

/// Body of `POST /api/cases/:rid/comments` (create) and
/// `PATCH /api/cases/:rid/comments/:cmt_rid` (edit). One field today.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentRequest {
    pub body: String,
}
