//! Doc: docs/internal/code/backend/api/routes/connectors.md
//! `/api/connectors` — persisted connector configs (Kafka, future S3/CDC).
//!
//!   GET    /        list the connectors the caller can reach
//!   POST   /        create one — the user picks the DESTINATION project
//!   GET    /:rid    fetch one connector summary
//!   PATCH  /:rid    rename a connector (manage = Admin+ on its project)
//!   DELETE /:rid    delete a connector (Admin+; the row cascades via the registry)
//!
//! This is the framework half of connector-through-framework: instead of the
//! `load.sh` env hardcode, the user creates a connection (picking which project
//! the data lands in), and the loader reads that choice. CREATE gates the caller
//! to ≥Member write-reach on the chosen project — the same write-check
//! `pipeline::upload_csv` applies at LOAD time — so you can only point a
//! connection at a project you could upload to. Fail-closed (404, no leak).

use axum::{extract::{Path, Query, State}, http::{HeaderMap, StatusCode}, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};

use crate::{db, error::AppError, id, state::AppState};

#[derive(Serialize)]
struct ConnectorList { items: Vec<db::ConnectorSummary> }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/",     get(list).post(create))
        .route("/:rid", get(get_one).patch(rename).delete(remove))
        .route("/:rid/sync", post(sync))
        .route("/:rid/tables", get(tables))
        .route("/:rid/schema", get(schema))
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
    /// Connector-specific config (JSONB) — e.g. MySQL `{ host, port, user,
    /// password, database, table }`. localhost v1 stores it as-is; non-localhost
    /// hardening = move secrets to the RC `.env` or encrypt at rest.
    #[serde(default)] config:   Option<serde_json::Value>,
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
    let config = body.config.clone().unwrap_or_else(|| serde_json::json!({}));

    let rid = id::new("CON");
    db::insert_connector(&state.db, &rid, project_id, name, kind, topic, &user, &user, &config).await?;

    crate::event::info(&state.db, "connector_create", format!("created {kind} connector {name}"))
        .user(user.clone())
        .context(serde_json::json!({ "connector": rid, "project": project_id }))
        .send();

    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::internal("internal", "connector vanished after insert"))?;
    Ok((StatusCode::CREATED, Json(conn)))
}

#[derive(Serialize)]
struct SyncResult { file: String }

#[derive(Deserialize, Default)]
struct SyncBody {
    /// Pull a SPECIFIC table instead of the connector's configured default (the
    /// Tables-facet browse → pull-any-table flow). Empty/absent = configured table.
    #[serde(default)] table: Option<String>,
}

#[derive(Deserialize)]
struct SchemaQuery { table: String }

/// `POST /api/connectors/:rid/sync` — run the connector's extract → CSV → a new
/// project file ("Pull" in SheetWise). v1 wires **MySQL** (in-process sqlx — a
/// quick SELECT, unlike Kafka's binary-mode consume). The caller needs ≥Member
/// write-reach on the connector's destination project (same gate as create); the
/// load is attributed to + re-checked against the connector's `as_user` by the
/// pipeline. The live source is read-only (one SELECT) — the CSV is the copy.
async fn sync(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    body:         Option<Json<SyncBody>>,
) -> Result<Json<SyncResult>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("connector {rid}")))?;
    crate::rbac::require_grant(&state, &user, &conn.project_id, "project",
        |g| g.effective().is_some_and(|r| r >= crate::rbac::Role::Member)).await?;

    // optional {table} override — pull any table the user picked in the Tables facet
    let table_override = body.and_then(|Json(b)| b.table).filter(|t| !t.trim().is_empty());
    // Dispatch by connector kind (mysql + postgres wired — additive; the shared loader
    // registry is the connectors_core co-design). Both loaders' run() return the file rid.
    let dd = state.data_dir.as_path();
    let file = match conn.kind.as_str() {
        "mysql" => {
            let mut cfg = crate::mysql_loader::Cfg::from_connection(&state.db, &rid).await
                .map_err(|e| AppError::bad_request("connector_cfg", e.to_string()))?;
            if let Some(t) = table_override { cfg.table = t; }
            crate::mysql_loader::run(&state.db, dd, &cfg).await
                .map_err(|e| AppError::bad_request("connector_sync", e.to_string()))?
        }
        "postgres" => {
            let mut cfg = crate::postgres_loader::Cfg::from_connection(&state.db, &rid).await
                .map_err(|e| AppError::bad_request("connector_cfg", e.to_string()))?;
            if let Some(t) = table_override { cfg.table = t; }
            crate::postgres_loader::run(&state.db, dd, &cfg).await
                .map_err(|e| AppError::bad_request("connector_sync", e.to_string()))?
        }
        other => return Err(AppError::bad_request("unsupported",
            format!("in-app sync is wired for kind 'mysql'/'postgres' (got '{other}')"))),
    };

    crate::event::info(&state.db, "connector_sync", format!("synced connector {rid} → {file}"))
        .user(user.clone())
        .context(serde_json::json!({ "connector": rid, "file": file, "project": conn.project_id }))
        .send();

    Ok(Json(SyncResult { file }))
}

/// `GET /api/connectors/:rid/tables` — list the tables in the connector's source
/// database (the Tables facet). Read-only introspection, gated by VIEW reach on
/// the destination project (same as `get_one`; leak-free 404). MySQL only (v1).
async fn tables(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("connector {rid}")))?;
    crate::rbac::require_view(&state, &user, &conn.project_id, "project").await?;
    // Identical {name,rows,kind} wire shape for both loaders → serialize either's
    // TableInfo (the structs are per-loader but serde-identical).
    let items = match conn.kind.as_str() {
        "mysql" => {
            let cfg = crate::mysql_loader::Cfg::from_connection(&state.db, &rid).await
                .map_err(|e| AppError::bad_request("connector_cfg", e.to_string()))?;
            let t = crate::mysql_loader::list_tables(&cfg).await
                .map_err(|e| AppError::bad_request("connector_introspect", e.to_string()))?;
            serde_json::to_value(t).unwrap_or_default()
        }
        "postgres" => {
            let cfg = crate::postgres_loader::Cfg::from_connection(&state.db, &rid).await
                .map_err(|e| AppError::bad_request("connector_cfg", e.to_string()))?;
            let t = crate::postgres_loader::list_tables(&cfg).await
                .map_err(|e| AppError::bad_request("connector_introspect", e.to_string()))?;
            serde_json::to_value(t).unwrap_or_default()
        }
        other => return Err(AppError::bad_request("unsupported",
            format!("table listing is wired for kind 'mysql'/'postgres' (got '{other}')"))),
    };
    Ok(Json(serde_json::json!({ "items": items })))
}

/// `GET /api/connectors/:rid/schema?table=X` — columns + types (+ the loader's
/// projection strategy) of one table in the source DB (the Schema facet). VIEW-gated.
async fn schema(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Query(q):     Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("connector {rid}")))?;
    crate::rbac::require_view(&state, &user, &conn.project_id, "project").await?;
    let items = match conn.kind.as_str() {
        "mysql" => {
            let cfg = crate::mysql_loader::Cfg::from_connection(&state.db, &rid).await
                .map_err(|e| AppError::bad_request("connector_cfg", e.to_string()))?;
            let c = crate::mysql_loader::describe_table(&cfg, &q.table).await
                .map_err(|e| AppError::bad_request("connector_introspect", e.to_string()))?;
            serde_json::to_value(c).unwrap_or_default()
        }
        "postgres" => {
            let cfg = crate::postgres_loader::Cfg::from_connection(&state.db, &rid).await
                .map_err(|e| AppError::bad_request("connector_cfg", e.to_string()))?;
            let c = crate::postgres_loader::describe_table(&cfg, &q.table).await
                .map_err(|e| AppError::bad_request("connector_introspect", e.to_string()))?;
            serde_json::to_value(c).unwrap_or_default()
        }
        other => return Err(AppError::bad_request("unsupported",
            format!("schema is wired for kind 'mysql'/'postgres' (got '{other}')"))),
    };
    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Deserialize)]
struct PatchConnectorBody {
    #[serde(default)] name: Option<String>,
}

/// `PATCH /api/connectors/:rid` — rename a connector. Managing a connector is
/// **admin power** (per the connectors-as-managed-asset model), so this requires
/// **≥Admin reach** on the connector's destination project — a step above the
/// ≥Member create/sync gate. Leak-free: an unreachable connector reads as 404.
async fn rename(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<PatchConnectorBody>,
) -> Result<Json<db::ConnectorSummary>, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("connector {rid}")))?;
    crate::rbac::require_grant(&state, &user, &conn.project_id, "project",
        |g| g.effective().is_some_and(|r| r >= crate::rbac::Role::Admin)).await?;

    let name = body.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let Some(name) = name else {
        return Err(AppError::bad_request("invalid", "name is required"));
    };
    db::rename_connector(&state.db, &rid, name).await?;

    crate::event::info(&state.db, "connector_rename", format!("renamed connector {rid} → {name}"))
        .user(user.clone())
        .context(serde_json::json!({ "connector": rid, "name": name }))
        .send();

    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::internal("internal", "connector vanished after rename"))?;
    Ok(Json(conn))
}

/// `DELETE /api/connectors/:rid` — delete a connector. **≥Admin reach** on the
/// destination project (same manage gate as rename). The `connectors` row
/// cascades off the entity-registry FK (`ON DELETE CASCADE`); deleting the
/// connector does NOT touch any files it previously pulled. Leak-free 404.
async fn remove(
    State(state): State<AppState>,
    headers:      HeaderMap,
    Path(rid):    Path<String>,
) -> Result<StatusCode, AppError> {
    let user = super::resolve_user_rid(&state, &headers).await?;
    let conn = db::get_connector(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("connector {rid}")))?;
    crate::rbac::require_grant(&state, &user, &conn.project_id, "project",
        |g| g.effective().is_some_and(|r| r >= crate::rbac::Role::Admin)).await?;

    db::delete_connector(&state.db, &rid).await?;

    crate::event::info(&state.db, "connector_delete", format!("deleted connector {rid}"))
        .user(user.clone())
        .context(serde_json::json!({ "connector": rid, "project": conn.project_id }))
        .send();

    Ok(StatusCode::NO_CONTENT)
}
