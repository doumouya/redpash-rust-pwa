//! Purpose: /api/monitoring — the read surface behind the Admin Monitoring page.
//! Surfaces the audit suite's runs + findings (the `audit.*` schema written by
//! the `redpash-audit-ingest` bin). PLATFORM-ADMIN ONLY: every handler opens
//! with the leak-free admin gate (404 for non-admins, never 403 — the admin.rs
//! idiom), since these are platform-ops rows, not registry entities. Read-only;
//! pagination follows the house ad-hoc `{items,total,page,size}` json! envelope
//! (lean has no shared `Page<T>`). Ported + adapted from prerelease's
//! routes/monitoring.rs (the audit-runs/findings + stats queries).

use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{error::AppError, rbac::Caller, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/audit-runs", get(list_audit_runs))
        .route("/audit-runs/stats", get(stats_audit_runs))
        .route("/audit-findings", get(list_audit_findings))
        .route("/audit-findings/stats", get(stats_audit_findings))
}

/// Platform-admin gate — leak-free 404 (never 403), mirroring admin.rs. Called
/// first in every handler so a non-admin can't even tell the surface exists.
fn require_admin(caller: &Caller) -> Result<(), AppError> {
    if caller.is_platform_admin {
        Ok(())
    } else {
        Err(AppError::not_found("not_found", "monitoring"))
    }
}

fn default_page() -> u32 {
    1
}
fn default_size() -> u32 {
    50
}

/// Resolve the run to scope findings to: an explicit `run`, else the MOST RECENT
/// run (optionally for `tool`). The list AND the stats both call this so the KPI
/// strip can't disagree with the table it annotates. `id DESC` breaks `ran_at`
/// ties so "latest" is deterministic. `None` = no runs exist yet.
async fn resolve_run(pool: &PgPool, run: Option<i64>, tool: Option<&str>) -> Result<Option<i64>, AppError> {
    if let Some(r) = run {
        return Ok(Some(r));
    }
    Ok(sqlx::query_scalar(
        "SELECT id FROM audit.run WHERE ($1::text IS NULL OR tool = $1) ORDER BY ran_at DESC, id DESC LIMIT 1",
    )
    .bind(tool)
    .fetch_optional(pool)
    .await?)
}

/// `{key: count}` object from a `SELECT <key>, COUNT(*)::bigint … GROUP BY …`.
/// `sql` is a static, code-owned string (never user input).
async fn group_count(pool: &PgPool, sql: &str) -> Result<Value, AppError> {
    let rows: Vec<(String, i64)> = sqlx::query_as(sql).fetch_all(pool).await?;
    let mut map = serde_json::Map::new();
    for (k, c) in rows {
        map.insert(k, json!(c));
    }
    Ok(Value::Object(map))
}

/// `{key: count}` over `audit.finding`, scoped by the optional run + tool filters
/// (so a findings KPI strip matches the list the user is looking at). `select`
/// and `group_by` are static, code-owned fragments.
async fn finding_group_count(
    pool: &PgPool,
    select: &str,
    group_by: &str,
    run: Option<i64>,
    tool: Option<&str>,
) -> Result<Value, AppError> {
    let sql = format!(
        "SELECT {select}, COUNT(*)::BIGINT FROM audit.finding
         WHERE ($1::bigint IS NULL OR run_id = $1)
           AND ($2::text IS NULL OR tool = $2)
         GROUP BY {group_by}"
    );
    let rows: Vec<(String, i64)> = sqlx::query_as(&sql).bind(run).bind(tool).fetch_all(pool).await?;
    let mut map = serde_json::Map::new();
    for (k, c) in rows {
        map.insert(k, json!(c));
    }
    Ok(Value::Object(map))
}

// ── audit runs ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RunsQuery {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_size")]
    size: u32,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

/// GET /api/monitoring/audit-runs?page&size&tool&q — newest first; an optional
/// exact-tool filter + free-text search over tool/branch/sha.
async fn list_audit_runs(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<RunsQuery>,
) -> Result<Json<Value>, AppError> {
    require_admin(&caller)?;
    let size = q.size.clamp(1, 200);
    let offset = i64::from(q.page.saturating_sub(1)) * i64::from(size);

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.run
         WHERE ($1::text IS NULL OR tool = $1)
           AND ($2::text IS NULL OR
                tool ILIKE '%'||$2||'%' OR
                COALESCE(git_branch,'') ILIKE '%'||$2||'%' OR
                COALESCE(git_sha,'') ILIKE '%'||$2||'%')",
    )
    .bind(q.tool.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows: Vec<(
        i64,
        String,
        chrono::DateTime<chrono::Utc>,
        Option<String>,
        Option<String>,
        sqlx::types::Json<Value>,
    )> = sqlx::query_as(
        "SELECT id, tool, ran_at, git_sha, git_branch, stats FROM audit.run
         WHERE ($1::text IS NULL OR tool = $1)
           AND ($2::text IS NULL OR
                tool ILIKE '%'||$2||'%' OR
                COALESCE(git_branch,'') ILIKE '%'||$2||'%' OR
                COALESCE(git_sha,'') ILIKE '%'||$2||'%')
         ORDER BY ran_at DESC, id DESC LIMIT $3 OFFSET $4",
    )
    .bind(q.tool.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, tool, ran_at, git_sha, git_branch, stats)| {
            json!({
                "id": id,
                "tool": tool,
                "ran_at": ran_at.to_rfc3339(),
                "git_sha": git_sha,
                "git_branch": git_branch,
                "stats": stats.0,
            })
        })
        .collect();

    Ok(Json(json!({ "items": items, "total": total, "page": q.page, "size": size })))
}

/// GET /api/monitoring/audit-runs/stats — KPI strip: total · by_tool · last_7d.
async fn stats_audit_runs(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<Value>, AppError> {
    require_admin(&caller)?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM audit.run")
        .fetch_one(&state.db)
        .await?;
    let by_tool = group_count(&state.db, "SELECT tool, COUNT(*)::BIGINT FROM audit.run GROUP BY tool").await?;
    let last_7d: i64 =
        sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM audit.run WHERE ran_at >= now() - interval '7 days'")
            .fetch_one(&state.db)
            .await?;
    Ok(Json(json!({ "total": total, "by_tool": by_tool, "last_7d": last_7d })))
}

// ── audit findings ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct FindingsQuery {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_size")]
    size: u32,
    #[serde(default)]
    run: Option<i64>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

/// GET /api/monitoring/audit-findings?page&size&run&tool&kind&q. With no `run`,
/// defaults to the most-recent run (optionally for the named tool) so the first
/// load shows one coherent set, not interleaved runs.
async fn list_audit_findings(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<FindingsQuery>,
) -> Result<Json<Value>, AppError> {
    require_admin(&caller)?;
    let size = q.size.clamp(1, 200);
    let offset = i64::from(q.page.saturating_sub(1)) * i64::from(size);

    let run_filter = resolve_run(&state.db, q.run, q.tool.as_deref()).await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.finding
         WHERE ($1::bigint IS NULL OR run_id = $1)
           AND ($2::text IS NULL OR tool = $2)
           AND ($3::text IS NULL OR kind = $3)
           AND ($4::text IS NULL OR
                tool ILIKE '%'||$4||'%' OR kind ILIKE '%'||$4||'%' OR finding_key ILIKE '%'||$4||'%')",
    )
    .bind(run_filter)
    .bind(q.tool.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.q.as_deref())
    .fetch_one(&state.db)
    .await?;

    let rows: Vec<(i64, String, String, String, Option<i32>)> = sqlx::query_as(
        "SELECT run_id, tool, kind, finding_key, severity FROM audit.finding
         WHERE ($1::bigint IS NULL OR run_id = $1)
           AND ($2::text IS NULL OR tool = $2)
           AND ($3::text IS NULL OR kind = $3)
           AND ($4::text IS NULL OR
                tool ILIKE '%'||$4||'%' OR kind ILIKE '%'||$4||'%' OR finding_key ILIKE '%'||$4||'%')
         ORDER BY run_id DESC, severity DESC NULLS LAST, finding_key
         LIMIT $5 OFFSET $6",
    )
    .bind(run_filter)
    .bind(q.tool.as_deref())
    .bind(q.kind.as_deref())
    .bind(q.q.as_deref())
    .bind(size as i64)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<Value> = rows
        .into_iter()
        .map(|(run_id, tool, kind, finding_key, severity)| {
            json!({
                "run_id": run_id,
                "tool": tool,
                "kind": kind,
                "finding_key": finding_key,
                "severity": severity,
            })
        })
        .collect();

    Ok(Json(
        json!({ "items": items, "total": total, "page": q.page, "size": size, "run": run_filter }),
    ))
}

#[derive(Deserialize)]
struct FindingsStatsQuery {
    #[serde(default)]
    run: Option<i64>,
    #[serde(default)]
    tool: Option<String>,
}

/// GET /api/monitoring/audit-findings/stats?run&tool — total · by_severity (donut)
/// · by_kind (bar), scoped to the same run/tool the list is showing. NULL
/// severity folds into 'low' (the gentlest band) so the donut stays 3 slices —
/// lean findings carry no severity yet, so today everything reads 'low'.
async fn stats_audit_findings(
    State(state): State<AppState>,
    caller: Caller,
    Query(q): Query<FindingsStatsQuery>,
) -> Result<Json<Value>, AppError> {
    require_admin(&caller)?;
    // Scope to the SAME run the list defaults to (latest when none given), so the
    // KPI strip / donut / bar agree with the findings table instead of summing
    // across every historical run.
    let run = resolve_run(&state.db, q.run, q.tool.as_deref()).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM audit.finding
         WHERE ($1::bigint IS NULL OR run_id = $1) AND ($2::text IS NULL OR tool = $2)",
    )
    .bind(run)
    .bind(q.tool.as_deref())
    .fetch_one(&state.db)
    .await?;

    let by_severity = finding_group_count(
        &state.db,
        "CASE WHEN severity IS NULL OR severity <= 5 THEN 'low' \
              WHEN severity <= 15 THEN 'med' ELSE 'high' END",
        "1",
        run,
        q.tool.as_deref(),
    )
    .await?;

    let by_kind = finding_group_count(&state.db, "kind", "kind", run, q.tool.as_deref()).await?;

    Ok(Json(json!({ "total": total, "by_severity": by_severity, "by_kind": by_kind, "run": run })))
}

#[cfg(test)]
mod tests {
    use super::require_admin;
    use crate::rbac::Caller;

    #[test]
    fn admin_gate_is_leak_free_404() {
        let admin = Caller { rid: "USR_admin".into(), is_platform_admin: true };
        let user = Caller { rid: "USR_user".into(), is_platform_admin: false };
        assert!(require_admin(&admin).is_ok());
        // a non-admin is rejected as 404 (leak-free), NEVER 403.
        let err = require_admin(&user).unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::NOT_FOUND);
    }
}
