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
    #[serde(default)] pub description: Option<String>,
    #[serde(default)] pub r#type:      Option<String>,
    #[serde(default)] pub priority:    Option<String>,
    #[serde(default)] pub assignee_id: Option<String>,
    #[serde(default)] pub project_id:  Option<String>,
    #[serde(default)] pub company_id:  Option<String>,
}

/// Body of `PATCH /api/cases/:rid`. Sparse — every field optional.
/// Each non-None field emits a separate `case_<field>_change` event
/// via the audit-trail discipline (so the activity feed renders
/// "X changed status from todo to in_progress" as a discrete row, not
/// a bundled multi-field diff).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasePatchRequest {
    #[serde(default)] pub title:       Option<String>,
    #[serde(default)] pub description: Option<String>,
    #[serde(default)] pub r#type:      Option<String>,
    #[serde(default)] pub status:      Option<String>,
    #[serde(default)] pub priority:    Option<String>,
    #[serde(default)] pub assignee_id: Option<String>,
    #[serde(default)] pub project_id:  Option<String>,
    #[serde(default)] pub company_id:  Option<String>,
}

/// Body of `POST /api/cases/:rid/comments` (create) and
/// `PATCH /api/cases/:rid/comments/:cmt_rid` (edit). One field today.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentRequest {
    pub body: String,
}
