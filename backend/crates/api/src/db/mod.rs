//! Doc: docs/internal/code/backend/api/db/mod.md
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
mod connectors;
pub use entities::*;
pub use sessions::*;
pub use sentinels::*;
pub use users::*;
pub use projects::*;
pub use connectors::*;

use chrono::{DateTime, Utc};
use shared::case::Category;
use shared::chart::Chart;
use shared::company::Company;
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
         WHERE EXISTS (SELECT 1 FROM memberships om
                       WHERE om.object_redpash_id = p.redpash_id
                         AND om.member_redpash_id = $1 AND om.role = 'owner')
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

// list_charts (owner-only `{items}`) was removed in Lane 1 (admin-scope sweep):
// /api/charts is now served by the reach-aware paginated `admin::charts_page`
// (routes/charts.rs), so the caller sees charts shared with them, not just owned.

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
                om.member_redpash_id AS owner_id,
                u.display_name AS owner_display_name,
                u.username AS owner_username
         FROM project_files d
         JOIN projects p ON p.redpash_id = d.project_redpash_id
         JOIN LATERAL (SELECT m.member_redpash_id FROM memberships m
                       WHERE m.object_redpash_id = p.redpash_id AND m.role = 'owner'
                       ORDER BY m.joined_at LIMIT 1) om ON true
         JOIN users    u ON u.redpash_id = om.member_redpash_id
         WHERE d.file_type = 'dashboard' AND om.member_redpash_id = $1
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
    // Ownership is the owner-membership now (role='owner'), not a column.
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT member_redpash_id FROM memberships
         WHERE object_redpash_id = $1 AND role = 'owner'
         ORDER BY joined_at LIMIT 1",
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
        "SELECT m.member_redpash_id FROM project_files pf
         JOIN memberships m ON m.object_redpash_id = pf.project_redpash_id
                           AND m.role = 'owner'
         WHERE pf.redpash_id = $1 AND pf.file_type = 'dashboard'
         ORDER BY m.joined_at LIMIT 1",
    )
    .bind(rid)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(o,)| o))
}

pub async fn file_owner(pool: &PgPool, rid: &str) -> sqlx::Result<Option<String>> {
    // PROJECT-FILES-ACK: type=any — owner lookup by rid, type-agnostic
    // (charts + dashboards + csvs all share the same ownership chain
    // through the project's owner-membership). `dashboard_owner` is a
    // type-scoped variant used where the CRUD lane needs the
    // type-collision guard. (Chart writes are gated by the rbac resolver
    // now, so the old `chart_owner` variant was retired.)
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT m.member_redpash_id FROM project_files f
         JOIN memberships m ON m.object_redpash_id = f.project_redpash_id
                           AND m.role = 'owner'
         WHERE f.redpash_id = $1
         ORDER BY m.joined_at LIMIT 1",
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
// member_redpash_id)`, no redpash_id) and doubles as the access-control
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

/// The caller's *effective* role in a company, or `None` when they aren't a
/// member. Handlers treat `None` the same as "company doesn't exist" (404) so
/// existence isn't leaked.
///
/// The widened membership PK lets a user hold more than one row on a company
/// (a tier row + a labeled `context_role` row), so a plain `SELECT role …
/// fetch_optional` would error on >1 row. Aggregate to the highest tier
/// instead — that's the effective role, and it's always a single row.
/// (The cascade/team-aware multi-tenant resolver was removed in the lean
/// single-user slim, CAS_C8A9; this stays the direct company-tier lookup.)
pub async fn company_role(
    pool:        &PgPool,
    company_rid: &str,
    user_rid:    &str,
) -> sqlx::Result<Option<String>> {
    let (role,): (Option<String>,) = sqlx::query_as(
        "SELECT CASE max(CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
                                   WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
                  WHEN 4 THEN 'owner' WHEN 3 THEN 'admin'
                  WHEN 2 THEN 'member' WHEN 1 THEN 'viewer' END
         FROM memberships
         WHERE object_redpash_id = $1 AND member_redpash_id = $2",
    )
    .bind(company_rid)
    .bind(user_rid)
    .fetch_one(pool)
    .await?;
    Ok(role)
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
          WHERE a.member_redpash_id = $1
            AND b.member_redpash_id = $2
            AND a.object_redpash_id LIKE 'CMP\\_%'
          LIMIT 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}


/// List object rids where this user is the SOLE owner — used by the
/// scrub-retain user-delete flow (CAS_46BA67713EC84871991D3E7475598B47)
/// to BLOCK with a "transfer these first" payload instead of stranding
/// objects unowned. Empty Vec = safe to scrub.
///
/// `DISTINCT` against the post-2026-05-31 widened memberships PK
/// (object, member_redpash_id, role, context_role) — a user can hold
/// multiple 'owner' rows on the same object (different context_role),
/// and the blocker should fire once per object regardless.
pub async fn user_sole_owner_objects(
    pool: &PgPool,
    user_rid: &str,
) -> sqlx::Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT m1.object_redpash_id
         FROM memberships m1
         WHERE m1.member_redpash_id = $1
           AND m1.role = 'owner'
           AND NOT EXISTS (
             SELECT 1 FROM memberships m2
             WHERE m2.object_redpash_id = m1.object_redpash_id
               AND m2.member_redpash_id != $1
               AND m2.role = 'owner'
           )",
    )
    .bind(user_rid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(rid,)| rid).collect())
}

/// Delete a company via the entity registry — cascades to the `companies`
/// row, then onward: `memberships` cascade (object = the company),
/// `projects.company_id` is `SET NULL` so company projects survive as personal.
pub async fn delete_company(pool: &PgPool, rid: &str) -> sqlx::Result<bool> {
    delete_entity(pool, rid).await
}

// ─── teams ──────────────────────────────────────────────────────
//
// A team is a company-scoped subgroup. Same polymorphic membership
// model as companies (the edge keys on the team's redpash_id), and
// the same routes/members.rs shared CRUD layer is mounted under
// `/api/teams/:rid/members`. Schema: `teams (redpash_id, company_id,
// name, created_at)` — no slug, no avatar, no updated_at (pre-staged
// in 20260529000000 init.sql; the team-CRUD slice ships first cut).








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
          WHERE object_redpash_id = $1 AND member_redpash_id = $2",
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
    pool:         &PgPool,
    scope:        &str,
    scope_id:     &str,
    user_id:      &str,
    role:         &str,
    context_role: Option<&str>,
) -> sqlx::Result<()> {
    let _ = scope;
    // `context_role` is NOT NULL with DB default ''; sqlx sends Rust
    // None as a SQL NULL (bypassing the default) → constraint trip.
    // Normalize here so callers can pass None to mean "no specific
    // context role" without each route having to coalesce.
    let context_role = context_role.unwrap_or("");
    sqlx::query(
        "INSERT INTO memberships (object_redpash_id, member_redpash_id, role, context_role)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(scope_id)
    .bind(user_id)
    .bind(role)
    .bind(context_role)
    .execute(pool)
    .await?;
    Ok(())
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
///
/// `viewer` is the tenant-isolation scope (CAS_AF2690C0 / leak 2/5): `Some(caller)`
/// restricts the feed to events whose user shares a COMPANY with the caller — the
/// caller's own events + system events (NULL user) always pass — mirroring
/// `users_share_company` (the same CMP_-membership gate `get_one` uses). `None` =
/// platform-admin: the full cross-tenant monitoring feed, unscoped.
pub async fn list_events(
    pool:   &PgPool,
    level:  Option<&str>,
    kind:   Option<&str>,
    limit:  i64,
    viewer: Option<&str>,
) -> sqlx::Result<Vec<Event>> {
    let rows: Vec<EventRow> = sqlx::query_as(&format!(
        "SELECT {EVENT_COLS} FROM events e
         WHERE ($1::text IS NULL OR e.level = $1)
           AND ($2::text IS NULL OR e.kind  = $2)
           AND ($4::text IS NULL
                OR e.user_redpash_id IS NULL
                OR e.user_redpash_id = $4
                OR EXISTS (SELECT 1 FROM memberships ma
                             JOIN memberships mb ON mb.object_redpash_id = ma.object_redpash_id
                            WHERE ma.member_redpash_id = $4
                              AND mb.member_redpash_id = e.user_redpash_id
                              AND ma.object_redpash_id LIKE 'CMP\\_%'))
         ORDER BY e.occurred_at DESC
         LIMIT $3"
    ))
    .bind(level)
    .bind(kind)
    .bind(limit)
    .bind(viewer)
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
