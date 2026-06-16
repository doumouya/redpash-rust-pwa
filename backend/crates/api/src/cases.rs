//! Purpose: the dedicated `/api/cases` surface — the agent-handoff workflow that
//! generic `/objects/case` (browse + delete only) can't carry. This is what the
//! MCP client (`tools/mcp-server/dist/cases.js`) already speaks, and what the
//! kanban + detail UI consume: create, a filtered list, a CaseDetail (row +
//! comments + activity), comments, and the status PATCH with the WORKFLOW ENGINE.
//!
//! The engine is workflows-as-DATA, keyed by `cases.source`: a pure transition
//! map (no DB). PATCH ENFORCES `to ∈ transitions[from]` → else 422
//! `invalid_transition` (the MCP surfaces the body message to the agent, so a
//! rejected `setCaseStatus` skip propagates for free). The enum CHECK on
//! `cases.status` is the DB backstop. AUTOMATE (assignee-set→todo, …) and the
//! EXTERNAL workflow are designed below but DORMANT — see `workflow`.
//!
//! `case` stays `registry_read_only` in objects.rs (browse + delete via
//! /objects/case); create / comment / workflow / attachments live ONLY here.

use axum::{
    extract::{Multipart, Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db,
    error::AppError,
    event, id,
    objects::CASE_REACH,
    pipeline,
    rbac::{self, Action, Caller, Role},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        // STATIC before the `:rid` matcher — axum prefers the literal segment, so
        // `/cases/workflows` never resolves as a case lookup. Do not fold into `:rid`.
        .route("/workflows", get(workflows))
        .route("/:rid", get(get_one).patch(patch))
        .route("/:rid/comments", post(add_comment))
        .route("/:rid/attachments", get(list_attachments).post(add_attachment))
        .route("/:rid/attachments/:att", get(download_attachment).delete(delete_attachment))
}

// ─── the workflow engine: workflows-as-data, keyed by `source` ──────────────
mod workflow {
    /// INTERNAL (live) — matches the `cases.status` CHECK + the MCP enum exactly.
    /// Permissive transitions: forward + one-step-back + reopen-from-done. A kanban
    /// drag routinely moves a card back a column, so forbidding that would 422 a
    /// recoverable mis-click; illegal SKIPS (e.g. backlog→done) are still rejected.
    /// (Em toggle: strict forward-only is a one-line change to this table.)
    const INTERNAL_STATES: [&str; 5] = ["backlog", "todo", "in_progress", "in_review", "done"];
    const INTERNAL: [(&str, &[&str]); 5] = [
        ("backlog", &["todo", "in_progress"]),
        ("todo", &["in_progress", "backlog"]),
        ("in_progress", &["in_review", "todo", "backlog"]),
        ("in_review", &["done", "in_progress", "todo"]),
        ("done", &["in_progress", "in_review"]),
    ];

    /// EXTERNAL (dormant) — DESIGNED but unreachable: the `cases.status` CHECK does
    /// not permit these states and no path creates `source='external'` cases yet.
    /// Lighting it up needs a CHECK-widening migration + an external-create path
    /// (a later slice). Accept/Refuse are the two edges out of "Solution Provided".
    const EXTERNAL_STATES: [&str; 5] = ["New", "Assess", "Research", "Solution Provided", "Closed"];
    const EXTERNAL: [(&str, &[&str]); 5] = [
        ("New", &["Assess"]),
        ("Assess", &["Research"]),
        ("Research", &["Solution Provided"]),
        ("Solution Provided", &["Closed", "Research"]),
        ("Closed", &[]),
    ];

    pub fn initial(source: &str) -> &'static str {
        match source {
            "external" => "New",
            _ => "backlog",
        }
    }

    pub fn states(source: &str) -> &'static [&'static str] {
        match source {
            "external" => &EXTERNAL_STATES,
            _ => &INTERNAL_STATES,
        }
    }

    pub fn transitions(source: &str) -> &'static [(&'static str, &'static [&'static str])] {
        match source {
            "external" => &EXTERNAL,
            _ => &INTERNAL,
        }
    }

    /// Is `from → to` an allowed move for this workflow? Same-state is an idempotent
    /// no-op (a kanban re-drop onto the same column). Otherwise `to` must be listed
    /// in `transitions[from]`.
    pub fn is_valid(source: &str, from: &str, to: &str) -> bool {
        if from == to {
            return true;
        }
        transitions(source)
            .iter()
            .any(|(f, tos)| *f == from && tos.contains(&to))
    }

    pub fn is_known_state(source: &str, status: &str) -> bool {
        states(source).contains(&status)
    }
}

fn workflow_json(source: &str) -> Value {
    let transitions: serde_json::Map<String, Value> = workflow::transitions(source)
        .iter()
        .map(|(from, tos)| ((*from).to_string(), json!(tos)))
        .collect();
    json!({
        "initial": workflow::initial(source),
        "states": workflow::states(source),
        "transitions": Value::Object(transitions),
    })
}

/// GET /api/cases/workflows — the workflow defs, so the kanban renders the right
/// columns + the UI knows valid next-steps. Any authed caller (defs aren't secret).
async fn workflows(_caller: Caller) -> Json<Value> {
    Json(json!({ "internal": workflow_json("internal"), "external": workflow_json("external") }))
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// The case row as JSON (column names; the legacy `attachments` jsonb stripped —
/// real attachments come from `case_attachments`). Timestamps serialize as ISO.
async fn fetch_case(pool: &PgPool, rid: &str) -> Result<Option<Value>, AppError> {
    Ok(sqlx::query_scalar("SELECT to_jsonb(c) - 'attachments' FROM cases c WHERE redpash_id = $1")
        .bind(rid)
        .fetch_optional(pool)
        .await?)
}

/// Trim + empty→None: a blank optional FK must be NULL (not "", which would FK-fail).
fn opt(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

// ─── handlers ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateBody {
    title: String,
    description: Option<String>,
    #[serde(rename = "type")]
    case_type: Option<String>,
    priority: Option<String>,
    assignee_id: Option<String>,
    project_id: Option<String>,
    company_id: Option<String>,
}

const TYPES: [&str; 4] = ["bug", "feature", "task", "epic"];
const PRIORITIES: [&str; 4] = ["low", "medium", "high", "critical"];

/// POST /api/cases — create an internal case. Member+ on each supplied scope_parent
/// (IDOR guard); status = the workflow initial; reporter = caller; creator owns it.
async fn create(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<CreateBody>,
) -> Result<(axum::http::StatusCode, Json<Value>), AppError> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::bad_request("title_required", "case title is required"));
    }
    let case_type = body.case_type.as_deref().unwrap_or("task");
    if !TYPES.contains(&case_type) {
        return Err(AppError::bad_request("invalid_type", format!("type must be one of {TYPES:?}")));
    }
    let priority = body.priority.as_deref().unwrap_or("medium");
    if !PRIORITIES.contains(&priority) {
        return Err(AppError::bad_request("invalid_priority", format!("priority must be one of {PRIORITIES:?}")));
    }
    let company_id = opt(&body.company_id);
    let project_id = opt(&body.project_id);
    let assignee_id = opt(&body.assignee_id);

    // IDOR guard (objects.rs builtin_create pattern): a caller-supplied scope_parent
    // must be reachable at >= Member, else any authed user could graft a case under a
    // foreign company/project and hand its admins cascade write. 404 leak-free.
    for (parent, kind) in [(company_id, "company"), (project_id, "project")] {
        if let Some(p) = parent {
            rbac::require_rule(&state.db, &state.type_cache, &caller, p, kind, |g| {
                g.effective().is_some_and(|r| r >= Role::Member)
            })
            .await?;
        }
    }
    // assignee must exist (a workflow ref, not a scope edge) — clean 400 over a raw FK 500.
    if let Some(a) = assignee_id {
        let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM users WHERE redpash_id = $1")
            .bind(a)
            .fetch_optional(&state.db)
            .await?;
        if exists.is_none() {
            return Err(AppError::bad_request("invalid_assignee", format!("no such user {a}")));
        }
    }

    let source = "internal";
    let status = workflow::initial(source);
    let rid = id::new("CAS");
    let mut tx = state.db.begin().await?;
    db::register_entity(&mut tx, &rid, "case").await?;
    sqlx::query(
        "INSERT INTO cases
           (redpash_id, company_id, project_id, title, description, type, priority, status, source, reporter_id, assignee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&rid)
    .bind(company_id)
    .bind(project_id)
    .bind(title)
    .bind(body.description.as_deref().unwrap_or("").trim())
    .bind(case_type)
    .bind(priority)
    .bind(status)
    .bind(source)
    .bind(&caller.rid)
    .bind(assignee_id)
    .execute(&mut *tx)
    .await?;
    db::grant_owner(&mut tx, &rid, &caller.rid).await?;
    tx.commit().await?;

    // `"case": rid` is the load-bearing context key — the events_case_idx indexes it,
    // so the activity feed for this case is queryable.
    event::info(
        &state.db,
        "case_create",
        format!("created case {rid}"),
        Some(caller.rid.clone()),
        json!({ "case": rid, "type": "case", "rid": rid }),
    );

    let row = fetch_case(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::internal("case", "created case row not found"))?;
    Ok((axum::http::StatusCode::CREATED, Json(row)))
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
    assignee: Option<String>,
    project: Option<String>,
    q: Option<String>,
    page: Option<i64>,
    size: Option<i64>,
}

/// GET /api/cases — reach-scoped list with status/assignee/project/q filters +
/// pagination. Shape `{items, total, page, size}` (the exact MCP/kanban contract).
async fn list(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, AppError> {
    // viewer = None ⇒ platform admin (no reach filter); else the principal closure.
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };
    let page = q.page.unwrap_or(1).max(1);
    let size = q.size.unwrap_or(50).clamp(1, 500);
    let offset = (page - 1) * size;

    // CASE_REACH is a trusted const (objects.rs), not input — safe to interpolate.
    // $1 = principals; $2..$5 = filters (NULL ⇒ no filter); $6/$7 = limit/offset.
    let filters = "AND ($2::text IS NULL OR t.status = $2) \
                   AND ($3::text IS NULL OR t.assignee_id = $3) \
                   AND ($4::text IS NULL OR t.project_id = $4) \
                   AND ($5::text IS NULL OR concat_ws(' ', t.title, t.description) ILIKE '%' || $5 || '%')";

    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*)::BIGINT FROM cases t WHERE {CASE_REACH} {filters}"
    ))
    .bind(viewer.as_deref())
    .bind(&q.status)
    .bind(&q.assignee)
    .bind(&q.project)
    .bind(&q.q)
    .fetch_one(&state.db)
    .await?;

    let items: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(t) - 'attachments' FROM cases t \
         WHERE {CASE_REACH} {filters} \
         ORDER BY t.created_at DESC LIMIT $6 OFFSET $7"
    ))
    .bind(viewer.as_deref())
    .bind(&q.status)
    .bind(&q.assignee)
    .bind(&q.project)
    .bind(&q.q)
    .bind(size)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({ "items": items, "total": total, "page": page, "size": size })))
}

/// GET /api/cases/:rid — CaseDetail = the case row + comments + activity feed +
/// attachments metadata. View reach (404 leak-free, cascades via company/project).
async fn get_one(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let case = fetch_case(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("case {rid}")))?;

    let comments: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(cc) FROM case_comments cc WHERE case_id = $1 ORDER BY created_at",
    )
    .bind(&rid)
    .fetch_all(&state.db)
    .await?;

    // The activity feed: every event tagged with this case (the events_case_idx).
    let activity: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM events e WHERE e.context->>'case' = $1 ORDER BY e.at DESC LIMIT 500",
    )
    .bind(&rid)
    .fetch_all(&state.db)
    .await?;

    // Metadata only — storage_path (server FS) never crosses the wire.
    let attachments: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(a) - 'storage_path' FROM case_attachments a WHERE case_id = $1 ORDER BY created_at",
    )
    .bind(&rid)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({
        "case": case,
        "comments": comments,
        "activity": activity,
        "attachments": attachments,
    })))
}

#[derive(Deserialize)]
struct CommentBody {
    body: String,
}

/// POST /api/cases/:rid/comments — Edit reach. Emits a queryable activity event.
async fn add_comment(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<CommentBody>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    // Admin reach is unconditional → confirm the case exists before the insert, else
    // the FK violation would surface as a 500 instead of a clean 404.
    if fetch_case(&state.db, &rid).await?.is_none() {
        return Err(AppError::not_found("not_found", format!("case {rid}")));
    }
    let text = body.body.trim();
    if text.is_empty() {
        return Err(AppError::bad_request("empty_comment", "comment body is required"));
    }
    // SECURITY CONTRACT: `body` is stored as RAW PLAIN TEXT — there is no server-side
    // HTML sanitizer. The detail-drawer renderer (Phase C, FE) MUST escape it
    // (textContent, never innerHTML). The init-migration's "sanitized HTML" column
    // comment is an aspirational note predating this surface; it's an applied migration,
    // so it can't be corrected in place — this is the authoritative contract.
    let cid = id::new("CMT");
    sqlx::query("INSERT INTO case_comments (id, case_id, author_id, body) VALUES ($1, $2, $3, $4)")
        .bind(&cid)
        .bind(&rid)
        .bind(&caller.rid)
        .bind(text)
        .execute(&state.db)
        .await?;
    event::info(
        &state.db,
        "case_comment",
        format!("commented on case {rid}"),
        Some(caller.rid.clone()),
        json!({ "case": rid }),
    );
    let comment: Value =
        sqlx::query_scalar("SELECT to_jsonb(cc) FROM case_comments cc WHERE id = $1")
            .bind(&cid)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(comment))
}

#[derive(Deserialize)]
struct PatchBody {
    status: String,
}

/// PATCH /api/cases/:rid — THE WORKFLOW ENGINE. Edit reach; enforce the transition
/// (422 on an illegal move); record the "X → Y" activity event.
async fn patch(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<PatchBody>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    // require_action 404s a non-existent/unreachable case for a NON-admin, but returns
    // Ok immediately for a platform admin (no existence check) — so a missing rid must
    // be handled here: fetch_optional → clean 404, never a RowNotFound 500.
    let (from, source): (String, String) =
        sqlx::query_as("SELECT status, source FROM cases WHERE redpash_id = $1")
            .bind(&rid)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::not_found("not_found", format!("case {rid}")))?;
    let to = body.status.trim();

    if !workflow::is_known_state(&source, to) {
        return Err(AppError::unprocessable(
            "invalid_status",
            format!("'{to}' is not a status of the {source} workflow"),
        ));
    }
    if !workflow::is_valid(&source, &from, to) {
        return Err(AppError::unprocessable(
            "invalid_transition",
            format!("{from} → {to} is not an allowed transition for {source} cases"),
        ));
    }

    sqlx::query("UPDATE cases SET status = $1, updated_at = now() WHERE redpash_id = $2")
        .bind(to)
        .bind(&rid)
        .execute(&state.db)
        .await?;
    event::info(
        &state.db,
        "case_status",
        format!("status: {from} → {to}"),
        Some(caller.rid.clone()),
        json!({ "case": rid, "from": from, "to": to }),
    );

    let row = fetch_case(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::internal("case", "updated case row not found"))?;
    Ok(Json(row))
}

// ─── attachments: bytes immutable on disk, METADATA-only in Postgres ────────

/// POST /api/cases/:rid/attachments — Edit reach. Multipart `file` (RAW store via
/// the sealed pipeline::upload_attachment) + optional `comment_id`. 256 MiB cap is
/// the router-wide DefaultBodyLimit; any MIME accepted.
async fn add_attachment(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    mut mp: Multipart,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    if fetch_case(&state.db, &rid).await?.is_none() {
        return Err(AppError::not_found("not_found", format!("case {rid}")));
    }
    let mut bytes: Option<Vec<u8>> = None;
    let mut filename = "attachment".to_string();
    let mut mime = "application/octet-stream".to_string();
    let mut comment_id: Option<String> = None;
    while let Some(field) =
        mp.next_field().await.map_err(|e| AppError::bad_request("multipart", e.to_string()))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                if let Some(f) = field.file_name() {
                    filename = f.to_string();
                }
                if let Some(ct) = field.content_type() {
                    mime = ct.to_string();
                }
                bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppError::bad_request("multipart", e.to_string()))?
                        .to_vec(),
                );
            }
            "comment_id" => comment_id = Some(field.text().await.unwrap_or_default()),
            _ => {}
        }
    }
    let bytes =
        bytes.ok_or_else(|| AppError::bad_request("no_file", "multipart field `file` is required"))?;
    let comment = comment_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let out = pipeline::upload_attachment(
        &state.db,
        &state.data_dir,
        &rid,
        comment,
        &caller.rid,
        &filename,
        &mime,
        bytes,
    )
    .await?;
    event::info(
        &state.db,
        "case_attach",
        format!("attached {} to case {rid}", out.filename),
        Some(caller.rid.clone()),
        json!({ "case": rid, "attachment": out.rid }),
    );
    Ok(Json(json!({
        "rid": out.rid, "case_id": rid, "filename": out.filename,
        "mime": out.mime, "size_bytes": out.size_bytes,
    })))
}

/// GET /api/cases/:rid/attachments — View reach. Metadata only (no storage_path).
async fn list_attachments(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let items: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(a) - 'storage_path' FROM case_attachments a WHERE case_id = $1 ORDER BY created_at",
    )
    .bind(&rid)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "items": items })))
}

/// GET /api/cases/:rid/attachments/:att — View reach. RAW download with the STORED
/// mime + filename (NOT the CSV export path). Forced `attachment` disposition +
/// `nosniff` so an uploaded .html can never render inline (stored-XSS guard). 404
/// leak-free if the attachment isn't this case's.
async fn download_attachment(
    State(state): State<AppState>,
    caller: Caller,
    Path((rid, att)): Path<(String, String)>,
) -> Result<Response, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT filename, mime FROM case_attachments WHERE redpash_id = $1 AND case_id = $2",
    )
    .bind(&att)
    .bind(&rid)
    .fetch_optional(&state.db)
    .await?;
    let (filename, mime) =
        row.ok_or_else(|| AppError::not_found("not_found", format!("attachment {att}")))?;
    let bytes = tokio::fs::read(state.attachment_path(&att))
        .await
        .map_err(|e| AppError::internal("io", format!("read attachment: {e}")))?;
    // Read-access audit (privacy finding F-I / GDPR Art. 30): downloading a stored
    // attachment is access to personal data — record WHO accessed WHAT (ids only,
    // never the bytes).
    event::info(
        &state.db,
        "case_attachment_download",
        format!("attachment {att} downloaded from case {rid}"),
        Some(caller.rid.clone()),
        serde_json::json!({ "type": "case_attachment", "case": &rid, "attachment": &att }),
    );
    // Sanitize the filename for the header (strip quote/backslash/CR/LF) — no header
    // injection from a crafted upload name.
    let safe_name: String =
        filename.chars().map(|c| if matches!(c, '"' | '\\' | '\r' | '\n') { '_' } else { c }).collect();
    let headers = [
        (header::CONTENT_TYPE, mime),
        (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{safe_name}\"")),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
    ];
    Ok((headers, bytes).into_response())
}

/// DELETE /api/cases/:rid/attachments/:att — Edit reach (removing an attachment is
/// editing the case, not deleting it). Removes the row + the blob. 404 leak-free.
async fn delete_attachment(
    State(state): State<AppState>,
    caller: Caller,
    Path((rid, att)): Path<(String, String)>,
) -> Result<axum::http::StatusCode, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    let existed: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM case_attachments WHERE redpash_id = $1 AND case_id = $2")
            .bind(&att)
            .bind(&rid)
            .fetch_optional(&state.db)
            .await?;
    if existed.is_none() {
        return Err(AppError::not_found("not_found", format!("attachment {att}")));
    }
    sqlx::query("DELETE FROM case_attachments WHERE redpash_id = $1")
        .bind(&att)
        .execute(&state.db)
        .await?;
    // Best-effort blob removal — the row is the source of truth; an orphan .bin is
    // harmless (and a future BlobGuard sweep can reap it).
    let _ = tokio::fs::remove_file(state.attachment_path(&att)).await;
    event::info(
        &state.db,
        "case_attach_remove",
        format!("removed attachment {att} from case {rid}"),
        Some(caller.rid.clone()),
        json!({ "case": rid, "attachment": att }),
    );
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::workflow;

    #[test]
    fn internal_initial_and_state_order() {
        assert_eq!(workflow::initial("internal"), "backlog");
        assert_eq!(workflow::states("internal").first(), Some(&"backlog"));
        assert_eq!(workflow::states("internal").last(), Some(&"done"));
    }

    #[test]
    fn internal_allows_legal_moves_rejects_illegal_skips() {
        // forward (legal)
        assert!(workflow::is_valid("internal", "backlog", "todo"));
        assert!(workflow::is_valid("internal", "todo", "in_progress"));
        assert!(workflow::is_valid("internal", "in_review", "done"));
        // backward / reopen (kanban-friendly, legal)
        assert!(workflow::is_valid("internal", "todo", "backlog"));
        assert!(workflow::is_valid("internal", "done", "in_progress"));
        // same-state = idempotent no-op
        assert!(workflow::is_valid("internal", "in_progress", "in_progress"));
        // ILLEGAL skips — these are the 422 invalid_transition cases
        assert!(!workflow::is_valid("internal", "backlog", "done"));
        assert!(!workflow::is_valid("internal", "backlog", "in_review"));
        assert!(!workflow::is_valid("internal", "todo", "done"));
    }

    #[test]
    fn is_known_state_guards_the_status_value() {
        assert!(workflow::is_known_state("internal", "in_review"));
        assert!(!workflow::is_known_state("internal", "archived"));
        // external states are NOT internal states (the dormant separation)
        assert!(!workflow::is_known_state("internal", "Assess"));
    }

    #[test]
    fn external_is_designed_but_separate() {
        assert_eq!(workflow::initial("external"), "New");
        assert!(workflow::is_valid("external", "Solution Provided", "Closed")); // accept
        assert!(workflow::is_valid("external", "Solution Provided", "Research")); // refuse
        assert!(!workflow::is_valid("external", "New", "Closed")); // skip rejected
    }

    #[test]
    fn unknown_source_defaults_to_internal() {
        assert_eq!(workflow::initial("anything"), "backlog");
        assert!(workflow::is_valid("anything", "backlog", "todo"));
    }
}
