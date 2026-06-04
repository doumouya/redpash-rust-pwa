//! Doc: docs/internal/code/backend/api/routes/connectors.md
//! `/api/connectors` — persisted connector configs (Kafka, future S3/CDC).
//!
//!   GET  /        list the connectors the caller can reach
//!   POST /        create one — the user picks the DESTINATION project
//!   GET  /:rid    fetch one connector summary
//!
//! This is the framework half of connector-through-framework: instead of the
//! `load.sh` env hardcode, the user creates a connection (picking which project
//! the data lands in), and the loader reads that choice. CREATE gates the caller
//! to ≥Member write-reach on the chosen project — the same write-check
//! `pipeline::upload_csv` applies at LOAD time — so you can only point a
//! connection at a project you could upload to. Fail-closed (404, no leak).

use axum::{extract::{Path, State}, http::{HeaderMap, StatusCode}, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct ConnectorList { items: Vec<db::ConnectorSummary> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one))
}

async fn list(
    State(state): State<AppState>,
    headers:      HeaderMap,
) -> Result<Json<ConnectorList>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let items = db::list_connectors(&state.db, &user).await?;
    Ok(Json(ConnectorList { items }))
}

async fn get_one(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<db::ConnectorSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("connector {rid}")))?;
    // View-reach on the destination project gates the read (leak-free: a
    // connector you can't reach reads as "not found").
    crate::rbac::require_view(&state, &user, &conn.project_id, "project").await?;
    Ok(Json(conn))
}

#[derive(Deserialize)]
struct CreateConnectorBody {
    name:                       String,
    project_id:                 String,
    #[serde(default)] topic:    Option<String>,
    #[serde(default)] kind:     Option<String>,
}

/// `POST /api/connectors` — create a connector pointing at a destination project.
///
/// Validates:
/// - `name` + `project_id` required, non-empty after trim.
/// - the caller has **≥Member write-reach** on `project_id` — the same gate the
///   upload pipeline enforces, so a connection can only target a project the
///   caller could upload to (else 404, no "exists but not yours" leak).
///
/// `as_user` is the caller (the load runs as them, RBAC-checked at load time —
/// no platform-admin bypass); `created_by` is also the caller.
async fn create(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Json(body):   Json<CreateConnectorBody>,
) -> Result<(StatusCode, Json<db::ConnectorSummary>), AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;

    let name = body.name.trim();
    let project_id = body.project_id.trim();
    if name.is_empty() {
        return Err(AppError::bad_request("invalid", "name is required"));
    }
    if project_id.is_empty() {
        return Err(AppError::bad_request("invalid", "project_id is required"));
    }

    // The project must EXIST before the RBAC check — a missing project reads as
    // not-found for EVERYONE, including platform admins (who'd otherwise pass
    // require_grant's admin-reach and then hit the `project_id` FK as an opaque
    // 500). Leak-free: an existing-but-unreachable project also 404s, just below,
    // via require_grant — so the caller can't tell "missing" from "not yours".
    if db::get_project(&state.db, project_id).await?.is_none() {
        return Err(AppError::not_found("not_found", format!("project {project_id}")));
    }

    // RBAC: the caller must be able to WRITE (≥Member) to the chosen project —
    // identical to the upload pipeline's write-check. require_grant 404s a
    // project the caller can't reach (leak-free), and rejects view-only members.
    crate::rbac::require_grant(&state, &user, project_id, "project",
        |g| g.effective().is_some_and(|r| r >= crate::rbac::Role::Member)).await?;

    let topic = body.topic.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let kind  = body.kind.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("kafka");

    let rid = id::new("CON");
    db::insert_connector(&state.db, &rid, project_id, name, kind, topic, &user, &user).await?;

    crate::event::info(&state.db, "connector_create", format!("created {kind} connector {name}"))
        .user(user.clone())
        .context(serde_json::json!({ "connector": rid, "project": project_id }))
        .send();

    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::internal("internal", "connector vanished after insert"))?;
    Ok((StatusCode::CREATED, Json(conn)))
}
