//! Thin SQL helpers.
//!
//! All queries are non-macro (`sqlx::query` + `query_as::<_, Row>`) so
//! the crate compiles without `DATABASE_URL` at build time. Each helper
//! takes a `&PgPool` and returns a domain DTO from `shared::*`.
//!
//! ## Decomposition (in progress, 2026-05-25)
//!
//! Historically a single 2455-LOC `db.rs`. Being split into per-resource
//! modules to bring the file under the rs-audit hotspot threshold and
//! make the per-resource SQL surface navigable without grep. Re-exports
//! at the module root keep the call-site surface unchanged
//! (`crate::db::create_session(…)`); callers don't need to touch.
//!
//! Sub-modules so far:
//!   - [`sessions`] — `sessions` row CRUD (auth cookie → user-rid).
//!   - [`sentinels`] — `sentinel_submissions` + `global_sentinels`
//!     reads + writes (cleanness-vocabulary promotion plumbing).
//!   - [`users`] — `users` table CRUD + `user_preferences` patch +
//!     Google-OAuth upsert + the company-memberships join.
//!   - [`projects`] — `projects` table CRUD + the shared
//!     `PROJECT_SELECT` (file_stages + dashboard-published overlay
//!     + file_count via subqueries; one row → one ProjectSummary).

mod entities;
mod sessions;
mod sentinels;
mod users;
mod projects;
pub use entities::*;
pub use sessions::*;
pub use sentinels::*;
pub use users::*;
pub use projects::*;

use chrono::{DateTime, Utc};
use shared::case::{Case, Category, Comment};
use shared::chart::Chart;
use shared::company::{Company, CompanyMember, CompanySummary};
use shared::dashboard::{Dashboard, DashboardSpec};
use shared::event::Event;
use shared::file::{ColumnMeta, FileSummary};
use shared::step::ProjectStep;
use sqlx::{FromRow, PgPool, Row};

/// `SELECT COUNT(*)::BIGINT FROM <table>` — bare-table row count.
///
/// **`table` must be a string literal or an internally-controlled
/// constant — never user input.** sqlx can't bind identifiers, so
/// the table name is interpolated via `format!`. Every caller in
/// this crate passes a static `&str`; do not break that invariant.
///
/// 14 hand-rolled inline `sqlx::query_scalar("SELECT COUNT(*)::BIGINT
/// FROM …")` chains collapsed into this helper per the
/// rust-dedup-audit-2026-05-24 item B.
pub async fn count_total(pool: &PgPool, table: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*)::BIGINT FROM {}", table))
        .fetch_one(pool)
        .await
}

// ─── users ──────────────────────────────────────────────────────
// Extracted to db/users.rs, re-exported at the module root.


// sessions — extracted to `db/sessions.rs`, re-exported at the module root.

// ─── sentinel_submissions ───────────────────────────────────────
// Extracted to db/sentinels.rs, re-exported at the module root.

// ─── projects ───────────────────────────────────────────────────
// Extracted to db/projects.rs, re-exported at the module root.

// ─── project_files ──────────────────────────────────────────────

#[derive(FromRow)]
struct FileRow {
    redpash_id:         String,
    project_redpash_id: String,
    filename:           String,
    display_name:       Option<String>,
    file_type:          String,
    stage:              String,
    row_count:          Option<i64>,
    col_count:          Option<i32>,
    file_size_bytes:    Option<i64>,
    cleanness_pct:      Option<f32>,
    encoding:           Option<String>,
    delimiter:          Option<String>,
    storage_path:       String,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
}

pub struct FileFull {
    pub summary:      FileSummary,
    pub storage_path: String,
}

impl From<FileRow> for FileFull {
    fn from(r: FileRow) -> Self {
        let summary = FileSummary {
            redpash_id:         r.redpash_id,
            project_redpash_id: r.project_redpash_id,
            filename:           r.filename,
            display_name:       r.display_name,
            file_type:          r.file_type,
            stage:              r.stage,
            row_count:          r.row_count.map(|v| v as u64),
            col_count:          r.col_count.map(|v| v as u32),
            file_size_bytes:    r.file_size_bytes.map(|v| v as u64),
            cleanness_pct:      r.cleanness_pct,
            encoding:           r.encoding,
            delimiter:          r.delimiter,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
            fully_null_rows:    None, // populated by hydrate, not persisted
        };
        Self { summary, storage_path: r.storage_path }
    }
}

pub async fn list_files_in_project(pool: &PgPool, project_rid: &str) -> sqlx::Result<Vec<FileSummary>> {
    // PROJECT-FILES-ACK: type=any — rail listing in the Workspace.
    // Returns every file in the project — including chart-typed rows.
    // Charts used to be filtered out here because the (deleted)
    // Reports page owned the chart surface; now that the Designer
    // is inline in the Workspace, the rail needs to list them too
    // so the user can re-open a saved chart for editing.
    let rows: Vec<FileRow> = sqlx::query_as(
        "SELECT pf.redpash_id, pf.project_redpash_id, pf.filename, pf.display_name, pf.file_type,
                fs.stage, pf.row_count, pf.col_count, pf.file_size_bytes, pf.cleanness_pct,
                pf.encoding, pf.delimiter, pf.storage_path, pf.created_at, pf.updated_at
         FROM project_files pf
         JOIN file_stages fs ON fs.file_redpash_id = pf.redpash_id
         WHERE pf.project_redpash_id = $1
         ORDER BY pf.created_at ASC",
    )
    .bind(project_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| FileFull::from(r).summary).collect())
}

/// Every file owned by `owner_rid` (FK chain via project_files →
/// projects → owner_id). Powers `GET /api/files`. Returns every
/// file_type including chart — same reasoning as
/// list_files_in_project above: charts are first-class files since
/// the Designer landed inline in the Workspace.
pub async fn list_user_files(pool: &PgPool, owner_rid: &str) -> sqlx::Result<Vec<FileSummary>> {
    // PROJECT-FILES-ACK: type=any — Home Files tab + cross-project
    // inventory; every file_type surfaces (charts open the Designer,
    // dashboards open the dashboard view, csvs open the Workspace).
    let rows: Vec<FileRow> = sqlx::query_as(
        "SELECT f.redpash_id, f.project_redpash_id, f.filename, f.display_name,
                f.file_type, fs.stage, f.row_count, f.col_count, f.file_size_bytes,
                f.cleanness_pct, f.encoding, f.delimiter,
                f.storage_path, f.created_at, f.updated_at
         FROM project_files f
         JOIN projects p ON p.redpash_id = f.project_redpash_id
         JOIN file_stages fs ON fs.file_redpash_id = f.redpash_id
         WHERE p.owner_id = $1
         ORDER BY f.updated_at DESC",
    )
    .bind(owner_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| FileFull::from(r).summary).collect())
}

/// (rid, display_name or filename) for every **CSV** file in
/// `project_rid` except `exclude_rid`. Powers the joins detector.
///
/// CSV-only by design — chart / dashboard / future spec-only file
/// types (notebook, saved query) share `project_files` but carry
/// `storage_path = ''` and live in the `spec` JSON column. Hydrating
/// any of them would 400 with `not_a_data_file` (Gus's guard at
/// hydrate, commit 220296a). The positive form `= 'csv'` is
/// future-proof — new spec-only types inherit the exclusion without
/// needing to update this query.
pub async fn list_files_in_project_except(
    pool:         &PgPool,
    project_rid:  &str,
    exclude_rid:  &str,
) -> sqlx::Result<Vec<(String, String)>> {
    // PROJECT-FILES-ACK: type=csv — joins picker; chart/dashboard rows
    // have no readable frame (storage_path=''), so they're filtered
    // out at the SQL boundary (commit f49e030).
    let rows = sqlx::query(
        "SELECT redpash_id, COALESCE(display_name, filename) AS title
         FROM project_files
         WHERE project_redpash_id = $1 AND redpash_id <> $2
           AND file_type = 'csv'
         ORDER BY created_at ASC",
    )
    .bind(project_rid)
    .bind(exclude_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter()
        .map(|r| (r.get::<String, _>("redpash_id"), r.get::<String, _>("title")))
        .collect())
}

pub async fn find_file(pool: &PgPool, rid: &str) -> sqlx::Result<Option<FileFull>> {
    // PROJECT-FILES-ACK: type=any — single-row lookup by rid; the
    // caller dispatches on file_type from the returned FileSummary
    // (workspace.js::loadFile is the canonical consumer).
    let row: Option<FileRow> = sqlx::query_as(
        "SELECT pf.redpash_id, pf.project_redpash_id, pf.filename, pf.display_name, pf.file_type,
                fs.stage, pf.row_count, pf.col_count, pf.file_size_bytes, pf.cleanness_pct,
                pf.encoding, pf.delimiter, pf.storage_path, pf.created_at, pf.updated_at
         FROM project_files pf
         JOIN file_stages fs ON fs.file_redpash_id = pf.redpash_id
         WHERE pf.redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Delete a file row. `project_steps` and any chart files built from
/// it (the `source_file_id` self-FK) declare `ON DELETE CASCADE` on
/// `project_files`, so the step history and derived charts go with it.
/// Returns whether a row was actually removed (false → caller
/// surfaces a 404).
pub async fn delete_file(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    // PROJECT-FILES-ACK: type=any — delete by rid; ownership check
    // upstream gates which rids the caller can touch, type-agnostic
    // here. delete_chart / delete_dashboard exist as type-scoped
    // variants for the dedicated CRUD lanes.
    let res = sqlx::query("DELETE FROM project_files WHERE redpash_id = $1")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Sparse metadata update — `display_name`, `project_redpash_id`
/// (move the file to another project), `encoding` and `delimiter`. A
/// `None` leaves that column untouched (COALESCE). File `stage` is
/// computed from the `file_stages` view, not stored, so it isn't
/// editable here. Re-fetches through `find_file` so the returned
/// summary carries the joined stage.
pub async fn update_file_meta(
    pool:               &PgPool,
    rid:                &str,
    display_name:       Option<&str>,
    project_redpash_id: Option<&str>,
    encoding:           Option<&str>,
    delimiter:          Option<&str>,
) -> sqlx::Result<Option<FileFull>> {
    let res = sqlx::query(
        "UPDATE project_files
         SET display_name       = COALESCE($2, display_name),
             project_redpash_id = COALESCE($3, project_redpash_id),
             encoding           = COALESCE($4, encoding),
             delimiter          = COALESCE($5, delimiter),
             updated_at         = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .bind(display_name)
    .bind(project_redpash_id)
    .bind(encoding)
    .bind(delimiter)
    .execute(pool)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    find_file(pool, rid).await
}

pub async fn update_file_encoding(pool: &PgPool, rid: &str, encoding: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE project_files SET encoding = $1, updated_at = now() WHERE redpash_id = $2",
    )
    .bind(encoding)
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(())
}

/// Null-out a file's cleanness score (testing/dev convenience). Used
/// by `DELETE /api/files/:rid/cleanness` so the user can clear scores
/// and re-run the score-files button to verify the recompute path.
pub async fn clear_file_cleanness(pool: &PgPool, rid: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE project_files SET cleanness_pct = NULL, updated_at = now()
         WHERE redpash_id = $1",
    )
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_file_columns(
    pool:      &PgPool,
    rid:       &str,
    columns:   &[ColumnMeta],
    row_count: u64,
    col_count: u32,
    cleanness: Option<f32>,
) -> sqlx::Result<()> {
    let cols_json = serde_json::to_value(columns).unwrap_or(serde_json::json!([]));
    sqlx::query(
        "UPDATE project_files
         SET columns_meta = $1, row_count = $2, col_count = $3,
             cleanness_pct = $4, updated_at = now()
         WHERE redpash_id = $5",
    )
    .bind(cols_json)
    .bind(row_count as i64)
    .bind(col_count as i32)
    .bind(cleanness)
    .bind(rid)
    .execute(pool)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_file(
    pool:         &PgPool,
    rid:          &str,
    project:      &str,
    filename:     &str,
    encoding:     &str,
    row_count:    u64,
    col_count:    u32,
    size_bytes:   u64,
    storage_path: &str,
    columns:      &[ColumnMeta],
    cleanness:    Option<f32>,
) -> sqlx::Result<()> {
    let cols_json = serde_json::to_value(columns).unwrap_or(serde_json::json!([]));
    sqlx::query(
        "INSERT INTO project_files
            (redpash_id, project_redpash_id, filename, display_name,
             row_count, col_count, file_size_bytes, encoding, storage_path,
             columns_meta, cleanness_pct)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(rid)
    .bind(project)
    .bind(filename)
    .bind(row_count as i64)
    .bind(col_count as i32)
    .bind(size_bytes as i64)
    .bind(encoding)
    .bind(storage_path)
    .bind(cols_json)
    .bind(cleanness)
    .execute(pool)
    .await?;
    Ok(())
}

// ─── charts (chart-typed project_files rows) ────────────────────

#[derive(FromRow)]
struct ChartRow {
    redpash_id:         String,
    project_redpash_id: String,
    source_file_id:     String,
    title:              String,
    spec:               serde_json::Value,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
}
impl From<ChartRow> for Chart {
    fn from(r: ChartRow) -> Self {
        Self {
            redpash_id:         r.redpash_id,
            project_redpash_id: r.project_redpash_id,
            source_file_id:     r.source_file_id,
            title:              r.title,
            spec:               r.spec,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
        }
    }
}

// A chart is a project_files row with file_type='chart'. `title` is
// COALESCE(display_name, filename) — both are set to the chart title.
const CHART_COLS: &str = "redpash_id, project_redpash_id, source_file_id,
                          COALESCE(display_name, filename) AS title,
                          spec, created_at, updated_at";

pub async fn list_charts(pool: &PgPool, owner: &str) -> sqlx::Result<Vec<Chart>> {
    // PROJECT-FILES-ACK: type=chart — owner's saved charts.
    // Single-table SELECT — a JOIN to `projects` collides the shared,
    // unqualified CHART_COLS on redpash_id / created_at / updated_at
    // ("column reference redpash_id is ambiguous"). Owner filter runs as
    // a subquery so CHART_COLS stays usable as-is, shared unchanged with
    // find_chart / insert_chart / update_chart.
    let rows: Vec<ChartRow> = sqlx::query_as(&format!(
        "SELECT {CHART_COLS} FROM project_files
         WHERE file_type = 'chart'
           AND project_redpash_id IN (
             SELECT redpash_id FROM projects WHERE owner_id = $1)
         ORDER BY updated_at DESC"
    ))
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_chart(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Chart>> {
    // PROJECT-FILES-ACK: type=chart — single chart by rid; type-filter
    // guards against a non-chart rid leaking into the chart deserializer.
    let row: Option<ChartRow> = sqlx::query_as(&format!(
        "SELECT {CHART_COLS} FROM project_files
         WHERE redpash_id = $1 AND file_type = 'chart'"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn insert_chart(
    pool:    &PgPool,
    rid:     &str,
    project: &str,
    source:  &str,
    title:   &str,
    spec:    &serde_json::Value,
) -> sqlx::Result<Chart> {
    let row: ChartRow = sqlx::query_as(&format!(
        "INSERT INTO project_files
            (redpash_id, project_redpash_id, filename, display_name,
             file_type, source_file_id, storage_path, spec)
         VALUES ($1, $2, $3, $3, 'chart', $4, '', $5)
         RETURNING {CHART_COLS}"
    ))
    .bind(rid)
    .bind(project)
    .bind(title)
    .bind(source)
    .bind(spec)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

pub async fn update_chart(
    pool:  &PgPool,
    rid:   &str,
    title: &str,
    spec:  &serde_json::Value,
) -> sqlx::Result<Option<Chart>> {
    let row: Option<ChartRow> = sqlx::query_as(&format!(
        "UPDATE project_files
         SET filename = $1, display_name = $1, spec = $2, updated_at = now()
         WHERE redpash_id = $3 AND file_type = 'chart'
         RETURNING {CHART_COLS}"
    ))
    .bind(title)
    .bind(spec)
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn delete_chart(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    // PROJECT-FILES-ACK: type=chart — type-scoped delete; ensures a
    // dashboard rid passed in by mistake doesn't get clobbered.
    let n = sqlx::query("DELETE FROM project_files WHERE redpash_id = $1 AND file_type = 'chart'")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(n.rows_affected() > 0)
}

pub async fn chart_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    // PROJECT-FILES-ACK: type=chart — chart ownership lookup; the
    // type-filter ensures a non-chart rid returns None (no auth-leak
    // via cross-type rid collision).
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.owner_id FROM project_files pf
         JOIN projects p ON p.redpash_id = pf.project_redpash_id
         WHERE pf.redpash_id = $1 AND pf.file_type = 'chart'",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

// ─── dashboards ─────────────────────────────────────────────────

#[derive(FromRow)]
struct DashboardRow {
    redpash_id:         String,
    project_redpash_id: String,
    title:              String,
    description:        Option<String>,
    spec:               serde_json::Value,
    is_favorite:        bool,
    is_public:          bool,
    folder:             Option<String>,
    created_at:         DateTime<Utc>,
    updated_at:         DateTime<Utc>,
    // Owner join — only present in list_dashboards' SELECT. #[sqlx(default)]
    // keeps single-row fetchers (find / update / patch / set_favorite)
    // working without the join.
    #[sqlx(default)] owner_id:           Option<String>,
    #[sqlx(default)] owner_display_name: Option<String>,
    #[sqlx(default)] owner_username:     Option<String>,
}
impl From<DashboardRow> for Dashboard {
    fn from(r: DashboardRow) -> Self {
        Self {
            redpash_id:         r.redpash_id,
            project_redpash_id: r.project_redpash_id,
            title:              r.title,
            description:        r.description,
            spec:               serde_json::from_value(r.spec).unwrap_or_default(),
            is_favorite:        r.is_favorite,
            is_public:          r.is_public,
            folder:             r.folder,
            owner_id:           r.owner_id,
            owner_display_name: r.owner_display_name,
            owner_username:     r.owner_username,
            created_at:         r.created_at,
            updated_at:         r.updated_at,
        }
    }
}

// A dashboard is a project_files row with file_type='dashboard'.
// `title` is COALESCE(display_name, filename) — both hold the title.
const DASHBOARD_COLS: &str = "redpash_id, project_redpash_id,
                              COALESCE(display_name, filename) AS title,
                              description, spec, is_favorite, is_public,
                              folder, created_at, updated_at";

pub async fn list_dashboards(pool: &PgPool, owner: &str) -> sqlx::Result<Vec<Dashboard>> {
    // PROJECT-FILES-ACK: type=dashboard — owner's saved dashboards.
    let rows: Vec<DashboardRow> = sqlx::query_as(
        "SELECT d.redpash_id, d.project_redpash_id,
                COALESCE(d.display_name, d.filename) AS title,
                d.description, d.spec,
                d.is_favorite, d.is_public, d.folder, d.created_at, d.updated_at,
                p.owner_id AS owner_id,
                u.display_name AS owner_display_name,
                u.username AS owner_username
         FROM project_files d
         JOIN projects p ON p.redpash_id = d.project_redpash_id
         JOIN users    u ON u.redpash_id = p.owner_id
         WHERE d.file_type = 'dashboard' AND p.owner_id = $1
         ORDER BY d.folder ASC NULLS LAST, d.is_favorite DESC, d.updated_at DESC",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_dashboard(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Dashboard>> {
    // PROJECT-FILES-ACK: type=dashboard — single dashboard by rid;
    // type-filter prevents a non-dashboard rid leaking into the
    // dashboard deserializer.
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "SELECT {DASHBOARD_COLS} FROM project_files
         WHERE redpash_id = $1 AND file_type = 'dashboard'"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn insert_dashboard(
    pool:    &PgPool,
    rid:     &str,
    project: &str,
    title:   &str,
    spec:    &DashboardSpec,
    folder:  Option<&str>,
    description: Option<&str>,
) -> sqlx::Result<Dashboard> {
    let spec_json = serde_json::to_value(spec).unwrap_or(serde_json::json!({}));
    let row: DashboardRow = sqlx::query_as(&format!(
        "INSERT INTO project_files
            (redpash_id, project_redpash_id, filename, display_name,
             file_type, storage_path, spec, description, folder)
         VALUES ($1, $2, $3, $3, 'dashboard', '', $5, $4, $6)
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(rid)
    .bind(project)
    .bind(title)
    .bind(description)
    .bind(spec_json)
    .bind(folder)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

pub async fn update_dashboard(
    pool:    &PgPool,
    rid:     &str,
    title:   &str,
    spec:    &DashboardSpec,
    folder:  Option<&str>,
    description: Option<&str>,
) -> sqlx::Result<Option<Dashboard>> {
    let spec_json = serde_json::to_value(spec).unwrap_or(serde_json::json!({}));
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "UPDATE project_files
         SET filename = $1, display_name = $1, description = $2,
             spec = $3, folder = $4, updated_at = now()
         WHERE redpash_id = $5 AND file_type = 'dashboard'
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(title)
    .bind(description)
    .bind(spec_json)
    .bind(folder)
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn delete_dashboard(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    // PROJECT-FILES-ACK: type=dashboard — type-scoped delete; mirrors
    // delete_chart shape (caller's CRUD lane stays type-isolated).
    let n = sqlx::query("DELETE FROM project_files WHERE redpash_id = $1 AND file_type = 'dashboard'")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(n.rows_affected() > 0)
}

/// Sparse metadata update for the Dashboards-tab inline editor.
/// `None` keeps the existing column value (COALESCE).
pub async fn patch_dashboard_meta(
    pool:        &PgPool,
    rid:         &str,
    title:       Option<&str>,
    description: Option<&str>,
    folder:      Option<&str>,
    is_favorite: Option<bool>,
    is_public:   Option<bool>,
) -> sqlx::Result<Option<Dashboard>> {
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "UPDATE project_files
         SET filename     = COALESCE($2, filename),
             display_name = COALESCE($2, display_name),
             description  = COALESCE($3, description),
             folder       = COALESCE($4, folder),
             is_favorite  = COALESCE($5, is_favorite),
             is_public    = COALESCE($6, is_public),
             updated_at   = now()
         WHERE redpash_id = $1 AND file_type = 'dashboard'
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(rid)
    .bind(title)
    .bind(description)
    .bind(folder)
    .bind(is_favorite)
    .bind(is_public)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn set_dashboard_favorite(
    pool:  &PgPool,
    rid:   &str,
    value: bool,
) -> sqlx::Result<Option<Dashboard>> {
    let row: Option<DashboardRow> = sqlx::query_as(&format!(
        "UPDATE project_files SET is_favorite = $1, updated_at = now()
         WHERE redpash_id = $2 AND file_type = 'dashboard'
         RETURNING {DASHBOARD_COLS}"
    ))
    .bind(value)
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

// ─── project_steps ──────────────────────────────────────────────

#[derive(FromRow)]
struct StepRow {
    redpash_id:      String,
    file_redpash_id: String,
    ordinal:         i32,
    kind:            String,
    params:          serde_json::Value,
    applied:         bool,
    created_at:      DateTime<Utc>,
}
impl From<StepRow> for ProjectStep {
    fn from(r: StepRow) -> Self {
        Self {
            redpash_id:      r.redpash_id,
            file_redpash_id: r.file_redpash_id,
            ordinal:         r.ordinal,
            kind:            r.kind,
            params:          r.params,
            applied:         r.applied,
            created_at:      r.created_at,
        }
    }
}

/// All steps for a file in ordinal order — applied AND undone.
/// Frontend uses the full list to draw the Applied panel (with greyed
/// undone entries) and to enable/disable Undo + Redo buttons.
pub async fn list_steps(pool: &PgPool, file_rid: &str) -> sqlx::Result<Vec<ProjectStep>> {
    let rows: Vec<StepRow> = sqlx::query_as(
        "SELECT redpash_id, file_redpash_id, ordinal, kind, params, applied, created_at
         FROM project_steps WHERE file_redpash_id = $1 ORDER BY ordinal ASC",
    )
    .bind(file_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Append a new step. Clears the redo stack (deletes any undone rows
/// for the file) so the new step branches from the live cursor.
pub async fn insert_step(
    pool:     &PgPool,
    rid:      &str,
    file_rid: &str,
    kind:     &str,
    params:   &serde_json::Value,
) -> sqlx::Result<ProjectStep> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM project_steps WHERE file_redpash_id = $1 AND applied = false")
        .bind(file_rid).execute(&mut *tx).await?;

    let next_ord: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM project_steps WHERE file_redpash_id = $1",
    )
    .bind(file_rid)
    .fetch_one(&mut *tx)
    .await?;

    let row: StepRow = sqlx::query_as(
        "INSERT INTO project_steps (redpash_id, file_redpash_id, ordinal, kind, params)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING redpash_id, file_redpash_id, ordinal, kind, params, applied, created_at",
    )
    .bind(rid)
    .bind(file_rid)
    .bind(next_ord)
    .bind(kind)
    .bind(params)
    .fetch_one(&mut *tx)
    .await?;

    // Implicit unarchive: any cleaning activity on a file inside an
    // archived project means the user is no longer "done with it" —
    // clear the stored 'archived' (flip to 'draft') so the derived
    // status in PROJECT_SELECT (published > archived > active > draft)
    // re-evaluates and shows it as Active (the project has files, so
    // the 'active' branch wins). No-op when the project isn't archived.
    // Runs in-tx so the step + the unarchive land together.
    //
    // PROJECT-FILES-ACK: type=any — subquery resolves a file rid to
    // its project regardless of file_type (charts/dashboards can also
    // be unarchive triggers in principle, though today only csv steps
    // reach this path).
    sqlx::query(
        "UPDATE projects
         SET status = 'draft', updated_at = now()
         WHERE redpash_id = (
             SELECT project_redpash_id FROM project_files WHERE redpash_id = $1
         )
         AND status = 'archived'",
    )
    .bind(file_rid)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(row.into())
}

/// Flip the highest-ordinal applied step to `applied = false`.
/// Returns whether anything changed.
pub async fn undo_last(pool: &PgPool, file_rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE project_steps SET applied = false
         WHERE redpash_id = (
             SELECT redpash_id FROM project_steps
             WHERE file_redpash_id = $1 AND applied = true
             ORDER BY ordinal DESC LIMIT 1
         )",
    )
    .bind(file_rid)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

/// Surgically un-apply every step of a given kind on a file. Unlike
/// `undo_last` (LIFO) this flips `applied = false` for ALL matching
/// rows regardless of position, so a buried filter_rows step can be
/// cleared without disturbing the steps applied on top of it. Returns
/// the number of rows touched (caller may surface a "Cleared N" toast).
///
/// Rows aren't deleted — they just leave the applied chain. Redo
/// won't pick them back up either (redo picks the LOWEST-ordinal
/// undone step, which is fine: these become permanently undone unless
/// the user re-applies them via the panel).
pub async fn clear_steps_of_kind(pool: &PgPool, file_rid: &str, kind: &str)
    -> sqlx::Result<u64>
{
    let n = sqlx::query(
        "UPDATE project_steps SET applied = false
         WHERE file_redpash_id = $1 AND kind = $2 AND applied = true",
    )
    .bind(file_rid)
    .bind(kind)
    .execute(pool)
    .await?;
    Ok(n.rows_affected())
}

/// Flip the lowest-ordinal undone step back to `applied = true`.
pub async fn redo_next(pool: &PgPool, file_rid: &str) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE project_steps SET applied = true
         WHERE redpash_id = (
             SELECT redpash_id FROM project_steps
             WHERE file_redpash_id = $1 AND applied = false
             ORDER BY ordinal ASC LIMIT 1
         )",
    )
    .bind(file_rid)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

// ─── Phase 4c: ownership-scoped lookups ──────────────────────────
//
// Each helper resolves the owner user RID for a given resource by
// following the FK chain to `projects.owner_id`. Returns `None` when
// the resource doesn't exist — handlers map both "doesn't exist" and
// "exists but not yours" to the same 404 `not_found` so existence
// isn't leaked.

pub async fn project_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT owner_id FROM projects WHERE redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

pub async fn dashboard_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    // PROJECT-FILES-ACK: type=dashboard — dashboard ownership lookup;
    // type-filter prevents auth-leak via cross-type rid collision.
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.owner_id FROM project_files pf
         JOIN projects p ON p.redpash_id = pf.project_redpash_id
         WHERE pf.redpash_id = $1 AND pf.file_type = 'dashboard'",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

pub async fn file_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    // PROJECT-FILES-ACK: type=any — owner lookup by rid, type-agnostic
    // (charts + dashboards + csvs all share the same ownership chain
    // through projects.owner_id). chart_owner / dashboard_owner are
    // type-scoped variants used where the CRUD lane needs the
    // type-collision guard.
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT p.owner_id FROM project_files f
         JOIN projects p ON p.redpash_id = f.project_redpash_id
         WHERE f.redpash_id = $1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

// ─── companies ──────────────────────────────────────────────────
//
// A company is the multi-tenancy boundary. Membership lives in the
// unified `memberships` table (composite PK `(object_redpash_id,
// user_redpash_id)`, no redpash_id) and doubles as the access-control
// check: a user with no membership row simply can't see the company.

#[derive(FromRow)]
struct CompanyRow {
    redpash_id: String,
    name:       String,
    slug:       String,
    avatar_url: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
impl From<CompanyRow> for Company {
    fn from(r: CompanyRow) -> Self {
        Self {
            redpash_id: r.redpash_id,
            name:       r.name,
            slug:       r.slug,
            avatar_url: r.avatar_url,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const COMPANY_COLS: &str = "redpash_id, name, slug, avatar_url, created_at, updated_at";

/// Companies the user belongs to, each carrying the caller's own role
/// and the total member count.
/// Returns every company. `my_role` is the caller's role when they
/// belong to the company, or `None` when they don't — the Companies
/// tab surfaces non-member companies too so the user can discover and
/// request to join. Caller-scoped writes (member CRUD, company edits)
/// still enforce `company_role()` checks at the route layer.
pub async fn list_companies(pool: &PgPool, user_rid: &str) -> sqlx::Result<Vec<CompanySummary>> {
    let rows = sqlx::query(
        "SELECT c.redpash_id, c.name, c.slug, c.avatar_url, c.created_at, c.updated_at,
                m.role AS my_role,
                (SELECT COUNT(*) FROM memberships cm
                 WHERE cm.object_redpash_id = c.redpash_id) AS member_count
         FROM companies c
         LEFT JOIN memberships m
                ON m.object_redpash_id = c.redpash_id AND m.user_redpash_id = $1
         ORDER BY c.name ASC",
    )
    .bind(user_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| CompanySummary {
            company: Company {
                redpash_id: r.get("redpash_id"),
                name:       r.get("name"),
                slug:       r.get("slug"),
                avatar_url: r.get("avatar_url"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
            },
            member_count: r.try_get::<i64, _>("member_count").unwrap_or(0) as u32,
            my_role:      r.try_get("my_role").ok(),
        })
        .collect())
}

pub async fn get_company(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Company>> {
    let row: Option<CompanyRow> = sqlx::query_as(&format!(
        "SELECT {COMPANY_COLS} FROM companies WHERE redpash_id = $1"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// The caller's role in a company, or `None` when they aren't a member.
/// Handlers treat `None` the same as "company doesn't exist" (404) so
/// existence isn't leaked.
pub async fn company_role(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM memberships
         WHERE object_redpash_id = $1 AND user_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(r,)| r))
}

/// Two users share at least one company (i.e. there exists a company
/// where both hold a `memberships` row, object = a company). Used by the events
/// read-gate so another company can't see another company's logs;
/// RBAC will tighten this further to per-role checks. Self-match
/// (user_a == user_b) returns true without touching the DB — saves
/// the join when the caller is the event's own user.
pub async fn users_share_company(
    pool:   &PgPool,
    user_a: &str,
    user_b: &str,
) -> sqlx::Result<bool> {
    if user_a == user_b { return Ok(true); }
    // Post-consolidation `memberships` spans companies/projects/cases, so
    // constrain the shared object to a COMPANY (rid prefix) — otherwise a
    // shared project/case membership would falsely read as "share company".
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1::BIGINT
           FROM memberships a
           JOIN memberships b
             ON b.object_redpash_id = a.object_redpash_id
          WHERE a.user_redpash_id = $1
            AND b.user_redpash_id = $2
            AND a.object_redpash_id LIKE 'CMP\\_%'
          LIMIT 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Count of owners — guards the "can't strand a company without an
/// owner" rule on member removal / demotion.
pub async fn company_owner_count(pool: &PgPool, company_rid: &str) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM memberships
         WHERE object_redpash_id = $1 AND role = 'owner'",
    )
    .bind(company_rid)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

/// Create a company and seat the creator as its owner — both writes in
/// one transaction so a company never exists without an owner.
pub async fn create_company(
    pool:      &PgPool,
    rid:       &str,
    name:      &str,
    slug:      &str,
    owner_rid: &str,
) -> sqlx::Result<Company> {
    let mut tx = pool.begin().await?;
    register_entity(&mut *tx, rid, "company").await?;
    let row: CompanyRow = sqlx::query_as(&format!(
        "INSERT INTO companies (redpash_id, name, slug)
         VALUES ($1, $2, $3)
         RETURNING {COMPANY_COLS}"
    ))
    .bind(rid)
    .bind(name)
    .bind(slug)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, user_redpash_id, role)
         VALUES ($1, $2, 'owner')",
    )
    .bind(rid)
    .bind(owner_rid)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row.into())
}

/// Sparse update — `name` / `avatar_url` only. `slug` is immutable.
/// Returns the refreshed record, or `None` when the company is gone.
pub async fn update_company(
    pool:       &PgPool,
    rid:        &str,
    name:       Option<&str>,
    slug:       Option<String>,
    avatar_url: Option<&str>,
) -> sqlx::Result<Option<Company>> {
    let row: Option<CompanyRow> = sqlx::query_as(&format!(
        "UPDATE companies
         SET name       = COALESCE($2, name),
             slug       = COALESCE($3, slug),
             avatar_url = COALESCE($4, avatar_url),
             updated_at = now()
         WHERE redpash_id = $1
         RETURNING {COMPANY_COLS}"
    ))
    .bind(rid)
    .bind(name)
    .bind(slug)
    .bind(avatar_url)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Delete a company via the entity registry — cascades to the `companies`
/// row, then onward: `memberships` cascade (object = the company),
/// `projects.company_id` is `SET NULL` so company projects survive as personal.
pub async fn delete_company(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    delete_entity(pool, rid).await
}

/// Delete a membership row. Post-consolidation the object rid (`scope_id`)
/// uniquely identifies the parent, so the old per-scope table branch
/// collapses to one query; `scope` is kept for call-site compatibility +
/// the route's own validation but no longer steers the SQL.
pub async fn delete_membership(
    pool:     &PgPool,
    scope:    &str,
    scope_id: &str,
    user_id:  &str,
) -> sqlx::Result<bool> {
    let _ = scope;
    let n = sqlx::query(
        "DELETE FROM memberships
          WHERE object_redpash_id = $1 AND user_redpash_id = $2",
    )
    .bind(scope_id)
    .bind(user_id)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

/// Insert a membership row. Role allow-lists are enforced at the route
/// layer; the SQL CHECK (owner/admin/member/viewer) is the last line of
/// defense. Post-consolidation one table holds every scope — the object
/// rid (`scope_id`) is the parent, so the per-scope branch is gone;
/// `scope` is kept for call-site compatibility + route validation.
/// Bubbles 23503 (FK violation → object/user gone) and 23505 (duplicate
/// PK) up so the route maps them to 404 / 409.
pub async fn insert_membership(
    pool:     &PgPool,
    scope:    &str,
    scope_id: &str,
    user_id:  &str,
    role:     &str,
) -> sqlx::Result<()> {
    let _ = scope;
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, user_redpash_id, role)
         VALUES ($1, $2, $3)",
    )
    .bind(scope_id)
    .bind(user_id)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_company_members(
    pool:        &PgPool,
    company_rid: &str,
) -> sqlx::Result<Vec<CompanyMember>> {
    let rows = sqlx::query(
        "SELECT m.user_redpash_id, m.role, m.joined_at,
                u.display_name, u.username, u.avatar_url
         FROM memberships m
         JOIN users u ON u.redpash_id = m.user_redpash_id
         WHERE m.object_redpash_id = $1
         ORDER BY m.joined_at ASC",
    )
    .bind(company_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| CompanyMember {
            user_redpash_id: r.get("user_redpash_id"),
            display_name:    r.get("display_name"),
            username:        r.get("username"),
            avatar_url:      r.get("avatar_url"),
            role:            r.get("role"),
            joined_at:       r.get("joined_at"),
        })
        .collect())
}

/// Add a member, or update their role if they're already in the company
/// — the composite PK makes this an upsert.
pub async fn add_company_member(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
    role:        &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, user_redpash_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (object_redpash_id, user_redpash_id)
         DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(company_rid)
    .bind(user_rid)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(())
}

/// Strict UPDATE — used by `PATCH /:rid/members/:user_id`. Returns
/// whether the membership existed; the route handler `?`s into a
/// 404 when it didn't. Distinct from `add_company_member`'s upsert
/// path so a client that thinks it's editing an existing member
/// doesn't silently create one when the FK isn't there.
pub async fn update_company_member_role(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
    role:        &str,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE memberships SET role = $3
          WHERE object_redpash_id = $1 AND user_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .bind(role)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

pub async fn remove_company_member(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "DELETE FROM memberships
         WHERE object_redpash_id = $1 AND user_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .execute(pool)
    .await?;
    Ok(n.rows_affected() > 0)
}

// ─── events ─────────────────────────────────────────────────────
//
// Read side only — the INSERT lives in `crate::event::record`, which
// runs fire-and-forget off a detached task (the request path must
// never block on, or fail because of, event logging).

#[derive(FromRow)]
struct EventRow {
    redpash_id:      String,
    occurred_at:     DateTime<Utc>,
    origin:          String,
    level:           String,
    kind:            String,
    message:         String,
    source:          Option<String>,
    user_redpash_id: Option<String>,
    session_id:      Option<String>,
    request_id:      Option<String>,
    http_method:     Option<String>,
    http_path:       Option<String>,
    http_status:     Option<i32>,
    duration_ms:     Option<i32>,
    context:         serde_json::Value,
}
impl From<EventRow> for Event {
    fn from(r: EventRow) -> Self {
        Self {
            redpash_id:      r.redpash_id,
            occurred_at:     r.occurred_at,
            origin:          r.origin,
            level:           r.level,
            kind:            r.kind,
            message:         r.message,
            source:          r.source,
            user_redpash_id: r.user_redpash_id,
            session_id:      r.session_id,
            request_id:      r.request_id,
            http_method:     r.http_method,
            http_path:       r.http_path,
            http_status:     r.http_status,
            duration_ms:     r.duration_ms,
            context:         r.context,
        }
    }
}

const EVENT_COLS: &str =
    "redpash_id, occurred_at, origin, level, kind, message, source,
     user_redpash_id, session_id, request_id, http_method, http_path,
     http_status, duration_ms, context";

/// Recent events, newest first. `level` / `kind` are optional exact-match
/// filters — the `$n::text IS NULL OR …` form means a `None` bind skips
/// that filter without dynamic SQL. `limit` is clamped by the caller.
pub async fn list_events(
    pool:  &PgPool,
    level: Option<&str>,
    kind:  Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<Event>> {
    let rows: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events
         WHERE ($1::text IS NULL OR level = $1)
           AND ($2::text IS NULL OR kind  = $2)
         ORDER BY occurred_at DESC
         LIMIT $3"
    ))
    .bind(level)
    .bind(kind)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_event(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Event>> {
    let row: Option<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events WHERE redpash_id = $1"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Every event row tagged with `request_id`, ordered ascending so the
/// operator reads the timeline top-to-bottom. Powers the M-1
/// request-replay drill-down on the Monitoring page (investigation
/// I-2). No limit — request-scoped event lists are bounded by the
/// number of fire-and-forget event::record sites a single handler can
/// trigger; in practice 0-5 rows.
pub async fn list_events_for_request(pool: &PgPool, request_id: &str) -> sqlx::Result<Vec<Event>> {
    let rows: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events
         WHERE request_id = $1
         ORDER BY occurred_at ASC"
    ))
    .bind(request_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

// Per-user event slice helper retired 2026-05-25 — the M-2 activity
// feed now runs a server-side UNION ALL over events + request_log in
// `routes::monitoring::user_activity` so the merged stream paginates
// faithfully. Splitting into two single-source helpers + merging in
// the handler is the shape we just deleted.

// ─── cases + comments ──────────────────────────────────────────────
// Jira-flow workstream v1. Case lifecycle changes are NOT persisted
// here — they emit `events.kind = 'case_*'` rows via the existing
// `event::record` path. The activity feed query joins through there.

#[derive(FromRow)]
struct CaseRow {
    redpash_id:             String,
    r#type:                 String,
    title:                  String,
    description:            Option<String>,
    status:                 String,
    priority:               String,
    reporter_id:            Option<String>,
    assignee_id:            Option<String>,
    project_id:             Option<String>,
    company_id:             Option<String>,
    reporter_display_name:  Option<String>,
    assignee_display_name:  Option<String>,
    error_message:          Option<String>,
    category_id:            Option<String>,
    category_name:          Option<String>,
    category_parent_id:     Option<String>,
    category_parent_name:   Option<String>,
    created_at:             DateTime<Utc>,
    updated_at:             DateTime<Utc>,
}
impl From<CaseRow> for Case {
    fn from(r: CaseRow) -> Self {
        Self {
            redpash_id:             r.redpash_id,
            r#type:                 r.r#type,
            title:                  r.title,
            description:            r.description,
            status:                 r.status,
            priority:               r.priority,
            reporter_id:            r.reporter_id,
            assignee_id:            r.assignee_id,
            project_id:             r.project_id,
            company_id:             r.company_id,
            reporter_display_name:  r.reporter_display_name,
            assignee_display_name:  r.assignee_display_name,
            error_message:          r.error_message,
            category_id:            r.category_id,
            category_name:          r.category_name,
            category_parent_id:     r.category_parent_id,
            category_parent_name:   r.category_parent_name,
            created_at:             r.created_at,
            updated_at:             r.updated_at,
        }
    }
}

/// SELECT list for queries that hydrate user display names via LEFT
/// JOIN. Aliased prefix `c` for the cases row + `r`/`a` for reporter
/// and assignee user joins. Display names are nullable — null when
/// the user no longer exists (FK ON DELETE SET NULL on reporter_id /
/// assignee_id; the case outlives the deletion + the join becomes
/// NULL).
const CASE_SELECT: &str =
    "c.redpash_id, c.type, c.title, c.description, c.status, c.priority,
     c.reporter_id, c.assignee_id, c.project_id, c.company_id,
     r.display_name AS reporter_display_name,
     a.display_name AS assignee_display_name,
     c.error_message,
     c.category_id,
     cat.name           AS category_name,
     cat.parent_id      AS category_parent_id,
     catp.name          AS category_parent_name,
     c.created_at, c.updated_at";

/// LEFT JOINs for reporter + assignee user lookups + the two-level
/// category hydration (`cat` is the case's tagged category; `catp`
/// is the parent of that category, NULL when the case is tagged at
/// the root). Append after a `FROM cases c` clause; partners with
/// CASE_SELECT.
const CASE_USER_JOINS: &str =
    "LEFT JOIN users r            ON r.redpash_id    = c.reporter_id
     LEFT JOIN users a            ON a.redpash_id    = c.assignee_id
     LEFT JOIN case_categories cat ON cat.redpash_id = c.category_id
     LEFT JOIN case_categories catp ON catp.redpash_id = cat.parent_id";

// PROJECT-FILES-ACK: type=any — cases doesn't touch project_files.
// (The ack rule is for project_files queries; included here as a
// signal to future contributors that this scan is intentional.)

/// List cases with optional filters. Each `Option` bind skips its
/// filter when None (the `$n::text IS NULL OR …` idiom). LEFT JOINs
/// users so reporter_display_name + assignee_display_name come back
/// hydrated — saves the FE a per-row N+1 user-lookup.
///
/// `source` is "internal" | "external" | None. When set, an EXISTS
/// clause against `memberships` (object = the internal company) filters by
/// whether the case's reporter shares membership with the canonical internal company
/// (resolved at AppState init from REDPASH_INTERNAL_COMPANY_NAME).
/// Cases with NULL reporter_id are external by construction (NOT
/// EXISTS of nothing → true). When `internal_company_id` is None
/// (no matching company at startup), the source filter is a no-op:
/// every case passes regardless of `source`.
#[allow(clippy::too_many_arguments)]
pub async fn list_cases(
    pool:                &PgPool,
    status:              Option<&str>,
    assignee_id:         Option<&str>,
    project_id:          Option<&str>,
    q:                   Option<&str>,
    source:              Option<&str>,
    internal_company_id: Option<&str>,
    sort_col:            &str,   // sourced from SORTABLE_CASES allowlist — safe to splice
    sort_dir:            &str,   // "ASC" | "DESC" — sourced from sort_clause
    limit:               i64,
    offset:              i64,
) -> sqlx::Result<Vec<Case>> {
    let rows: Vec<CaseRow> = sqlx::query_as(&format!(
        "SELECT {CASE_SELECT} FROM cases c {CASE_USER_JOINS}
         WHERE ($1::text IS NULL OR c.status      = $1)
           AND ($2::text IS NULL
                OR ($2 = '__unassigned__' AND c.assignee_id IS NULL)
                OR c.assignee_id = $2)
           AND ($3::text IS NULL OR c.project_id  = $3)
           AND ($4::text IS NULL OR c.title ILIKE '%' || $4 || '%'
                                OR  COALESCE(c.description, '') ILIKE '%' || $4 || '%')
           AND ($5::text IS NULL OR $6::text IS NULL
                OR ($5 = 'internal' AND     EXISTS (SELECT 1 FROM memberships cm
                                                    WHERE cm.user_redpash_id = c.reporter_id
                                                      AND cm.object_redpash_id = $6))
                OR ($5 = 'external' AND NOT EXISTS (SELECT 1 FROM memberships cm
                                                    WHERE cm.user_redpash_id = c.reporter_id
                                                      AND cm.object_redpash_id = $6)))
         ORDER BY {sort_col} {sort_dir} NULLS LAST
         LIMIT $7 OFFSET $8"
    ))
    .bind(status)
    .bind(assignee_id)
    .bind(project_id)
    .bind(q)
    .bind(source)
    .bind(internal_company_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

#[allow(clippy::too_many_arguments)]
pub async fn count_cases(
    pool:                &PgPool,
    status:              Option<&str>,
    assignee_id:         Option<&str>,
    project_id:          Option<&str>,
    q:                   Option<&str>,
    source:              Option<&str>,
    internal_company_id: Option<&str>,
) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::BIGINT FROM cases c
         WHERE ($1::text IS NULL OR c.status      = $1)
           AND ($2::text IS NULL
                OR ($2 = '__unassigned__' AND c.assignee_id IS NULL)
                OR c.assignee_id = $2)
           AND ($3::text IS NULL OR c.project_id  = $3)
           AND ($4::text IS NULL OR c.title ILIKE '%' || $4 || '%'
                                OR  COALESCE(c.description, '') ILIKE '%' || $4 || '%')
           AND ($5::text IS NULL OR $6::text IS NULL
                OR ($5 = 'internal' AND     EXISTS (SELECT 1 FROM memberships cm
                                                    WHERE cm.user_redpash_id = c.reporter_id
                                                      AND cm.object_redpash_id = $6))
                OR ($5 = 'external' AND NOT EXISTS (SELECT 1 FROM memberships cm
                                                    WHERE cm.user_redpash_id = c.reporter_id
                                                      AND cm.object_redpash_id = $6)))",
    )
    .bind(status)
    .bind(assignee_id)
    .bind(project_id)
    .bind(q)
    .bind(source)
    .bind(internal_company_id)
    .fetch_one(pool)
    .await?;
    Ok(n)
}

pub async fn find_case(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Case>> {
    let row: Option<CaseRow> = sqlx::query_as(&format!(
        "SELECT {CASE_SELECT} FROM cases c {CASE_USER_JOINS}
         WHERE c.redpash_id = $1"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// INSERT … RETURNING via a CTE so we can chain a LEFT JOIN against
/// `users` and produce the hydrated Case shape in one round-trip.
/// Same pattern as update_case below.
pub async fn insert_case(
    pool:          &PgPool,
    rid:           &str,
    title:         &str,
    description:   Option<&str>,
    type_:         &str,
    status:        &str,
    priority:      &str,
    reporter_id:   Option<&str>,
    assignee_id:   Option<&str>,
    project_id:    Option<&str>,
    company_id:    Option<&str>,
    error_message: Option<&str>,
    category_id:   Option<&str>,
) -> sqlx::Result<Case> {
    // Register the entity first, then insert the case — both in one tx so
    // the FK (cases.redpash_id -> entities.id) is satisfied atomically.
    let mut tx = pool.begin().await?;
    register_entity(&mut *tx, rid, "case").await?;
    let row: CaseRow = sqlx::query_as(&format!(
        "WITH c AS (
             INSERT INTO cases
                 (redpash_id, type, title, description, status, priority,
                  reporter_id, assignee_id, project_id, company_id,
                  error_message, category_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *
         )
         SELECT {CASE_SELECT} FROM c {CASE_USER_JOINS}"
    ))
    .bind(rid)
    .bind(type_)
    .bind(title)
    .bind(description)
    .bind(status)
    .bind(priority)
    .bind(reporter_id)
    .bind(assignee_id)
    .bind(project_id)
    .bind(company_id)
    .bind(error_message)
    .bind(category_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row.into())
}

/// Sparse update — `None` leaves the column untouched via COALESCE.
/// The handler emits one `case_<field>_change` event per changed
/// field so the activity feed renders each change as a discrete row.
pub async fn update_case(
    pool:          &PgPool,
    rid:           &str,
    title:         Option<&str>,
    description:   Option<&str>,
    type_:         Option<&str>,
    status:        Option<&str>,
    priority:      Option<&str>,
    assignee_id:   Option<&str>,
    project_id:    Option<&str>,
    company_id:    Option<&str>,
    error_message: Option<&str>,
    category_id:   Option<&str>,
) -> sqlx::Result<Option<Case>> {
    // For nullable FKs we use the sentinel pattern: pass `Some("")`
    // to set NULL, omit to skip. Today the handler always passes
    // Option<&str> with None=skip / Some(value)=set; clearing isn't
    // wired in v1 (defer until the UI needs an unassign button).
    let row: Option<CaseRow> = sqlx::query_as(&format!(
        "WITH c AS (
             UPDATE cases SET
                 title         = COALESCE($2,  title),
                 description   = COALESCE($3,  description),
                 type          = COALESCE($4,  type),
                 status        = COALESCE($5,  status),
                 priority      = COALESCE($6,  priority),
                 assignee_id   = COALESCE($7,  assignee_id),
                 project_id    = COALESCE($8,  project_id),
                 company_id    = COALESCE($9,  company_id),
                 error_message = COALESCE($10, error_message),
                 category_id   = COALESCE($11, category_id),
                 updated_at    = now()
             WHERE redpash_id = $1
             RETURNING *
         )
         SELECT {CASE_SELECT} FROM c {CASE_USER_JOINS}"
    ))
    .bind(rid)
    .bind(title)
    .bind(description)
    .bind(type_)
    .bind(status)
    .bind(priority)
    .bind(assignee_id)
    .bind(project_id)
    .bind(company_id)
    .bind(error_message)
    .bind(category_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Delete a case via the entity registry — cascades to the `cases` row,
/// then `comments` (and, from 1b, case memberships) cascade onward.
pub async fn delete_case(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    delete_entity(pool, rid).await
}

#[derive(FromRow)]
struct CommentRow {
    redpash_id:           String,
    case_id:              String,
    author_id:            Option<String>,
    author_display_name:  Option<String>,
    body:                 String,
    is_edited:            bool,
    created_at:           DateTime<Utc>,
    updated_at:           DateTime<Utc>,
}
impl From<CommentRow> for Comment {
    fn from(r: CommentRow) -> Self {
        Self {
            redpash_id:           r.redpash_id,
            case_id:              r.case_id,
            author_id:            r.author_id,
            author_display_name:  r.author_display_name,
            body:                 r.body,
            is_edited:            r.is_edited,
            created_at:           r.created_at,
            updated_at:           r.updated_at,
        }
    }
}

/// SELECT list for comment queries that hydrate the author's display
/// name via LEFT JOIN to users. Mirrors the CASE_SELECT shape.
/// `cm.` alias on the comments row, `u.` on the optional author user.
const COMMENT_SELECT: &str =
    "cm.redpash_id, cm.case_id, cm.author_id,
     u.display_name AS author_display_name,
     cm.body, cm.is_edited, cm.created_at, cm.updated_at";

const COMMENT_USER_JOIN: &str =
    "LEFT JOIN users u ON u.redpash_id = cm.author_id";

pub async fn list_comments_for_case(pool: &PgPool, case_id: &str) -> sqlx::Result<Vec<Comment>> {
    let rows: Vec<CommentRow> = sqlx::query_as(&format!(
        "SELECT {COMMENT_SELECT} FROM comments cm {COMMENT_USER_JOIN}
         WHERE cm.case_id = $1
         ORDER BY cm.created_at ASC"
    ))
    .bind(case_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn find_comment(pool: &PgPool, rid: &str) -> sqlx::Result<Option<Comment>> {
    let row: Option<CommentRow> = sqlx::query_as(&format!(
        "SELECT {COMMENT_SELECT} FROM comments cm {COMMENT_USER_JOIN}
         WHERE cm.redpash_id = $1"
    ))
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// INSERT … RETURNING via a CTE so we can chain the LEFT JOIN against
/// `users` and produce the hydrated Comment shape in one round-trip.
/// Same pattern as insert_case.
pub async fn insert_comment(
    pool:      &PgPool,
    rid:       &str,
    case_id:   &str,
    author_id: Option<&str>,
    body:      &str,
) -> sqlx::Result<Comment> {
    let row: CommentRow = sqlx::query_as(&format!(
        "WITH cm AS (
             INSERT INTO comments (redpash_id, case_id, author_id, body)
             VALUES ($1, $2, $3, $4)
             RETURNING *
         )
         SELECT {COMMENT_SELECT} FROM cm {COMMENT_USER_JOIN}"
    ))
    .bind(rid)
    .bind(case_id)
    .bind(author_id)
    .bind(body)
    .fetch_one(pool)
    .await?;
    Ok(row.into())
}

pub async fn update_comment(pool: &PgPool, rid: &str, body: &str) -> sqlx::Result<Option<Comment>> {
    let row: Option<CommentRow> = sqlx::query_as(&format!(
        "WITH cm AS (
             UPDATE comments
             SET body = $2, is_edited = true, updated_at = now()
             WHERE redpash_id = $1
             RETURNING *
         )
         SELECT {COMMENT_SELECT} FROM cm {COMMENT_USER_JOIN}"
    ))
    .bind(rid)
    .bind(body)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

pub async fn delete_comment(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM comments WHERE redpash_id = $1")
        .bind(rid)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Activity feed for a case — every `events` row tagged with the
/// case's rid via `context->>'case' = $1`. ASC so the operator reads
/// the timeline top-to-bottom (oldest first), matching the comment
/// thread + the slack/github convention.
///
/// No GIN index on events.context today — small table, full scan
/// acceptable. Add `CREATE INDEX … USING gin (context jsonb_path_ops)`
/// when the events table crosses ~100k rows.
pub async fn list_activity_for_case(pool: &PgPool, case_id: &str) -> sqlx::Result<Vec<Event>> {
    let rows: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events
         WHERE context->>'case' = $1
         ORDER BY occurred_at ASC"
    ))
    .bind(case_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// All categories visible to the caller. Today: every global
/// category (company_id IS NULL) — the v1 seeded taxonomy. v3 unions
/// in per-company categories once RBAC overlays per-user visibility;
/// the `for_user_rid` arg is reserved for that signature change but
/// ignored today (filters resolve to the same global set regardless).
///
/// Returned as a flat list ordered by (parent_id NULLS FIRST, name)
/// so roots surface first + children sort alphabetically within
/// their parent. The FE groups by parent_id to build the picker
/// tree; doing it server-side adds infra without saving FE work.
pub async fn list_categories(
    pool:          &PgPool,
    _for_user_rid: Option<&str>,
) -> sqlx::Result<Vec<Category>> {
    let rows = sqlx::query(
        "SELECT redpash_id, name, parent_id, company_id, created_at
           FROM case_categories
          WHERE company_id IS NULL
          ORDER BY parent_id NULLS FIRST, name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| Category {
        redpash_id: r.get("redpash_id"),
        name:       r.get("name"),
        parent_id:  r.try_get("parent_id").ok(),
        company_id: r.try_get("company_id").ok(),
        created_at: r.try_get("created_at").unwrap_or_else(|_| Utc::now()),
    }).collect())
}
