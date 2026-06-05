//! Purpose: POST /api/files/:rid/sql — run a read-only SQL query over the
//! workspace file (table `t`) plus optional extra file-tables; render the
//! result through the redtable's Row shape.
//! Doc: docs/internal/code/backend/api/routes/files/sql.md
//!
//! The single SQL surface for Workspace: the raw editor calls it directly, and
//! (later) the GUI builders compile their state to SQL and hit the same path.
//! Execution + the read-only allowlist live in `data::sql`; this handler does
//! auth, hydration, the spawn_blocking hop, and pagination of the result.

use axum::{
    extract::{Path, State},
    Json,
};
use polars::prelude::DataFrame;
use serde::{Deserialize, Serialize};
use shared::file::Row;
use std::time::Instant;

use crate::{error::AppError, state::AppState};

/// The workspace file is always registered under this fixed alias, so the
/// editor's default template is stable (`SELECT * FROM t`) and the
/// GUI-compiles-to-SQL layer (Phase 3) can emit `FROM t` deterministically.
/// Extra files get caller-supplied table names.
const PRIMARY_TABLE: &str = "t";

const DEFAULT_SIZE: u32 = 50;
const MAX_SIZE: u32 = 500;

#[derive(Deserialize)]
pub(super) struct SqlBody {
    sql:  String,
    page: Option<u32>,
    size: Option<u32>,
    /// Extra files to expose as named tables (multi-file JOIN / set-ops). The
    /// editor populates these from the project's file list.
    #[serde(default)]
    tables: Vec<TableBinding>,
}

#[derive(Deserialize)]
struct TableBinding {
    name:    String,
    file_id: String,
}

/// Unlike `/page` (fixed file schema), a SQL result's columns are dynamic —
/// projection/aggregation reshape them — so the column names ship with the rows.
#[derive(Serialize)]
pub(super) struct SqlPage {
    columns: Vec<String>,
    rows:    Vec<Row>,
    total:   u64, // total result rows, pre-pagination
    page:    u32,
    size:    u32,
    pages:   u32,
    ms:      u32,
}

pub(super) async fn execute(
    State(state): State<AppState>,
    headers:      axum::http::HeaderMap,
    Path(rid):    Path<String>,
    Json(body):   Json<SqlBody>,
) -> Result<Json<SqlPage>, AppError> {
    let user = super::super::resolve_user_rid(&state, &headers).await?;

    // RBAC: view on the primary file + every extra table's file.
    crate::rbac::require_view(&state, &user, &rid, "file").await?;
    for t in &body.tables {
        crate::rbac::require_view(&state, &user, &t.file_id, "file").await?;
    }

    // Hydrate every referenced file into an owned frame for registration.
    // DataFrame::clone is cheap (Arc-backed columns).
    let primary = super::hydrate(&state, &rid).await?;
    let mut tables: Vec<(String, DataFrame)> =
        vec![(PRIMARY_TABLE.to_string(), (*primary.frame).clone())];
    for t in &body.tables {
        let entry = super::hydrate(&state, &t.file_id).await?;
        tables.push((t.name.clone(), (*entry.frame).clone()));
    }

    let page = body.page.unwrap_or(1).max(1);
    let size = body.size.unwrap_or(DEFAULT_SIZE).clamp(1, MAX_SIZE);
    let sql  = body.sql.clone();

    let started = Instant::now();
    // Polars is sync + CPU-heavy — keep it off the async runtime.
    let result = tokio::task::spawn_blocking(move || data::sql::run_sql(tables, &sql))
        .await
        .map_err(|e| AppError::internal("join", e.to_string()))?
        .map_err(map_data_err)?;

    let total  = result.height() as u64;
    let pages  = (((total + size as u64 - 1) / size as u64) as u32).max(1);
    let offset = ((page - 1) as i64) * (size as i64);
    // slice keeps the schema even at/after the end, so columns survive an empty page.
    let sliced = result.slice(offset, size as usize);
    let (rows, columns) = stringify(&sliced)?;
    let ms = started.elapsed().as_millis() as u32;

    Ok(Json(SqlPage { columns, rows, total, page, size, pages, ms }))
}

/// Map the compute-layer error onto an HTTP status. SQL syntax / unknown column
/// / unsupported-function / cap-exceeded / not-read-only are all *user* errors
/// the caller can fix → 400; the Polars message is about the query/data (no
/// secrets) so it's safe to surface.
fn map_data_err(e: data::DataError) -> AppError {
    use data::DataError::*;
    match e {
        InvalidSpec(m) => AppError::bad_request("sql", m),
        Polars(p)      => AppError::bad_request("sql", p.to_string()),
        NotFound(m)    => AppError::not_found("not_found", m),
        other          => AppError::internal("sql", other.to_string()),
    }
}

fn stringify(df: &DataFrame) -> Result<(Vec<Row>, Vec<String>), AppError> {
    let names: Vec<String> = df.get_columns().iter().map(|c| c.name().to_string()).collect();
    let mut rows: Vec<Row> = Vec::with_capacity(df.height());
    for r in 0..df.height() {
        let mut row: Row = Vec::with_capacity(df.width());
        for c in df.get_columns() {
            let v = c.get(r).map_err(|e| AppError::internal("polars", e.to_string()))?;
            row.push(av_to_owned(v));
        }
        rows.push(row);
    }
    Ok((rows, names))
}

fn av_to_owned(v: polars::prelude::AnyValue) -> Option<String> {
    use polars::prelude::AnyValue;
    match v {
        AnyValue::Null           => None,
        AnyValue::String(s)      => Some((*s).to_string()),
        AnyValue::StringOwned(s) => Some(s.to_string()),
        other                    => Some(other.to_string()),
    }
}
