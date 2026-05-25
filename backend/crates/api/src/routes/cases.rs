//! `/api/cases/*` — Jira-flow workstream v1: case + comment CRUD.
//!
//! Cases are the team's coordination + customer-ticket layer on top
//! of the audit-everything spine. Case lifecycle changes (status,
//! priority, assignee, type, project, company) emit `events.kind =
//! 'case_*'` rows via the existing `event::record` path so the
//! activity feed query (the case detail page's "Activity" tab) is
//! literally `SELECT * FROM events WHERE context->>'case' = $1`.
//!
//! Endpoints:
//!   GET    /api/cases?status=&assignee=&project=&q=&page=&size=
//!   POST   /api/cases                                   create
//!   GET    /api/cases/:rid                              detail (case + comments + activity)
//!   PATCH  /api/cases/:rid                              sparse update
//!   DELETE /api/cases/:rid                              hard delete (CASCADE comments)
//!   GET    /api/cases/:rid/comments                     list (ASC by created_at)
//!   POST   /api/cases/:rid/comments                     new comment
//!   PATCH  /api/cases/:rid/comments/:cmt_rid            edit comment
//!   DELETE /api/cases/:rid/comments/:cmt_rid            delete comment
//!
//! Dev-permissive in v1 — any authenticated user can read/write any
//! case. Visibility + RBAC overlays land in v3 alongside the
//! customer-facing reporter path.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use shared::case::{
    Case, CaseCreateRequest, CaseDetail, CasePatchRequest, Category, Comment, CommentRequest,
};

use crate::{db, error::AppError, id, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",                          get(list).post(create))
        // Categories list — sits before `/:rid` so the literal
        // `categories` path doesn't get swallowed by the rid matcher.
        .route("/categories",                get(list_categories))
        .route("/:rid",                      get(get_one).patch(patch).delete(delete_one))
        .route("/:rid/comments",             get(list_comments).post(post_comment))
        .route("/:rid/comments/:cmt_rid",    axum::routing::patch(patch_comment).delete(delete_comment))
}

// ── handlers ───────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)] status:   Option<String>,
    #[serde(default)] assignee: Option<String>,
    #[serde(default)] project:  Option<String>,
    #[serde(default)] q:        Option<String>,
    #[serde(default)] page:     Option<u32>,
    #[serde(default)] size:     Option<u32>,
    /// Click-to-sort header support. Validated against SORTABLE_CASES;
    /// bad values fall back to `updated_at`. dir → "asc"|"desc" (default
    /// "desc"). Same shape as AdminQuery.
    #[serde(default)] sort:     Option<String>,
    #[serde(default)] dir:      Option<String>,
}

/// Wire-keys the Home Cases tab can pass via ?sort=. Mirrors the
/// LIST_VIEWS.cases column spec on the frontend.
const SORTABLE_CASES: &[&str] = &[
    "title", "type", "status", "priority", "assignee_display_name", "updated_at",
];

#[derive(Serialize)]
struct CaseList {
    items: Vec<Case>,
    total: u64,
    page:  u32,
    size:  u32,
}

// ── categories ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct CategoryList { items: Vec<Category> }

/// Flat list of categories the caller can pick from. v1 returns the
/// global / built-in seed taxonomy; v3 will union per-company entries
/// once RBAC overlays per-user visibility. FE groups by `parent_id`
/// to build the picker tree.
async fn list_categories(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<CategoryList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_categories(&state.db, Some(&user)).await?;
    Ok(Json(CategoryList { items }))
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Query(q):     Query<ListQuery>,
) -> Result<Json<CaseList>, AppError> {
    super::resolve_user_rid(&state, &headers).await?;
    let page = q.page.unwrap_or(1).max(1);
    let size = q.size.unwrap_or(50).clamp(1, 500);
    let offset = ((page - 1) as i64) * (size as i64);

    let trim = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let status   = trim(q.status);
    let assignee = trim(q.assignee);
    let project  = trim(q.project);
    let qtext    = trim(q.q);

    let (sort_key, sort_dir) = super::admin::sort_clause(
        q.sort.as_deref(), q.dir.as_deref(), SORTABLE_CASES, "updated_at",
    );
    let sort_col = match sort_key.as_str() {
        "title"                 => "c.title",
        "type"                  => "c.type",
        "status"                => "c.status",
        "priority"              => "c.priority",
        // Assignee sorts by hydrated display_name (NULL when unassigned;
        // NULLS LAST in the SQL keeps unassigned cases at the tail).
        "assignee_display_name" => "a.display_name",
        _                       => "c.updated_at",
    };

    let items = db::list_cases(
        &state.db,
        status.as_deref(),
        assignee.as_deref(),
        project.as_deref(),
        qtext.as_deref(),
        sort_col, sort_dir,
        size as i64, offset,
    ).await?;

    let total = db::count_cases(
        &state.db,
        status.as_deref(), assignee.as_deref(), project.as_deref(), qtext.as_deref(),
    ).await? as u64;

    Ok(Json(CaseList { items, total, page, size }))
}

async fn create(
    State(state):  State<AppState>,
    headers:       HeaderMap,
    Json(req):     Json<CaseCreateRequest>,
) -> Result<(StatusCode, Json<Case>), AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let title = req.title.trim();
    if title.is_empty() {
        return Err(AppError::bad_request("invalid", "title is required"));
    }
    let description   = req.description.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // error_message keeps internal whitespace (stack traces are
    // significant by line); only outer trim to drop leading/trailing
    // newlines from copy-paste. Empty string still maps to None.
    let error_message = req.error_message.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let category_id   = req.category_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let type_         = req.r#type.as_deref().unwrap_or("task");
    let priority      = req.priority.as_deref().unwrap_or("medium");
    let rid           = id::new("CAS");

    let case = db::insert_case(
        &state.db, &rid,
        title,
        description,
        type_,
        "backlog",   // initial status — every case starts in the backlog column
        priority,
        Some(&user), // reporter is the caller
        req.assignee_id.as_deref(),
        req.project_id.as_deref(),
        req.company_id.as_deref(),
        error_message,
        category_id,
    ).await?;

    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "case_create".into(),
        message: format!("created case {rid}: {title}"),
        user:    Some(user),
        context: serde_json::json!({
            "case":     rid,
            "type":     type_,
            "priority": priority,
            "assignee": req.assignee_id,
            "project":  req.project_id,
        }),
        ..Default::default()
    });

    Ok((StatusCode::CREATED, Json(case)))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<CaseDetail>, AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // visibility overlay (reporter / assignee / company role) lands in v3
    super::resolve_user_rid(&state, &headers).await?;
    let case = db::find_case(&state.db, &rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("case {rid}")))?;
    let comments = db::list_comments_for_case(&state.db, &rid).await?;
    let activity = db::list_activity_for_case(&state.db, &rid).await?;
    Ok(Json(CaseDetail { case, comments, activity }))
}

async fn patch(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<CasePatchRequest>,
) -> Result<Json<Case>, AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // mutate-gate (reporter / assignee / admin) lands in v3 overlay
    let user = super::resolve_user_rid(&state, &headers).await?;

    // Fetch the existing case so each changed field's event carries
    // both the old + new value. One DB read; cheap.
    let existing = db::find_case(&state.db, &rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("case {rid}")))?;

    let trim = |o: Option<String>| o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let title         = trim(body.title);
    let description   = trim(body.description);
    let type_         = trim(body.r#type);
    let status        = trim(body.status);
    let priority      = trim(body.priority);
    let assignee_id   = trim(body.assignee_id);
    let project_id    = trim(body.project_id);
    let company_id    = trim(body.company_id);
    let error_message = trim(body.error_message);
    let category_id   = trim(body.category_id);

    // Validate enum values before the DB write so we return a clean
    // 400 instead of letting Postgres CHECK constraint surface as 500.
    if let Some(t) = type_.as_deref() {
        if !matches!(t, "bug" | "feature" | "task" | "epic") {
            return Err(AppError::bad_request("invalid", "type must be bug | feature | task | epic"));
        }
    }
    if let Some(s) = status.as_deref() {
        if !matches!(s, "backlog" | "todo" | "in_progress" | "in_review" | "done") {
            return Err(AppError::bad_request("invalid", "status must be backlog | todo | in_progress | in_review | done"));
        }
    }
    if let Some(p) = priority.as_deref() {
        if !matches!(p, "low" | "medium" | "high" | "critical") {
            return Err(AppError::bad_request("invalid", "priority must be low | medium | high | critical"));
        }
    }

    let updated = db::update_case(
        &state.db, &rid,
        title.as_deref(),
        description.as_deref(),
        type_.as_deref(),
        status.as_deref(),
        priority.as_deref(),
        assignee_id.as_deref(),
        project_id.as_deref(),
        company_id.as_deref(),
        error_message.as_deref(),
        category_id.as_deref(),
    ).await?
    .ok_or_else(|| AppError::not_found("not_found", format!("case {rid}")))?;

    // Emit one `case_<field>_change` event per changed field. The
    // activity feed reads each as a discrete row — "status: todo →
    // in_progress" is one entry, "assignee: USR_A → USR_B" another.
    // No bundled multi-field diffs; each carries old/new so the UI
    // doesn't need to reconstruct from the case row alone.
    let emit_change = |field: &'static str, old: &str, new: &str| {
        if old == new { return; }
        crate::event::record(&state.db, crate::event::EventDraft {
            origin:  "backend",
            level:   "info",
            kind:    format!("case_{field}_change"),
            message: format!("case {rid}: {field} {old} -> {new}"),
            user:    Some(user.clone()),
            context: serde_json::json!({
                "case":  rid,
                "field": field,
                "old":   old,
                "new":   new,
            }),
            ..Default::default()
        });
    };

    if let Some(ref s) = status   { emit_change("status",   &existing.status,   s); }
    if let Some(ref p) = priority { emit_change("priority", &existing.priority, p); }
    if let Some(ref t) = type_    { emit_change("type",     &existing.r#type,   t); }
    if let Some(ref a) = assignee_id {
        emit_change("assignee", existing.assignee_id.as_deref().unwrap_or(""), a);
    }
    if let Some(ref c) = category_id {
        emit_change("category", existing.category_id.as_deref().unwrap_or(""), c);
    }
    // title / description / project / company changes are quieter
    // edits — emit a single `case_metadata_change` summarising which
    // fields touched, not one event per field. Keeps the activity
    // feed signal-heavy.
    let mut metadata_fields: Vec<&str> = Vec::new();
    if title.is_some()         { metadata_fields.push("title");         }
    if description.is_some()   { metadata_fields.push("description");   }
    if project_id.is_some()    { metadata_fields.push("project");       }
    if company_id.is_some()    { metadata_fields.push("company");       }
    if error_message.is_some() { metadata_fields.push("error_message"); }
    if !metadata_fields.is_empty() {
        crate::event::record(&state.db, crate::event::EventDraft {
            origin:  "backend",
            level:   "info",
            kind:    "case_metadata_change".into(),
            message: format!("case {rid}: edited {} fields", metadata_fields.len()),
            user:    Some(user.clone()),
            context: serde_json::json!({
                "case":   rid,
                "fields": metadata_fields,
            }),
            ..Default::default()
        });
    }

    Ok(Json(updated))
}

async fn delete_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // delete-gate (reporter / admin) lands in v3 overlay
    let user = super::resolve_user_rid(&state, &headers).await?;
    let removed = db::delete_case(&state.db, &rid).await?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("case {rid}")));
    }
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "warn",
        kind:    "case_delete".into(),
        message: format!("deleted case {rid}"),
        user:    Some(user),
        context: serde_json::json!({ "case": rid }),
        ..Default::default()
    });
    Ok(StatusCode::NO_CONTENT)
}

// ── comments sub-router ────────────────────────────────────────────

#[derive(Serialize)]
struct CommentList { items: Vec<Comment> }

async fn list_comments(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<CommentList>, AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // visibility gate lands in v3 alongside the case overlay
    super::resolve_user_rid(&state, &headers).await?;
    // Verify the case exists so we 404 cleanly rather than returning
    // an empty list for a typo'd rid.
    if db::find_case(&state.db, &rid).await?.is_none() {
        return Err(AppError::not_found("not_found", format!("case {rid}")));
    }
    let items = db::list_comments_for_case(&state.db, &rid).await?;
    Ok(Json(CommentList { items }))
}

async fn post_comment(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(req):    Json<CommentRequest>,
) -> Result<(StatusCode, Json<Comment>), AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // post-gate (case visibility) lands in v3 overlay
    let user = super::resolve_user_rid(&state, &headers).await?;
    let body = req.body.trim();
    if body.is_empty() {
        return Err(AppError::bad_request("invalid", "comment body is required"));
    }
    if db::find_case(&state.db, &rid).await?.is_none() {
        return Err(AppError::not_found("not_found", format!("case {rid}")));
    }
    let cmt_rid = id::new("CMT");
    let comment = db::insert_comment(&state.db, &cmt_rid, &rid, Some(&user), body).await?;

    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "case_comment_post".into(),
        message: format!("case {rid}: new comment {cmt_rid}"),
        user:    Some(user),
        context: serde_json::json!({ "case": rid, "comment": cmt_rid }),
        ..Default::default()
    });

    Ok((StatusCode::CREATED, Json(comment)))
}

async fn patch_comment(
    State(state):        State<AppState>,
    headers:             HeaderMap,
    Path((rid, cmt_rid)):Path<(String, String)>,
    Json(req):           Json<CommentRequest>,
) -> Result<Json<Comment>, AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // author-only edit gate lands in v3 overlay
    let user = super::resolve_user_rid(&state, &headers).await?;
    let body = req.body.trim();
    if body.is_empty() {
        return Err(AppError::bad_request("invalid", "comment body is required"));
    }
    // Verify the comment exists AND belongs to the case in the URL so
    // a typo'd path doesn't silently edit a comment on the wrong case.
    let existing = db::find_comment(&state.db, &cmt_rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("comment {cmt_rid}")))?;
    if existing.case_id != rid {
        return Err(AppError::not_found("not_found", format!("comment {cmt_rid}")));
    }
    let updated = db::update_comment(&state.db, &cmt_rid, body).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("comment {cmt_rid}")))?;

    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "case_comment_edit".into(),
        message: format!("case {rid}: edited comment {cmt_rid}"),
        user:    Some(user),
        context: serde_json::json!({ "case": rid, "comment": cmt_rid }),
        ..Default::default()
    });

    Ok(Json(updated))
}

async fn delete_comment(
    State(state):         State<AppState>,
    headers:              HeaderMap,
    Path((rid, cmt_rid)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    // AUTH-AUDIT-ACK: cases dev-permissive in v1 per [[redpash-stage]];
    // author-only delete gate lands in v3 overlay
    let user = super::resolve_user_rid(&state, &headers).await?;
    let existing = db::find_comment(&state.db, &cmt_rid).await?
        .ok_or_else(|| AppError::not_found("not_found", format!("comment {cmt_rid}")))?;
    if existing.case_id != rid {
        return Err(AppError::not_found("not_found", format!("comment {cmt_rid}")));
    }
    let removed = db::delete_comment(&state.db, &cmt_rid).await?;
    if !removed {
        return Err(AppError::not_found("not_found", format!("comment {cmt_rid}")));
    }
    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "case_comment_delete".into(),
        message: format!("case {rid}: deleted comment {cmt_rid}"),
        user:    Some(user),
        context: serde_json::json!({ "case": rid, "comment": cmt_rid }),
        ..Default::default()
    });
    Ok(StatusCode::NO_CONTENT)
}
