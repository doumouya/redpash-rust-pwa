//! `/api/projects` — full CRUD on the user's projects + their files.
//!
//!   GET    /                 list the caller's projects
//!   POST   /                 create a new project
//!   GET    /:rid             fetch one project summary
//!   PATCH  /:rid             sparse metadata update (inline edits)
//!   DELETE /:rid             delete (cascades to files / steps / dashboards)
//!   GET    /:rid/files       list files in a project (cleaner landing)

use axum::{extract::{Path, State}, http::{HeaderMap, StatusCode}, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use shared::file::FileSummary;
use shared::project::ProjectSummary;

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct ProjectList { items: Vec<ProjectSummary> }

#[derive(Serialize)]
struct ProjectFiles { items: Vec<FileSummary> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",             get(list).post(create_project))
        .route("/:rid",         get(get_one).patch(patch_project).delete(delete_project))
        .route("/:rid/files",   get(list_files))
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<ProjectList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_projects(&state.db, &user)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(ProjectList { items }))
}

async fn list_files(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<ProjectFiles>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::project_owner(&state.db, &rid).await, &user, "project", &rid)?;
    let items = db::list_files_in_project(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    Ok(Json(ProjectFiles { items }))
}

/// `GET /api/projects/:rid` — fetch one project summary. Ownership-
/// gated; same row shape as `list`'s items, so the frontend can use
/// it as a fresh-after-edit refetch.
async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<ProjectSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::project_owner(&state.db, &rid).await, &user, "project", &rid)?;
    db::get_project(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?
        .map(Json)
        .ok_or_else(|| AppError::not_found("not_found", format!("project {rid}")))
}

#[derive(Deserialize)]
struct CreateProjectBody {
    name:                          String,
    #[serde(default)] description: Option<String>,
    #[serde(default)] company_id:  Option<String>,
    #[serde(default)] is_default:  Option<bool>,
}

/// `POST /api/projects` — create a project owned by the caller.
///
/// Validates:
/// - `name` required, non-empty after trim.
/// - `company_id` (when set) must reference a company the caller belongs
///   to — same gate as PATCH's company reassign, so a stranger can't
///   pin a project to a company they don't share.
/// - `is_default` defaults to `false`. When `true`, the create runs in
///   a transaction that demotes the caller's existing default in the
///   same tx — the `projects_owner_default_idx` partial unique index
///   never sees two defaults at once.
async fn create_project(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateProjectBody>,
) -> Result<(StatusCode, Json<ProjectSummary>), AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;

    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad_request("invalid", "name is required"));
    }

    let description = body.description.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let company_id  = body.company_id.as_deref().map(str::trim).filter(|s| !s.is_empty());

    if let Some(cid) = company_id {
        if db::company_role(&state.db, cid, &user)
            .await
            .map_err(|e| AppError::internal("db", e.to_string()))?
            .is_none()
        {
            return Err(AppError::not_found("not_found", "company not found"));
        }
    }

    let rid = id::new("PRJ");
    let project = db::create_project(
        &state.db, &rid, &user, name, description, company_id,
        body.is_default.unwrap_or(false),
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?;

    crate::event::record(&state.db, crate::event::EventDraft {
        origin:  "backend",
        level:   "info",
        kind:    "project_create".into(),
        message: format!("created project {name}"),
        user:    Some(user.clone()),
        context: serde_json::json!({ "project": rid }),
        ..Default::default()
    });

    Ok((StatusCode::CREATED, Json(project)))
}

#[derive(Deserialize)]
struct PatchProjectBody {
    #[serde(default)] name:        Option<String>,
    #[serde(default)] description: Option<String>,
    #[serde(default)] is_default:  Option<bool>,
    #[serde(default)] owner_id:    Option<String>,
    #[serde(default)] company_id:  Option<String>,
    #[serde(default)] status:      Option<String>,
}

// Allowed `status` values — mirrors the projects table's CHECK
// constraint. Validated here so a bad value is a clean 400 rather than
// a CHECK violation bubbling up as a 500. (`stage` isn't here — it's a
// computed value, not an editable column.)
const PROJECT_STATUSES: &[&str] = &["draft", "active", "archived"];

/// `PATCH /api/projects/:rid` — sparse metadata update from the Objects
/// overview's inline edit-mode. `name` / `description` / `status` are
/// the wired inline edits; `is_default` / `owner_id` / `company_id`
/// round out the endpoint. Empty `name` / `owner_id` / `company_id` are
/// dropped so they can't blank a required field (and `company_id` can
/// be set or re-scoped here, but not cleared back to a personal
/// project). `stage` is computed from the project's files — not
/// editable.
async fn patch_project(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchProjectBody>,
) -> Result<Json<ProjectSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::project_owner(&state.db, &rid).await, &user, "project", &rid)?;

    let new_owner = body.owner_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(oid) = new_owner {
        // Reassignment target must be a real user — surface a clean
        // 404 rather than letting the FK violation bubble up as a 500.
        if db::find_user_by_id(&state.db, oid)
            .await
            .map_err(|e| AppError::internal("db", e.to_string()))?
            .is_none()
        {
            return Err(AppError::not_found("not_found", "owner user not found"));
        }
    }

    let new_company = body.company_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(cid) = new_company {
        // Can only scope a project to a company the editor belongs to —
        // resolving the caller's role doubles as the existence check.
        if db::company_role(&state.db, cid, &user)
            .await
            .map_err(|e| AppError::internal("db", e.to_string()))?
            .is_none()
        {
            return Err(AppError::not_found("not_found", "company not found"));
        }
    }

    // status — validate against the allowed set so a typo is a clean
    // 400 rather than a CHECK-constraint 500.
    let new_status = body.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = new_status {
        if !PROJECT_STATUSES.contains(&s) {
            return Err(AppError::bad_request("invalid", "status must be draft / active / archived"));
        }
    }

    // `user` is the project's current owner (ensure_owner just confirmed
    // it) — update_project_meta needs it to clear their existing default
    // when `is_default` flips on.
    let updated = db::update_project_meta(
        &state.db, &rid, &user,
        body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.description.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        body.is_default,
        new_owner,
        new_company,
        new_status,
    )
    .await
    .map_err(|e| AppError::internal("db", e.to_string()))?
    .ok_or_else(|| AppError::not_found("not_found", "project not found"))?;
    Ok(Json(updated))
}

/// `DELETE /api/projects/:rid` — remove a project and everything it
/// owns (files, steps, reports, dashboards, memberships all cascade via
/// FK). The owner's **default** project can't be deleted — every user
/// must keep exactly one default workspace, so the client is told to
/// promote another project to default first. The on-disk file blobs
/// are unlinked best-effort after the row delete (the DB cascade only
/// clears rows, not the files on disk).
async fn delete_project(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    super::ensure_owner(db::project_owner(&state.db, &rid).await, &user, "project", &rid)?;

    // Grab the file RIDs before the cascade clears the rows — needed to
    // evict the hot-frame cache and unlink the blobs afterwards.
    let file_rids = db::project_file_rids(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;

    let deleted = db::delete_project(&state.db, &rid)
        .await
        .map_err(|e| AppError::internal("db", e.to_string()))?;
    if !deleted {
        // `ensure_owner` already confirmed the project exists, so a
        // no-op delete means it's the owner's default project.
        return Err(AppError::bad_request(
            "is_default",
            "this is your default project — set another project as default before deleting it",
        ));
    }

    for fid in file_rids {
        state.files.remove(&fid);
        let _ = tokio::fs::remove_file(state.file_path(&fid)).await;
    }
    Ok(StatusCode::NO_CONTENT)
}
