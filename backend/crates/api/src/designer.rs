//! Purpose: the Designer's chart + dashboard MUTATION surface. Charts and
//! dashboards are `project_files` rows (`file_type` chart/dashboard) whose `spec`
//! is an OPAQUE jsonb blob (the ECharts cfg / the 15×10 layout) — the backend never
//! parses its contents, only guards that it's a JSON object. The generic registry
//! (`/objects`) deliberately keeps chart/dashboard off its surface (catalog-less
//! spec blobs); creation goes through the sealed `pipeline::create_chart` /
//! `create_dashboard` (the one-write-path rule), and edit/read/delete live here.
//!
//! RBAC: create = Member+ on the project (derived from the source CSV for a chart;
//! supplied for a dashboard — the IDOR guard, in the pipeline writer). get/put/
//! delete = `require_action` View/Edit/Delete on the rid (Delete needs Admin-tier
//! reach — or the owner edge the creator gets via grant_owner — while View=Viewer
//! and Edit=Member), all cascading chart→project→company (verified: type_cache maps
//! chart/dashboard → project_files and their scope_parents=["project_id"] generate
//! the cascade). Denials are leak-free 404. `/api/group/preview` (the chart data engine) is reused unchanged elsewhere.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

use crate::{
    db,
    error::AppError,
    pipeline,
    rbac::{self, Action, Caller},
    state::AppState,
};

pub fn chart_routes() -> Router<AppState> {
    Router::new()
        .route("/", post(create_chart))
        .route("/:rid", get(get_chart).put(update_chart).delete(delete_chart))
}

pub fn dashboard_routes() -> Router<AppState> {
    Router::new()
        .route("/", post(create_dashboard))
        .route("/:rid", get(get_dashboard).put(update_dashboard).delete(delete_dashboard))
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// `spec` contents are opaque, but it MUST be a JSON object — a scalar/array would
/// round-trip yet break the FE loader.
fn require_spec_object(spec: &Value) -> Result<(), AppError> {
    if matches!(spec, Value::Object(_)) {
        Ok(())
    } else {
        Err(AppError::bad_request("invalid_spec", "spec must be a JSON object"))
    }
}

/// The full project_files row as JSON (incl. `spec` for load); `storage_path`
/// stripped (server FS path never crosses the wire). Type-scoped so a wrong-type
/// rid is a leak-free miss.
async fn fetch_row(pool: &PgPool, rid: &str, file_type: &str) -> Result<Option<Value>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT to_jsonb(f) - 'storage_path' FROM project_files f \
         WHERE redpash_id = $1 AND file_type = $2",
    )
    .bind(rid)
    .bind(file_type)
    .fetch_optional(pool)
    .await?)
}

/// Type-scoped existence (after the coarse gate — a platform admin bypasses
/// require_action's existence check, so a missing/wrong-type rid must 404 here, not
/// 500). Returns Ok(()) if the row exists at the given file_type, else 404.
async fn ensure_exists(pool: &PgPool, rid: &str, file_type: &str) -> Result<(), AppError> {
    let hit: Option<i32> =
        sqlx::query_scalar("SELECT 1 FROM project_files WHERE redpash_id = $1 AND file_type = $2")
            .bind(rid)
            .bind(file_type)
            .fetch_optional(pool)
            .await?;
    if hit.is_some() {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", format!("{file_type} {rid}")))
    }
}

// ─── charts ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateChart {
    source_file_id: String,
    title: String,
    spec: Value,
}

/// POST /api/charts — create a chart bound to a source CSV. Member+ on the source
/// file's project (the pipeline writer derives + gates it).
async fn create_chart(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<CreateChart>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::bad_request("title_required", "chart title is required"));
    }
    require_spec_object(&body.spec)?;
    let rid = pipeline::create_chart(
        &state.db,
        &state.type_cache,
        &caller.rid,
        caller.is_platform_admin,
        body.source_file_id.trim(),
        title,
        &body.spec,
    )
    .await?;
    let row = fetch_row(&state.db, &rid, "chart")
        .await?
        .ok_or_else(|| AppError::internal("designer", "created chart not found"))?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// GET /api/charts/:rid — the chart row + spec (for load). View reach.
async fn get_chart(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let row = fetch_row(&state.db, &rid, "chart")
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("chart {rid}")))?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct UpdateChart {
    title: Option<String>,
    spec: Option<Value>,
    source_file_id: Option<String>,
}

/// PUT /api/charts/:rid — REPLACE the spec wholesale (the FE owns the blob; not a
/// merge) and/or rename. Edit reach. `source_file_id` is immutable (lineage).
async fn update_chart(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<UpdateChart>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    if body.source_file_id.is_some() {
        return Err(AppError::bad_request("immutable_field", "source_file_id cannot be changed"));
    }
    ensure_exists(&state.db, &rid, "chart").await?;
    if let Some(spec) = &body.spec {
        require_spec_object(spec)?;
    }
    let title = body.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
    sqlx::query(
        "UPDATE project_files SET filename = COALESCE($1, filename), spec = COALESCE($2, spec) \
         WHERE redpash_id = $3 AND file_type = 'chart'",
    )
    .bind(title)
    .bind(body.spec.as_ref())
    .bind(&rid)
    .execute(&state.db)
    .await?;
    let row = fetch_row(&state.db, &rid, "chart")
        .await?
        .ok_or_else(|| AppError::internal("designer", "updated chart not found"))?;
    Ok(Json(row))
}

/// DELETE /api/charts/:rid — Delete reach. Cascades via the entities registry.
async fn delete_chart(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<StatusCode, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Delete).await?;
    ensure_exists(&state.db, &rid, "chart").await?;
    db::delete_entity_and_blobs(&state.db, &state.data_dir, &rid).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── dashboards ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateDashboard {
    project_id: String,
    title: String,
    spec: Value,
    folder: Option<String>,
}

/// POST /api/dashboards — create a dashboard in a project. Member+ on the project.
async fn create_dashboard(
    State(state): State<AppState>,
    caller: Caller,
    Json(body): Json<CreateDashboard>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let title = body.title.trim();
    if title.is_empty() {
        return Err(AppError::bad_request("title_required", "dashboard title is required"));
    }
    require_spec_object(&body.spec)?;
    let folder = body.folder.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let rid = pipeline::create_dashboard(
        &state.db,
        &state.type_cache,
        &caller.rid,
        caller.is_platform_admin,
        body.project_id.trim(),
        title,
        folder,
        &body.spec,
    )
    .await?;
    let row = fetch_row(&state.db, &rid, "dashboard")
        .await?
        .ok_or_else(|| AppError::internal("designer", "created dashboard not found"))?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// GET /api/dashboards/:rid — the dashboard row + spec (the 15×10 layout). View reach.
async fn get_dashboard(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::View).await?;
    let row = fetch_row(&state.db, &rid, "dashboard")
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("dashboard {rid}")))?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct UpdateDashboard {
    title: Option<String>,
    spec: Option<Value>,
    folder: Option<String>,
}

/// PUT /api/dashboards/:rid — REPLACE the spec wholesale and/or rename/refolder. Edit reach.
async fn update_dashboard(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<UpdateDashboard>,
) -> Result<Json<Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    ensure_exists(&state.db, &rid, "dashboard").await?;
    if let Some(spec) = &body.spec {
        require_spec_object(spec)?;
    }
    let title = body.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let folder = body.folder.as_deref().map(str::trim).filter(|s| !s.is_empty());
    sqlx::query(
        "UPDATE project_files \
         SET filename = COALESCE($1, filename), spec = COALESCE($2, spec), folder = COALESCE($3, folder) \
         WHERE redpash_id = $4 AND file_type = 'dashboard'",
    )
    .bind(title)
    .bind(body.spec.as_ref())
    .bind(folder)
    .bind(&rid)
    .execute(&state.db)
    .await?;
    let row = fetch_row(&state.db, &rid, "dashboard")
        .await?
        .ok_or_else(|| AppError::internal("designer", "updated dashboard not found"))?;
    Ok(Json(row))
}

/// DELETE /api/dashboards/:rid — Delete reach. Cascades via the entities registry.
async fn delete_dashboard(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
) -> Result<StatusCode, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Delete).await?;
    ensure_exists(&state.db, &rid, "dashboard").await?;
    db::delete_entity_and_blobs(&state.db, &state.data_dir, &rid).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::require_spec_object;
    use serde_json::json;

    #[test]
    fn spec_must_be_a_json_object() {
        // a chart cfg / dashboard layout is always an object
        assert!(require_spec_object(&json!({"kind": "bar"})).is_ok());
        assert!(require_spec_object(&json!({})).is_ok());
        // a scalar/array/null round-trips through jsonb but breaks the FE loader → 400
        assert!(require_spec_object(&json!("nope")).is_err());
        assert!(require_spec_object(&json!([1, 2, 3])).is_err());
        assert!(require_spec_object(&json!(null)).is_err());
        assert!(require_spec_object(&json!(42)).is_err());
    }
}
