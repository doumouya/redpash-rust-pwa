//! Purpose: /api/files/:rid/sql — read-only SQL over the workspace file (fixed
//! as table `t`) plus optional caller-named extra file tables. The read-only
//! guard lives INSIDE data::sql (same engine the browser runs), so the server
//! endpoint and the wasm console cannot diverge. /materialize writes the result
//! as a NEW file through the sealed pipeline (SheetWise's zero-risk invariant:
//! the live source is never mutated — every result is additive).

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;

use super::hydrate;
use crate::{
    db,
    error::AppError,
    pipeline,
    rbac::{self, Action, Caller},
    state::AppState,
};

const PRIMARY_TABLE: &str = "t";

#[derive(Deserialize)]
pub(super) struct SqlBody {
    sql: String,
    /// Extra tables: { name, file_id }. Each is RBAC view-checked.
    #[serde(default)]
    tables: Vec<ExtraTable>,
    #[serde(default)]
    materialize_as: Option<String>,
}

#[derive(Deserialize)]
struct ExtraTable {
    name: String,
    file_id: String,
}

/// Gather (name, frame) for the primary file + each extra, View-gating every
/// referenced file. The primary is always table `t`.
async fn gather_tables(
    state: &AppState,
    caller: &Caller,
    rid: &str,
    extras: &[ExtraTable],
) -> Result<Vec<(String, polars::prelude::DataFrame)>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, caller, rid, Action::View).await?;
    let mut tables = vec![(PRIMARY_TABLE.to_string(), (*hydrate(state, rid).await?.frame).clone())];
    for t in extras {
        rbac::require_action(&state.db, &state.type_cache, caller, &t.file_id, Action::View).await?;
        tables.push((t.name.clone(), (*hydrate(state, &t.file_id).await?.frame).clone()));
    }
    Ok(tables)
}

pub(super) async fn run(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<SqlBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let tables = gather_tables(&state, &caller, &rid, &body.tables).await?;
    let sql = body.sql.clone();
    let frame = tokio::task::spawn_blocking(move || data::sql::run_sql(tables, &sql))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))??;
    let p = data::view::page(&frame, 0, 500);
    Ok(Json(serde_json::json!({
        "columns": p.columns,
        "rows": p.rows,
        "total": p.total,
    })))
}

/// Run the query, then write the result as a NEW csv file in the same project
/// via the sealed pipeline (never mutates the source).
pub(super) async fn materialize(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<SqlBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let project = db::find_file(&state.db, &rid)
        .await?
        .ok_or_else(|| AppError::not_found("not_found", format!("file {rid}")))?
        .project_id;
    let tables = gather_tables(&state, &caller, &rid, &body.tables).await?;
    let sql = body.sql.clone();
    let csv = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, data::DataError> {
        let frame = data::sql::run_sql(tables, &sql)?;
        data::export::to_csv(&frame)
    })
    .await
    .map_err(|e| AppError::internal("join", e.to_string()))??;

    let name = body.materialize_as.clone().unwrap_or_else(|| "query_result".into());
    let outcome = pipeline::upload_csv(
        &state.db,
        &state.type_cache,
        &state.data_dir,
        &caller.rid,
        caller.is_platform_admin,
        &project,
        &format!("{name}.csv"),
        csv,
        None,
    )
    .await?;
    Ok(Json(serde_json::json!({ "rid": outcome.rid, "filename": outcome.filename, "rows": outcome.frame.height() })))
}
