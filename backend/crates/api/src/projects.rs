//! Purpose: /api/projects — the caller's reach-scoped projects (the Workspace
//! rail's N1 data). View-gated by the Caller extractor (extraction IS the gate;
//! any authed caller lists their OWN reachable projects). Reach mirrors the
//! files/mod.rs `list` shape EXACTLY: admin → all; else membership (via the
//! principal closure) on the project itself OR its company. Each row carries a
//! CSV file_count and an `is_default` flag.
//!
//! `is_default` is DERIVED, not stored: the migration declares "is_default on a
//! project is DERIVED from users.default_project_id" (there is no column). We
//! resolve it against the CALLER's own default — the project they upload into
//! when none is named.

use axum::{
    extract::{Path, Query, State},
    routing::{get, patch},
    Json, Router,
};
use serde::Deserialize;

use crate::{
    error::AppError,
    rbac::{self, Action, Caller},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/:rid", patch(rename))
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default = "default_list_limit")]
    limit: usize,
}
fn default_list_limit() -> usize {
    50
}

/// GET /api/projects — the caller's reachable projects, newest first, each with
/// a CSV file count. Reach = membership (via the principal closure) on the
/// project or its company. Admin → all. `is_default` is the caller's own
/// default project (users.default_project_id), derived — never a column.
async fn list(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let viewer: Option<Vec<String>> = if caller.is_platform_admin {
        None
    } else {
        Some(rbac::principals(&state.db, &caller.rid).await?)
    };
    let limit = q.limit.clamp(1, 200) as i64;
    let rows: Vec<(String, String, i64, bool, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT p.redpash_id, p.name,
                (SELECT COUNT(*)::BIGINT FROM project_files pf
                  WHERE pf.project_id = p.redpash_id AND pf.file_type = 'csv') AS file_count,
                (u.default_project_id = p.redpash_id) AS is_default,
                p.created_at
         FROM projects p
         LEFT JOIN users u ON u.redpash_id = $1
         WHERE ($2::text[] IS NULL OR EXISTS (
                   SELECT 1 FROM memberships m
                   WHERE m.member_redpash_id = ANY($2)
                     AND m.object_redpash_id IN (p.redpash_id, p.company_id)))
         ORDER BY p.created_at DESC LIMIT $3",
    )
    .bind(&caller.rid)
    .bind(viewer.as_deref())
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(rid, name, file_count, is_default, created_at)| {
            serde_json::json!({
                "rid": rid,
                "name": name,
                "file_count": file_count,
                "is_default": is_default,
                "created_at": created_at.to_rfc3339(),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

// rename (Edit) — the rail's inline project rename. Edit-gated like the file
// rename; name-only, mirrors files/mod.rs `rename` exactly.
async fn rename(
    State(state): State<AppState>,
    caller: Caller,
    Path(rid): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    rbac::require_action(&state.db, &state.type_cache, &caller, &rid, Action::Edit).await?;
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::bad_request("name_required", "name must be a non-empty string"))?;
    sqlx::query("UPDATE projects SET name = $1 WHERE redpash_id = $2")
        .bind(name)
        .bind(&rid)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "rid": rid, "name": name })))
}
